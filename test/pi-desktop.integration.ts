import assert from "node:assert/strict";
import test from "node:test";
import { cp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPiDesktopPlugin } from "../scripts/build-pi-desktop.mjs";
import { createPiDesktopPlugin } from "../src/pi-desktop-main.js";
import { REMOTE_DESKTOP_TOOL_NAMES } from "../src/tools.js";
import { sshFixture } from "./ssh-fixture.js";

const CORE_DESKTOP_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "BrowserPreview", "TodoWrite", "asktool"];

async function findRealPiDesktopRunner(): Promise<string | undefined> {
  const appRoot = process.env.PI_REMOTE_PI_DESKTOP_APP || "/Applications/PI-Desktop.app";
  const chunksDir = join(appRoot, "Contents/Resources/agent-runtime/chunks");
  try {
    if (!(await stat(chunksDir)).isDirectory()) return undefined;
    const files = await readdir(chunksDir);
    const runnerFile = files.find(name => /^runner-.*\.js$/.test(name));
    return runnerFile ? join(chunksDir, runnerFile) : undefined;
  } catch {
    return undefined;
  }
}

interface BridgeHarness {
  notices: Array<{ message: string; level: string }>;
  statuses: Map<string, string | undefined>;
  activeDeferred: Set<string>;
  bridge: Record<string, any>;
}

function createDesktopBridgeHarness(sessionId: string, cwd: string): BridgeHarness {
  const notices: Array<{ message: string; level: string }> = [];
  const statuses = new Map<string, string | undefined>();
  const activeDeferred = new Set<string>();

  const bridge = {
    sessionId,
    cwd,
    remoteWorkspace: false,
    getModel: () => ({ provider: "test", id: "test-model", input: ["text"] }),
    setModel: async () => true,
    modelRegistry: {},
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => {},
    isIdle: () => true,
    abort: () => {},
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 100, contextWindow: 128_000, percent: 0 }),
    compact: () => {},
    getSystemPrompt: () => "BASE_DESKTOP_SYSTEM_PROMPT",
    getActiveTools: () => [...CORE_DESKTOP_TOOLS, ...activeDeferred],
    getAllTools: () => [...CORE_DESKTOP_TOOLS, ...REMOTE_DESKTOP_TOOL_NAMES].map(name => ({
      name,
      description: name,
      active: CORE_DESKTOP_TOOLS.includes(name) || activeDeferred.has(name),
    })),
    setActiveTools: (names: string[]) => {
      const requested = new Set(names);
      activeDeferred.clear();
      for (const name of REMOTE_DESKTOP_TOOL_NAMES) {
        if (requested.has(name)) activeDeferred.add(name);
      }
    },
    getSessionName: () => "Desktop Session",
    setSessionName: async () => {},
    sendUserMessage: async () => {},
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    requestUi: async (_spec: unknown, request: Record<string, any>) => {
      if (request.kind === "notify") {
        notices.push({ message: request.message, level: request.level });
        return { kind: "notify" };
      }
      if (request.kind === "setStatus") {
        statuses.set(request.key, request.text);
        return { kind: "setStatus" };
      }
      if (request.kind === "confirm") return { kind: "confirm", value: true };
      if (request.kind === "select") return { kind: "select", value: request.options?.[0] };
      if (request.kind === "input") return { kind: "input", value: undefined };
      return {};
    },
    publishCommands: () => {},
    publishDiagnostics: () => {},
  };

  return { notices, statuses, activeDeferred, bridge };
}

test("PI-Desktop TrustedExtensionRunner integration with real OpenSSH, dual-end tools and work-panel sync", { timeout: 60_000 }, async t => {
  const realRunnerPath = await findRealPiDesktopRunner();
  if (!realRunnerPath) {
    t.skip("PI-Desktop.app not installed at /Applications/PI-Desktop.app; skipping native sidecar runner integration");
    return;
  }

  const fixture = await sshFixture(t);
  await writeFile(join(fixture.root, "AGENTS.md"), "REMOTE_DESKTOP_AGENT_RULES");

  const oldConfig = process.env.PI_REMOTE_CONFIG;
  const oldSessions = process.env.PI_REMOTE_SESSIONS;
  process.env.PI_REMOTE_CONFIG = fixture.store.file;
  process.env.PI_REMOTE_SESSIONS = join(fixture.root, "remote-sessions.json");
  t.after(() => {
    if (oldConfig === undefined) delete process.env.PI_REMOTE_CONFIG; else process.env.PI_REMOTE_CONFIG = oldConfig;
    if (oldSessions === undefined) delete process.env.PI_REMOTE_SESSIONS; else process.env.PI_REMOTE_SESSIONS = oldSessions;
  });

  // Build the PI-Desktop plugin directory so we test source-ts, dev-folder packaged-js, and isolated .piplug layout (no ancestor node_modules).
  const built = await buildPiDesktopPlugin({ outDir: join(fixture.root, "artifacts") });
  const isolatedPluginDir = join(fixture.root, "isolated-installed-plugin");
  await cp(built.pluginDir, isolatedPluginDir, { recursive: true });
  const { TrustedExtensionRunner, clearTrustedExtensionCache } = await import(pathToFileURL(realRunnerPath).href) as {
    TrustedExtensionRunner: new (opts: { specs: Array<{ id: string; label: string; entry: string }>; bridge: Record<string, any>; reservedToolNames: () => Iterable<string> }) => any;
    clearTrustedExtensionCache: () => void;
  };

  for (const [label, entry] of [
    ["source-ts", resolve("src/extension.ts")],
    ["packaged-dev", join(built.pluginDir, "runtime/extension.js")],
    ["packaged-isolated", join(isolatedPluginDir, "runtime/extension.js")],
  ] as const) {
    clearTrustedExtensionCache();
    const sessionId = `pi-desktop-session-${label}`;
    const localCwd = join(fixture.root, `local-${label}`);
    const harness = createDesktopBridgeHarness(sessionId, localCwd);

    const runner = new TrustedExtensionRunner({
      specs: [{ id: `io.github.buptweixin.pi-remote.${label}`, label: "Pi Remote", entry }],
      bridge: harness.bridge,
      reservedToolNames: () => [...CORE_DESKTOP_TOOLS, ...harness.activeDeferred],
    });
    const reports = await runner.load();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].state, "loaded", `Extension failed to load (${label}): ${JSON.stringify(runner.getDiagnostics())}`);
    assert.deepEqual(runner.getDiagnostics(), [], `Expected zero PI-Desktop diagnostics for ${label}`);
    assert.deepEqual(reports[0].commandNames, ["remote"]);
    assert.deepEqual(reports[0].toolNames, [...REMOTE_DESKTOP_TOOL_NAMES]);

    // 1. Unbound session: remote_* tools are inactive, system prompt is untouched (undefined = keep base).
    assert.equal(harness.activeDeferred.size, 0);
    const unboundPrompt = await runner.emitBeforeAgentStart("hello", "BASE_PROMPT");
    assert.equal(unboundPrompt, undefined);

    // 2. Bind via /remote use test -> activates remote_* tools, sets status, keeps local tools unblocked (双端共存).
    assert.equal(await runner.runCommand("remote", "use test"), true);
    assert.match(harness.notices.at(-1)?.message ?? "", /已绑定/);
    assert.match(harness.statuses.get("pi-remote") ?? "", /^SSH fixture · /);
    assert.deepEqual([...harness.activeDeferred].sort(), [...REMOTE_DESKTOP_TOOL_NAMES].sort());

    const localReadGate = await runner.emit("tool_call", { type: "tool_call", toolName: "Read", toolCallId: "tc-local", input: { path: "a.txt" } });
    assert.equal(localReadGate, undefined, "Local Read must remain unblocked in dual-end coexistence mode");

    const boundPrompt = await runner.emitBeforeAgentStart("edit remote", "BASE_PROMPT");
    assert.match(boundPrompt, /# SSH Remote Workspace \(Pi Remote\)/);
    assert.match(boundPrompt, /REMOTE_DESKTOP_AGENT_RULES/);
    assert.match(boundPrompt, /remote_read/);

    // 3. Execute real SSH remote_* tools inside PI-Desktop's TrustedExtensionRunner.
    const agentTools = new Map<string, any>(runner.getAgentTools().map((tool: any) => [tool.name, tool]));
    await agentTools.get("remote_write").execute("call-w", { path: `desktop-${label}.txt`, content: "hello from pi-desktop\n" });
    await agentTools.get("remote_edit").execute("call-e", {
      path: `desktop-${label}.txt`,
      oldText: "hello from pi-desktop",
      newText: `updated from ${label}`,
    });
    const readRes = await agentTools.get("remote_read").execute("call-r", { path: `desktop-${label}.txt` });
    assert.match(JSON.stringify(readRes.content), new RegExp(`updated from ${label}`));
    assert.equal(await readFile(join(fixture.root, `desktop-${label}.txt`), "utf8"), `updated from ${label}\n`);

    const bashRes = await agentTools.get("remote_bash").execute("call-b", { command: `cat desktop-${label}.txt` });
    assert.match(JSON.stringify(bashRes.content), new RegExp(`updated from ${label}`));

    await runner.dispose();

    // 4. Recreating Runner for the same sessionId (model switch / app restart) restores remote binding automatically.
    const reloadedHarness = createDesktopBridgeHarness(sessionId, localCwd);
    const reloadedRunner = new TrustedExtensionRunner({
      specs: [{ id: `io.github.buptweixin.pi-remote.${label}`, label: "Pi Remote", entry }],
      bridge: reloadedHarness.bridge,
      reservedToolNames: () => [...CORE_DESKTOP_TOOLS],
    });
    await reloadedRunner.load();
    assert.deepEqual([...reloadedHarness.activeDeferred].sort(), [...REMOTE_DESKTOP_TOOL_NAMES].sort());
    assert.match(reloadedHarness.statuses.get("pi-remote") ?? "", /^SSH fixture · /);

    // 5. Unbind from the PI-Desktop Work Panel View and verify live sync on the next turn.
    (globalThis as Record<string, unknown>).pi = {
      commands: { register: async () => {}, unregister: async () => {} },
      ui: { openPanel: async () => {}, closePanel: async () => {}, showToast: async () => {} },
      session: { getActive: async () => ({ sessionId }) },
      clipboard: { writeText: async () => {} },
    };
    const panelPlugin = createPiDesktopPlugin({ store: fixture.store });
    await panelPlugin.onLoad();
    await panelPlugin.onPanelInvoke("pi-remote.unbindSession", {});
    const afterUnbindPrompt = await reloadedRunner.emitBeforeAgentStart("local turn", "BASE_PROMPT");
    assert.equal(afterUnbindPrompt, undefined);
    assert.equal(reloadedHarness.activeDeferred.size, 0);

    // Re-bind from Work Panel View and verify the Agent sidecar picks it up on the very next turn without /remote use.
    await panelPlugin.onPanelInvoke("pi-remote.bindSession", { workspaceId: "test" });
    const afterRebindPrompt = await reloadedRunner.emitBeforeAgentStart("remote turn", "BASE_PROMPT");
    assert.match(afterRebindPrompt, /# SSH Remote Workspace \(Pi Remote\)/);
    assert.deepEqual([...reloadedHarness.activeDeferred].sort(), [...REMOTE_DESKTOP_TOOL_NAMES].sort());
    assert.deepEqual(reloadedRunner.getDiagnostics(), [], `Expected zero diagnostics after full lifecycle (${label})`);

    await panelPlugin.onUnload();
    delete (globalThis as Record<string, unknown>).pi;
    await reloadedRunner.dispose();
  }
});
