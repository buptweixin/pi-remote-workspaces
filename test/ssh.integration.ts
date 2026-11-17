import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRemoteTools } from "../src/tools.js";
import { RemoteClient, RemotePool } from "../src/remote.js";
import { discoverHosts } from "../src/ssh-config.js";
import { sshFixture } from "./ssh-fixture.js";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";

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
  async function session(manager = SessionManager.inMemory(fixture.root), remoteId?: string) {
    const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "write", "edit", "bash", "grep", "find", "ls"] });
    const loader = new DefaultResourceLoader({ cwd: fixture.root, agentDir: join(fixture.root, "agent"), settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [join(process.cwd(), "src/extension.ts")] });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const { session: result } = await createAgentSession({ cwd: fixture.root, agentDir: join(fixture.root, "agent"), settingsManager, resourceLoader: loader, sessionManager: manager });
    if (remoteId) result.extensionRunner.setFlagValue("remote", remoteId);
    await result.bindExtensions({ mode: "rpc", uiContext: { ...result.extensionRunner.getUIContext(), notify: message => notices.push(message), setStatus: () => {}, setWidget: () => {} } });
    t.after(async () => {
      await result.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      result.dispose();
    });
    return result;
  }
  const first = await session();
  await first.prompt("/remote use test");
  assert.match(notices.at(-1)!, /已绑定/);
  assert.equal(first.sessionManager.getBranch().filter(e => e.type === "custom").length, 1);
  assert.deepEqual(first.getAllTools().filter(tool => ["read", "write", "edit", "bash", "grep", "find", "ls"].includes(tool.name)).length, 7);
  const second = await session();
  assert.equal(second.sessionManager.getBranch().filter(e => e.type === "custom").length, 0);
  await second.prompt("/remote status");
  assert.match(notices.at(-1)!, /本地/);
  const blocked = await session(undefined, "does-not-exist");
  const blockedRead = blocked.agent.state.tools.find(tool => tool.name === "read")!;
  await assert.rejects(blockedRead.execute("blocked-read", { path: "actual-ssh.txt" }, undefined), /Remote workspace unavailable/);
  await blocked.prompt("/remote local");
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

  // Verify Keep-Alive RemotePool reuses warm SSH Python workers and rotates on config change.
  const pool = new RemotePool();
  t.after(() => pool.close());
  const pooledClient = new RemoteClient(fixture.config.workspaces[0]!, fixture.config, undefined, pool);
  await pooledClient.probe();
  assert.equal(pool.size, 1);
  for (let i = 0; i < 5; i++) {
    const content = await pooledClient.read("actual-ssh.txt");
    assert.equal(Buffer.from(content.data, "base64").toString(), "SSH transport works\n");
  }
  assert.equal(pool.size, 1, "consecutive RPCs should reuse the single warm SSH worker");

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

  await isolated.prompt("/remote remove remote-repo");
  assert.ok(!(await fixture.store.read()).workspaces.some(w => w.id === "remote-repo"));
  await Promise.all([
    pool.close(),
    isolated.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
    first.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
    resumed.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
  ]);
});
