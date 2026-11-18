import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  applyStatusPresentation, browseRemoteFiles, buildPiWebStatusSnapshot, compactRemotePath,
  inspectRemoteGit, isPiWebHost, normalizeWorkspaceRelPath, openRemoteFileEditor,
  parseGitShortStatus, PI_WEB_SESSION_LIVENESS_KEY, PiWebLivenessLease, type PiWebLivenessProvider,
} from "../src/pi-web.js";
import { sshFixture } from "./ssh-fixture.js";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

test("pi-web status shelf protocol, command button ordering, path compaction and liveness registry", async t => {
  assert.equal(compactRemotePath("/home/dev/projects/app", "/home/dev"), "~/projects/app");
  assert.equal(compactRemotePath("/home/dev", "/home/dev"), "~");
  assert.equal(normalizeWorkspaceRelPath("/srv/app/src/index.ts", "/srv/app"), "src/index.ts");
  assert.throws(() => normalizeWorkspaceRelPath("../../etc/passwd", "/srv/app"), /超出远程工作区根目录/);

  // Local unbound state in pi-web shows clickable `command:/remote` button (`SSH: 本地`)
  const localSnap = buildPiWebStatusSnapshot({ mode: "local" });
  assert.equal(localSnap.statuses["command:/remote"], "SSH: 本地");
  assert.equal(localSnap.statuses["command:/remote files"], undefined);
  assert.equal(localSnap.statuses["pi-remote"], undefined);
  assert.equal(localSnap.widget, undefined);

  // Bound state exposes ordered native command buttons + 4-line collapsible ANSI widget
  const boundSnap = buildPiWebStatusSnapshot({
    mode: "remote",
    binding: {
      workspace: { id: "prod-api", name: "Prod API", host: "prod", path: "/home/alice/srv/api" },
      probe: { root: "/home/alice/srv/api", home: "/home/alice", hostname: "prod-01", python: "3.12.2", git: true, ripgrep: true },
    },
  });
  const activeCommandKeys = Object.entries(boundSnap.statuses)
    .filter(([, text]) => text !== undefined)
    .map(([key]) => key)
    .sort((a, b) => a.localeCompare(b));
  assert.deepEqual(activeCommandKeys, [
    "command:/remote",
    "command:/remote files",
    "command:/remote git",
    "command:/remote test",
    "command:/remote unbind",
  ]);
  assert.equal(boundSnap.statuses["command:/remote"], "● SSH prod · ~/srv/api");
  assert.equal(boundSnap.widget?.length, 4, "4-line widget stays collapsed by default in pi-web shelf");

  // Blocked state exposes warning + one-click unbind recovery
  const blockedSnap = buildPiWebStatusSnapshot({ mode: "blocked", error: "Connection timed out" });
  assert.match(blockedSnap.statuses["command:/remote"]!, /⚠ SSH 不可用/);
  assert.equal(blockedSnap.statuses["command:/remote unbind"], "切回本地");
  assert.equal(blockedSnap.statuses["command:/remote files"], undefined);

  // Verify TUI vs pi-web presentation isolation
  const tuiStatuses = new Map<string, string | undefined>();
  applyStatusPresentation(
    {
      setStatus: (k, v) => { if (v === undefined) tuiStatuses.delete(k); else tuiStatuses.set(k, v); },
      setWidget: () => {},
    },
    { mode: "local" },
    { nativeMode: true, piWeb: false },
  );
  assert.equal(tuiStatuses.size, 0, "CLI TUI remains completely silent when unbound");

  // Official `@agegr/pi-web/session-liveness/v1` global contract test
  const symbol = Symbol.for(PI_WEB_SESSION_LIVENESS_KEY);
  const store = globalThis as Record<PropertyKey, unknown>;
  const prevRegistry = store[symbol];
  const providers = new Map<symbol, PiWebLivenessProvider>();
  store[symbol] = {
    version: 1 as const,
    register(provider: PiWebLivenessProvider) {
      assert.ok(provider.name.length > 0);
      assert.ok(provider.sessionId.length > 0);
      if ("sessionFile" in provider) assert.ok(typeof provider.sessionFile === "string" && provider.sessionFile.length > 0);
      const token = Symbol(provider.name);
      providers.set(token, provider);
      return () => { providers.delete(token); };
    },
  };
  t.after(() => {
    if (prevRegistry === undefined) delete store[symbol];
    else store[symbol] = prevRegistry;
  });

  assert.equal(isPiWebHost(), true);
  let active = false;
  const lease = new PiWebLivenessLease("pi-remote", () => active);
  lease.sync({
    sessionManager: {
      getSessionId: () => "sess-1",
      getSessionFile: () => "",
    } as any,
  });
  assert.equal(providers.size, 1);
  const registered = [...providers.values()][0]!;
  assert.equal("sessionFile" in registered, false, "empty sessionFile must be omitted per pi-web contract");
  assert.equal(registered.isActive(), false);
  active = true;
  assert.equal(registered.isActive(), true);
  lease.dispose();
  assert.equal(providers.size, 0);
});

test("pi-web native modal workflows: remote file browser, inline editor, etag conflict, git status/diff and /remote edit", { timeout: 60_000 }, async t => {
  const fixture = await sshFixture(t);
  await mkdir(join(fixture.root, "src"), { recursive: true });
  await writeFile(join(fixture.root, "src/app.ts"), "export const value = 1;\n", "utf8");

  // Initialize git repo inside SSH fixture root to test native Git modal workflow
  await execFileAsync("git", ["init", "-b", "main"], { cwd: fixture.root });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: fixture.root });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: fixture.root });
  await execFileAsync("git", ["add", "."], { cwd: fixture.root });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: fixture.root });
  await writeFile(join(fixture.root, "src/app.ts"), "export const value = 2;\n", "utf8");

  const parsed = parseGitShortStatus("## main\n M src/app.ts\nR  old.ts -> src/new.ts\n");
  assert.equal(parsed.branch, "main");
  assert.deepEqual(parsed.changes.map(c => ({ code: c.code, path: c.path })), [
    { code: "M", path: "src/app.ts" },
    { code: "R", path: "src/new.ts" },
  ]);

  const notices: string[] = [];
  // 1. Browse into `src/`, open `app.ts` in native editor modal, modify & save over SSH
  const selectQueue = ["📁 src/", "📄 app.ts", undefined];
  let editorCalls = 0;
  await browseRemoteFiles(
    fixture.client,
    fixture.root,
    false,
    {
      select: async (_title, options) => {
        const next = selectQueue.shift();
        if (next) assert.ok(options.includes(next), `Expected ${next} in ${JSON.stringify(options)}`);
        return next;
      },
      input: async () => undefined,
      editor: async (_title, prefill) => {
        editorCalls += 1;
        assert.equal(prefill, "export const value = 2;\n");
        return "export const value = 42;\n";
      },
      confirm: async () => false,
      notify: msg => notices.push(msg),
    },
  );
  assert.equal(editorCalls, 1);
  assert.equal(await readFile(join(fixture.root, "src/app.ts"), "utf8"), "export const value = 42;\n");
  assert.ok(notices.some(n => n.includes("已保存远程文件：src/app.ts")));

  // 2. Optimistic concurrency conflict prompts confirm before overwriting
  let conflictAsked = false;
  await openRemoteFileEditor(
    fixture.client,
    "src/app.ts",
    {
      editor: async () => {
        // Simulate concurrent external change while user is editing in modal
        await writeFile(join(fixture.root, "src/app.ts"), "export const value = 999;\n", "utf8");
        return "export const value = 777;\n";
      },
      confirm: async () => {
        conflictAsked = true;
        return false;
      },
      notify: msg => notices.push(msg),
    },
  );
  assert.equal(conflictAsked, true);
  assert.equal(await readFile(join(fixture.root, "src/app.ts"), "utf8"), "export const value = 999;\n");

  // 3. Native Git status & per-file diff modal
  const gitSelects = ["📝 [M] src/app.ts", "📄 查看文件 Diff (src/app.ts)", undefined];
  let capturedDiff = "";
  await inspectRemoteGit(
    fixture.client,
    fixture.root,
    {
      select: async (_title, options) => {
        const next = gitSelects.shift();
        if (next) assert.ok(options.includes(next), `Expected ${next} in ${JSON.stringify(options)}`);
        return next;
      },
      editor: async (_title, prefill) => {
        capturedDiff = prefill ?? "";
        return undefined;
      },
      confirm: async () => false,
      notify: msg => notices.push(msg),
    },
  );
  assert.match(capturedDiff, /-export const value = 1;/);
  assert.match(capturedDiff, /\+export const value = 999;/);

  // 4. Full extension integration in simulated pi-web host: status buttons, /remote edit & /remote unbind
  const symbol = Symbol.for(PI_WEB_SESSION_LIVENESS_KEY);
  const g = globalThis as Record<PropertyKey, unknown>;
  const prevReg = g[symbol];
  g[symbol] = { version: 1, register: () => () => {} };
  const oldConfig = process.env.PI_REMOTE_CONFIG;
  process.env.PI_REMOTE_CONFIG = fixture.store.file;
  t.after(() => {
    if (prevReg === undefined) delete g[symbol]; else g[symbol] = prevReg;
    if (oldConfig === undefined) delete process.env.PI_REMOTE_CONFIG; else process.env.PI_REMOTE_CONFIG = oldConfig;
  });

  const liveStatuses = new Map<string, string>();
  const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "write", "edit", "bash", "grep", "find", "ls"] });
  const loader = new DefaultResourceLoader({
    cwd: fixture.root,
    agentDir: join(fixture.root, "agent"),
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [join(process.cwd(), "src/extension.ts")],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: fixture.root,
    agentDir: join(fixture.root, "agent"),
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(fixture.root),
  });
  const editInputs = ["", "", "Renamed SSH Workspace"];
  await session.bindExtensions({
    mode: "rpc",
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      notify: message => notices.push(message),
      setStatus: (key, text) => {
        if (text === undefined) liveStatuses.delete(key);
        else liveStatuses.set(key, text);
      },
      setWidget: () => {},
      input: async () => editInputs.shift(),
    },
  });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });

  // Unbound session immediately shows clickable `SSH: 本地` button in pi-web
  assert.equal(liveStatuses.get("command:/remote"), "SSH: 本地");

  await session.prompt("/remote use test");
  assert.match(liveStatuses.get("command:/remote")!, /^● SSH fixture · /);
  assert.equal(liveStatuses.get("command:/remote files"), "远程文件");
  assert.equal(liveStatuses.get("command:/remote git"), "Git 状态");
  assert.equal(liveStatuses.get("command:/remote test"), "探测连接");
  assert.equal(liveStatuses.get("command:/remote unbind"), "切回本地");

  await session.prompt("/remote edit test");
  assert.equal((await fixture.store.read()).workspaces[0]!.name, "Renamed SSH Workspace");

  await session.prompt("/remote unbind");
  assert.equal(liveStatuses.get("command:/remote"), "SSH: 本地");
  assert.equal(liveStatuses.has("command:/remote files"), false);
});
