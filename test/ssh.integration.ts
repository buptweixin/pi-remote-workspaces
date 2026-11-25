import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { anchorRootDir, ensureWorkspaceAnchor, workspaceAnchorDir } from "../src/anchors.js";
import { createRemoteTools } from "../src/tools.js";
import { RemoteClient, RemotePool } from "../src/remote.js";
import { discoverHosts } from "../src/ssh-config.js";
import { sshFixture } from "./ssh-fixture.js";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionToolContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";

test("real OpenSSH transport, actual SDK loading, session binding and isolation", { timeout: 60_000 }, async t => {
  const fixture = await sshFixture(t);
  assert.deepEqual((await discoverHosts(fixture.config)).hosts.map(h => h.alias), ["fixture"]);
  const probe = await fixture.client.probe();
  const tools = createRemoteTools(fixture.client, probe);
  const ctx = { cwd: "/this-is-local-and-must-never-be-used" } as ExtensionToolContext;
  await tools.write!.execute("w", { path: "actual-ssh.txt", content: "SSH transport works\n" }, undefined, undefined, ctx);
  const read = await tools.read!.execute("r", { path: "actual-ssh.txt" }, undefined, undefined, ctx);
  assert.match(JSON.stringify(read), /SSH transport works/);
  assert.equal(await readFile(join(fixture.root, "actual-ssh.txt"), "utf8"), "SSH transport works\n");
  const oldConfig = process.env.PI_REMOTE_CONFIG;
  process.env.PI_REMOTE_CONFIG = fixture.store.file;
  t.after(() => { if (oldConfig === undefined) delete process.env.PI_REMOTE_CONFIG; else process.env.PI_REMOTE_CONFIG = oldConfig; });
  const notices: string[] = [];
  interface SessionHandle {
    session: Awaited<ReturnType<typeof createAgentSession>>["session"];
    statuses: Map<string, string | undefined>;
    widgets: Map<string, unknown>;
  }
  async function openSession(options: {
    manager?: SessionManager;
    remoteId?: string;
    cwd?: string;
    ui?: Partial<ExtensionUIContext> | null;
  } = {}): Promise<SessionHandle> {
    const cwd = options.cwd ?? fixture.root;
    const manager = options.manager ?? SessionManager.inMemory(cwd);
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "write", "edit", "bash", "grep", "find", "ls"] });
    const loader = new DefaultResourceLoader({ cwd, agentDir: join(fixture.root, "agent"), settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [join(process.cwd(), "src/extension.ts")] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session: result } = await createAgentSession({ cwd, agentDir: join(fixture.root, "agent"), settingsManager, resourceLoader: loader, sessionManager: manager });
    if (options.remoteId) result.extensionRunner.setFlagValue("remote", options.remoteId);
    const statuses = new Map<string, string | undefined>();
    const widgets = new Map<string, unknown>();
    if (options.ui === null) {
      await result.bindExtensions({});
    } else {
      await result.bindExtensions({
        mode: "rpc",
        uiContext: {
          ...result.extensionRunner.getUIContext(),
          notify: message => notices.push(message),
          setStatus: (key, text) => { statuses.set(key, text); },
          setWidget: (key, content) => { widgets.set(key, content); },
          ...options.ui,
        },
      });
    }
    t.after(async () => {
      await result.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      result.dispose();
    });
    return { session: result, statuses, widgets };
  }
  async function session(manager = SessionManager.inMemory(fixture.root), remoteId?: string) {
    return (await openSession({ manager, remoteId })).session;
  }
  const firstHandle = await openSession();
  const first = firstHandle.session;
  assert.equal(firstHandle.statuses.get("pi-remote"), undefined);
  await first.prompt("/remote use test");
  assert.match(notices.at(-1)!, /已绑定/);
  assert.match(firstHandle.statuses.get("pi-remote")!, /^SSH fixture · /);
  await first.prompt("/remote anchors");
  assert.match(notices.at(-1)!, /锚点目录已同步/);
  assert.equal(first.sessionManager.getBranch().filter(e => e.type === "custom").length, 1);
  assert.deepEqual(first.getAllTools().filter(tool => ["read", "write", "edit", "bash", "grep", "find", "ls"].includes(tool.name)).length, 7);
  const second = await session();
  assert.equal(second.sessionManager.getBranch().filter(e => e.type === "custom").length, 0);
  await second.prompt("/remote status");
  assert.match(notices.at(-1)!, /本地/);
  const blockedHandle = await openSession({ remoteId: "does-not-exist" });
  const blocked = blockedHandle.session;
  assert.match(blockedHandle.statuses.get("pi-remote")!, /^SSH blocked:/);
  const blockedRead = blocked.agent.state.tools.find(tool => tool.name === "read")!;
  await assert.rejects(blockedRead.execute("blocked-read", { path: "actual-ssh.txt" }, undefined), /Remote workspace unavailable/);
  await blocked.prompt("/remote local");
  assert.equal(blockedHandle.statuses.get("pi-remote"), undefined);
  const localRead = await blockedRead.execute("explicit-local", { path: "actual-ssh.txt" }, undefined);
  assert.match(JSON.stringify(localRead), /SSH transport works/);
  await first.prompt("/remote status");
  assert.match(notices.at(-1)!, /Python/);
  const remoteRead = first.agent.state.tools.find(tool => tool.name === "read")!;
  await fixture.store.update(config => ({ ...config, sshConfigPath: join(fixture.root, "missing-ssh-config") }));
  // The same file exists locally: a fallback would succeed, which must never happen.
  await assert.rejects(remoteRead.execute("connection-failure", { path: "actual-ssh.txt" }, undefined), /SSH/);
  await fixture.store.update(() => fixture.config);
  // Resume from the saved custom entry, rather than from global mutable state.
  const resumed = await session(first.sessionManager);
  await resumed.prompt("/remote status");
  assert.match(notices.at(-1)!, /Python/);
  await resumed.prompt("/remote local");
  await resumed.prompt("/remote status");
  assert.match(notices.at(-1)!, /本地/);

  // Verify Keep-Alive RemotePool reuses warm SSH Python workers, caps concurrency under burst load, and rotates on config change.
  const pool = new RemotePool({ maxConcurrentPerKey: 2, maxIdlePerKey: 2 });
  t.after(() => pool.close());
  const pooledClient = new RemoteClient(fixture.config.workspaces[0]!, fixture.config, undefined, pool);
  await pooledClient.probe();
  assert.equal(pool.size, 1);
  for (let i = 0; i < 5; i++) {
    const content = await pooledClient.read("actual-ssh.txt");
    assert.equal(Buffer.from(content.data, "base64").toString(), "SSH transport works\n");
  }
  assert.equal(pool.size, 1, "consecutive RPCs should reuse the single warm SSH worker");

  // Pooled bash reuses the same warm SSH worker with zero extra SSH handshakes and streams stdout/stderr.
  const streamedBashChunks: string[] = [];
  const pooledBash = await pooledClient.bash("printf 'out-1\\n'; printf 'err-1\\n' >&2", fixture.root, {
    onData: chunk => streamedBashChunks.push(chunk.toString("utf8")),
  });
  assert.equal(pooledBash.exitCode, 0);
  assert.equal(pooledBash.stdout.toString("utf8"), "out-1\n");
  assert.equal(pooledBash.stderr.toString("utf8"), "err-1\n");
  assert.match(streamedBashChunks.join(""), /out-1/);
  assert.match(streamedBashChunks.join(""), /err-1/);
  assert.equal(pool.size, 1, "pooled bash should reuse the existing warm SSH worker");

  const burstResults = await Promise.all(
    Array.from({ length: 8 }, () => pooledClient.read("actual-ssh.txt")),
  );
  assert.equal(burstResults.length, 8);
  assert.ok(pool.size <= 2, `Expected pool size <= 2 under 8-way parallel burst, got ${pool.size}`);

  // Verify remote AGENTS.md replaces unrelated local AGENTS.md in system prompt and /remote completions work.
  const localDir = join(fixture.root, "local-cwd"), remoteDir = join(fixture.root, "remote-repo");
  await mkdir(localDir, { recursive: true });
  await mkdir(remoteDir, { recursive: true });
  await writeFile(join(localDir, "AGENTS.md"), "LOCAL_ONLY_SECRET_CONTEXT");
  await writeFile(join(remoteDir, "AGENTS.md"), "REMOTE_PROJECT_INSTRUCTIONS");
  await fixture.store.update(current => ({
    ...current,
    workspaces: [...current.workspaces, { id: "remote-repo", name: "Remote Repo", host: "fixture", path: remoteDir }],
  }));
  const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "write", "edit", "bash", "grep", "find", "ls"] });
  const loader = new DefaultResourceLoader({ cwd: localDir, agentDir: join(fixture.root, "agent"), settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [join(process.cwd(), "src/extension.ts")] });
  await loader.reload();
  const { session: isolated } = await createAgentSession({ cwd: localDir, agentDir: join(fixture.root, "agent"), settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(localDir) });
  await isolated.bindExtensions({ mode: "rpc", uiContext: { ...isolated.extensionRunner.getUIContext(), notify: message => notices.push(message), setStatus: () => {}, setWidget: () => {} } });
  t.after(() => isolated.dispose());

  const remoteCmd = isolated.extensionRunner.getCommand("remote")!;
  const completions = await remoteCmd.getArgumentCompletions!("use rem");
  assert.ok(completions?.some(item => item.value === "use remote-repo"));

  await isolated.prompt("/remote use remote-repo");
  const built = await isolated.extensionRunner.emitBeforeAgentStart(
    { type: "before_agent_start", messageType: "user", prompt: "inspect" } as any,
    isolated.extensionRunner.createCommandContext().getSystemPromptOptions(),
  );
  assert.equal(built.systemPromptOptions.cwd, remoteDir);
  assert.ok(built.systemPromptOptions.contextFiles.some(f => f.content.includes("REMOTE_PROJECT_INSTRUCTIONS")));
  assert.ok(!built.systemPromptOptions.contextFiles.some(f => f.content.includes("LOCAL_ONLY_SECRET_CONTEXT")));

  // Editing remote AGENTS.md via remote write tool automatically invalidates remoteContextCache for the next turn.
  const isolatedWrite = isolated.agent.state.tools.find(tool => tool.name === "write")!;
  await isolatedWrite.execute("w-agents", { path: "AGENTS.md", content: "UPDATED_REMOTE_AGENTS_V2\n" }, undefined);
  const builtAfterUpdate = await isolated.extensionRunner.emitBeforeAgentStart(
    { type: "before_agent_start", messageType: "user", prompt: "inspect again" } as any,
    isolated.extensionRunner.createCommandContext().getSystemPromptOptions(),
  );
  assert.ok(builtAfterUpdate.systemPromptOptions.contextFiles.some(f => f.content.includes("UPDATED_REMOTE_AGENTS_V2")));

  await isolated.prompt("/remote remove remote-repo");
  assert.ok(!(await fixture.store.read()).workspaces.some(w => w.id === "remote-repo"));

  // Per-workspace anchor auto-bind, saved local override on resume, unknown anchor, and shared picker root flows.
  const testAnchor = await ensureWorkspaceAnchor("test", fixture.config, fixture.store.file);
  assert.equal(testAnchor, workspaceAnchorDir("test", fixture.config, fixture.store.file));
  const anchored = await openSession({ cwd: testAnchor });
  assert.match(anchored.statuses.get("pi-remote")!, /^SSH fixture · /);
  assert.equal(anchored.session.sessionManager.getBranch().filter(e => e.type === "custom").length, 1);
  const anchoredRead = anchored.session.agent.state.tools.find(tool => tool.name === "read")!;
  assert.match(JSON.stringify(await anchoredRead.execute("anchor-read", { path: "actual-ssh.txt" }, undefined)), /SSH transport works/);

  await anchored.session.prompt("/remote local");
  assert.equal(anchored.statuses.get("pi-remote"), undefined);
  const anchoredResumed = await openSession({ manager: anchored.session.sessionManager, cwd: testAnchor });
  assert.equal(anchoredResumed.statuses.get("pi-remote"), undefined);
  await anchoredResumed.session.prompt("/remote status");
  assert.match(notices.at(-1)!, /本地/);

  const pickerRoot = anchorRootDir(fixture.config, fixture.store.file);
  const unknownAnchor = join(pickerRoot, "deleted-ws");
  await mkdir(unknownAnchor, { recursive: true });
  const unknownSession = await openSession({ cwd: unknownAnchor });
  assert.match(unknownSession.statuses.get("pi-remote")!, /^SSH blocked:/);
  const unknownRead = unknownSession.session.agent.state.tools.find(tool => tool.name === "read")!;
  await assert.rejects(unknownRead.execute("unknown-anchor-read", { path: "actual-ssh.txt" }, undefined), /Remote workspace unavailable/);

  const pickerSelected = await openSession({
    cwd: pickerRoot,
    ui: { select: async (_title, opts) => opts.find(opt => opt.includes("[test]")) },
  });
  assert.match(pickerSelected.statuses.get("pi-remote")!, /^SSH fixture · /);

  const pickerCancelled = await openSession({
    cwd: pickerRoot,
    ui: { select: async () => undefined },
  });
  assert.match(pickerCancelled.statuses.get("pi-remote")!, /^SSH blocked:/);
  assert.equal(pickerCancelled.session.sessionManager.getBranch().filter(e => e.type === "custom").length, 0);
  const cancelledRead = pickerCancelled.session.agent.state.tools.find(tool => tool.name === "read")!;
  await assert.rejects(cancelledRead.execute("picker-cancel-read", { path: "actual-ssh.txt" }, undefined), /Remote workspace unavailable/);
  await pickerCancelled.session.prompt("/remote use test");
  assert.match(pickerCancelled.statuses.get("pi-remote")!, /^SSH fixture · /);

  const pickerLocal = await openSession({
    cwd: pickerRoot,
    ui: { select: async () => "🔌 暂不绑定（仅本地）" },
  });
  assert.equal(pickerLocal.statuses.get("pi-remote"), undefined);
  assert.equal(pickerLocal.session.sessionManager.getBranch().filter(e => e.type === "custom").length, 1);

  const pickerHeadless = await openSession({ cwd: pickerRoot, ui: null });
  const headlessRead = pickerHeadless.session.agent.state.tools.find(tool => tool.name === "read")!;
  await assert.rejects(headlessRead.execute("picker-headless-read", { path: "actual-ssh.txt" }, undefined), /Remote workspace unavailable/);

  await Promise.all([
    pool.close(),
    isolated.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
    first.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
    resumed.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
  ]);
});
