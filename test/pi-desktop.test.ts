import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigStore, SessionBindingStore } from "../src/config.js";
import { RemoteClient } from "../src/remote.js";
import { createPiDesktopPlugin } from "../src/pi-desktop-main.js";
import { createStandaloneRemoteTools, hasNativeToolFactories, REMOTE_DESKTOP_TOOL_NAMES } from "../src/tools.js";
import { buildPiDesktopPlugin, crc32 } from "../scripts/build-pi-desktop.mjs";
import { clientFor, localTransport, temporary } from "./helpers.js";

test("hasNativeToolFactories inspects ownKeys without triggering PI-Desktop unsupported_api proxy traps", () => {
  const accessed: string[] = [];
  const shimTarget = {
    defineTool: (t: unknown) => t,
    isBashToolResult: () => false,
    isToolCallEventType: () => false,
    VERSION: "0.87.1",
  };
  const desktopShim = new Proxy(shimTarget, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) accessed.push(`get:${prop}`);
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === "string" && !(prop in target)) accessed.push(`has:${prop}`);
      return Reflect.has(target, prop);
    },
  });
  assert.equal(hasNativeToolFactories(desktopShim), false);
  assert.deepEqual(accessed, []);
  assert.equal(hasNativeToolFactories({ ...shimTarget, createReadToolDefinition: () => ({}) }), true);
});

test("standalone remote_* tools execute read/write/edit/ls/find/grep/bash with conflict and escape guards", async t => {
  const outer = await temporary(t);
  const root = join(outer, "remote-workspace");
  await mkdir(root, { recursive: true });
  await writeFile(join(outer, "secret.txt"), "outside");
  await symlink(join(outer, "secret.txt"), join(root, "escaped-link"));

  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  await writeFile(join(root, "pixel.png"), Buffer.from(pngBase64, "base64"));

  const client = clientFor(root);
  const probe = await client.probe();
  const tools = createStandaloneRemoteTools(client, probe);
  assert.deepEqual(Object.keys(tools), [...REMOTE_DESKTOP_TOOL_NAMES]);

  await tools.remote_write.execute("w1", { path: "src/hello.ts", content: "\uFEFFline 1\r\nline 2\r\nline 3\r\n" }, undefined, undefined, {} as any);
  const readPage = await tools.remote_read.execute("r1", { path: "src/hello.ts", offset: 1, limit: 2 }, undefined, undefined, {} as any);
  const readText = (readPage.content[0] as { text: string }).text;
  assert.match(readText, /line 1\nline 2/);
  assert.match(readText, /Showing lines 1-2 of 4/);

  // Single oldText/newText edit preserves UTF-8 BOM and CRLF line endings.
  const singleEdit = await tools.remote_edit.execute("e1", { path: "src/hello.ts", oldText: "line 2", newText: "LINE TWO" }, undefined, undefined, {} as any);
  assert.match((singleEdit.content[0] as { text: string }).text, /\+LINE TWO/);
  assert.equal(await readFile(join(root, "src/hello.ts"), "utf8"), "\uFEFFline 1\r\nLINE TWO\r\nline 3\r\n");

  // Multi-hunk edits[] array also works and rejects duplicate matches.
  await tools.remote_edit.execute("e2", {
    path: "src/hello.ts",
    edits: [
      { oldText: "line 1", newText: "FIRST" },
      { oldText: "line 3", newText: "THIRD" },
    ],
  }, undefined, undefined, {} as any);
  assert.equal(await readFile(join(root, "src/hello.ts"), "utf8"), "\uFEFFFIRST\r\nLINE TWO\r\nTHIRD\r\n");

  await writeFile(join(root, "dup.txt"), "same\nsame\n");
  await assert.rejects(
    tools.remote_edit.execute("e-dup", { path: "dup.txt", oldText: "same", newText: "diff" }, undefined, undefined, {} as any),
    /multiple occurrences/,
  );

  // Image sniffing works in a single RPC.
  const img = await tools.remote_read.execute("r-img", { path: "pixel.png" }, undefined, undefined, {} as any);
  assert.ok(img.content.some((item: { type: string }) => item.type === "image"));

  // Directory listing hides escaped symlinks.
  const ls = await tools.remote_ls.execute("ls1", {}, undefined, undefined, {} as any);
  const lsText = (ls.content[0] as { text: string }).text;
  assert.match(lsText, /src\//);
  assert.doesNotMatch(lsText, /escaped-link/);

  if (probe.ripgrep) {
    const found = await tools.remote_find.execute("f1", { pattern: "*.ts" }, undefined, undefined, {} as any);
    assert.match((found.content[0] as { text: string }).text, /src\/hello\.ts/);
    const grepped = await tools.remote_grep.execute("g1", { pattern: "LINE TWO", literal: true }, undefined, undefined, {} as any);
    assert.match((grepped.content[0] as { text: string }).text, /src\/hello\.ts:2:\s*LINE TWO/);
  }

  const updates: string[] = [];
  const bashRes = await tools.remote_bash.execute(
    "b1",
    { command: "printf 'remote-ok'; exit 3" },
    undefined,
    partial => updates.push((partial.content[0] as { text: string }).text),
    {} as any,
  );
  assert.equal(bashRes.isError, true);
  assert.match((bashRes.content[0] as { text: string }).text, /remote-ok/);
  assert.ok(updates.length >= 1);
});

test("PI-Desktop plugin main entry bridges workbench API and live session bindings", async t => {
  const dir = await temporary(t);
  const remoteRoot = join(dir, "remote-root");
  await mkdir(remoteRoot, { recursive: true });
  await writeFile(join(remoteRoot, "README.md"), "# Remote Project\n");

  const store = new ConfigStore(join(dir, "remote.json"));
  const sessionStore = new SessionBindingStore(join(dir, "remote-sessions.json"));

  const registeredCommands = new Map<string, () => Promise<void> | void>();
  const toasts: string[] = [];
  let copied = "";
  let revealedView = "";
  let activeSession: { sessionId: string; projectPath?: string; activeTurn?: { turnId: string; startedAt: string } | null } | null = { sessionId: "desktop-session-1", projectPath: dir };

  (globalThis as Record<string, unknown>).pi = {
    commands: {
      register: async (spec: { id: string; run: () => Promise<void> | void }) => { registeredCommands.set(spec.id, spec.run); },
      unregister: async (id: string) => { registeredCommands.delete(id); },
    },
    ui: {
      openPanel: async () => {},
      closePanel: async () => {},
      revealView: async (id: string) => { revealedView = id; },
      showToast: async (msg: string) => { toasts.push(msg); },
    },
    session: {
      getActive: async () => activeSession,
    },
    clipboard: {
      writeText: async (text: string) => { copied = text; },
    },
  };
  t.after(() => { delete (globalThis as Record<string, unknown>).pi; });

  const plugin = createPiDesktopPlugin({
    store,
    sessionStore,
    client: (w, c) => new RemoteClient(w, c, localTransport),
  });
  await plugin.onLoad();
  assert.deepEqual([...registeredCommands.keys()].sort(), ["pi-remote.openPanel", "pi-remote.openView", "pi-remote.unbindSession"]);

  await registeredCommands.get("pi-remote.openView")!();
  assert.equal(revealedView, "workbench");

  const created = await plugin.onPanelInvoke("pi-remote.api", {
    path: "/api/workspaces",
    method: "POST",
    data: { id: "srv", name: "Server", host: "fixture", path: remoteRoot },
  }) as { id: string };
  assert.equal(created.id, "srv");

  const bound = await plugin.onPanelInvoke("pi-remote.bindSession", { workspaceId: "srv" }) as { sessionId: string; state: { mode: string } };
  assert.equal(bound.sessionId, "desktop-session-1");
  assert.equal(bound.state.mode, "remote");

  const status = await plugin.onPanelInvoke("pi-remote.sessionStatus", {}) as { state: { mode: string; binding?: { workspace: { id: string } } } };
  assert.equal(status.state.mode, "remote");
  assert.equal(status.state.binding?.workspace.id, "srv");

  await plugin.onPanelInvoke("pi-remote.copyText", { text: "/remote use srv" });
  assert.equal(copied, "/remote use srv");

  // Exercise the in-window Composer renderer slot RPC bridge (onRendererCall + async SSH job).
  const savedFromComposer = await plugin.onRendererCall("remote.saveWorkspace", {
    host: "fixture",
    path: remoteRoot,
    name: "Composer Workspace",
    bindNow: true,
  }) as { ok: boolean; workspace: { id: string }; job: { id: string; status: string } };
  assert.equal(savedFromComposer.ok, true);
  assert.ok(savedFromComposer.job?.id);

  let settledJob: { status: string; probe?: { hostname: string } } | null = null;
  for (let i = 0; i < 40; i++) {
    const poll = await plugin.onRendererCall("remote.job", { jobId: savedFromComposer.job.id }) as { ok: boolean; job: { status: string; probe?: { hostname: string } } };
    if (poll.job.status !== "connecting") {
      settledJob = poll.job;
      break;
    }
    await new Promise(resolveTimer => setTimeout(resolveTimer, 25));
  }
  assert.equal(settledJob?.status, "ready");

  const snap = await plugin.onRendererCall("remote.state", {}) as {
    ok: boolean;
    activeSessionId: string;
    state: { mode: string; binding?: { workspace: { id: string } } };
  };
  assert.equal(snap.ok, true);
  assert.equal(snap.activeSessionId, "desktop-session-1");
  assert.equal(snap.state.mode, "remote");
  assert.equal(snap.state.binding?.workspace.id, savedFromComposer.workspace.id);

  revealedView = "";
  await plugin.onRendererCall("remote.openView", {});
  assert.equal(revealedView, "workbench");

  // Active turn guard blocks mid-turn workspace bind/unbind mutations.
  activeSession = { sessionId: "desktop-session-1", projectPath: dir, activeTurn: { turnId: "t-1", startedAt: new Date().toISOString() } };
  const blockedUnbind = await plugin.onRendererCall("remote.unbind", {}) as { ok: boolean; error?: string };
  assert.equal(blockedUnbind.ok, false);
  assert.match(blockedUnbind.error ?? "", /等待当前对话回合结束/);
  await assert.rejects(plugin.onPanelInvoke("pi-remote.unbindSession", {}), /等待当前对话回合结束/);
  activeSession = { sessionId: "desktop-session-1", projectPath: dir, activeTurn: null };

  // Editing only workspace name updates persisted session binding in-place without dropping binding.
  const renamed = await plugin.onRendererCall("remote.saveWorkspace", {
    editingId: savedFromComposer.workspace.id,
    host: "fixture",
    path: remoteRoot,
    name: "Renamed Composer Workspace",
  }) as { ok: boolean; job: null | { id: string } };
  assert.equal(renamed.ok, true);
  assert.equal(renamed.job, null);
  const afterRename = await plugin.onRendererCall("remote.state", {}) as { state: { mode: string; binding?: { workspace: { name: string } } } };
  assert.equal(afterRename.state.binding?.workspace.name, "Renamed Composer Workspace");

  // Panel request cancellation (`pi-remote.cancel`) terminates in-flight SSH exec immediately.
  const startExecMs = Date.now();
  const pendingExec = plugin.onPanelInvoke("pi-remote.api", {
    requestId: "cancel-me-1",
    path: `/api/workspaces/${savedFromComposer.workspace.id}/exec`,
    method: "POST",
    data: { command: "sleep 10" },
  });
  setTimeout(() => { void plugin.onPanelInvoke("pi-remote.cancel", { requestId: "cancel-me-1" }); }, 60);
  await assert.rejects(pendingExec, /aborted/i);
  assert.ok(Date.now() - startExecMs < 4000, "Cancelled panel exec must terminate promptly");

  await plugin.onRendererCall("remote.unbind", {});
  const afterUnbind = await plugin.onRendererCall("remote.state", {}) as { state: { mode: string } };
  assert.equal(afterUnbind.state.mode, "local");

  await plugin.onRendererCall("remote.deleteWorkspace", { workspaceId: savedFromComposer.workspace.id });

  await registeredCommands.get("pi-remote.unbindSession")!();
  assert.equal((await sessionStore.get("desktop-session-1")), undefined);
  assert.ok(toasts.some(msg => msg.includes("已取消")));

  activeSession = null;
  const noSession = await plugin.onPanelInvoke("pi-remote.sessionStatus", {}) as { sessionId: string; state: { mode: string } };
  assert.equal(noSession.sessionId, "");
  assert.equal(noSession.state.mode, "local");

  await plugin.onUnload();
  assert.equal(registeredCommands.size, 0);
});

test("buildPiDesktopPlugin produces a valid store-only .piplug archive", async t => {
  const outDir = await temporary(t);
  const packed = await buildPiDesktopPlugin({ outDir });
  const bytes = await readFile(packed.packagePath);
  assert.equal(bytes.length, packed.byteLength);

  // Verify EOCD at end of archive and store-only (method 0) local entries with valid CRC32.
  const eocdOffset = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(eocdOffset), 0x06054b50);
  const totalEntries = bytes.readUInt16LE(eocdOffset + 8);
  assert.equal(totalEntries, packed.fileCount);

  let cursor = 0;
  const entryNames: string[] = [];
  const extractedDir = join(outDir, "installed-sim");
  for (let i = 0; i < totalEntries; i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x04034b50);
    assert.equal(bytes.readUInt16LE(cursor + 8), 0, "Compression method must be 0 (store-only)");
    const expectedCrc = bytes.readUInt32LE(cursor + 14);
    const compressedSize = bytes.readUInt32LE(cursor + 18);
    const uncompressedSize = bytes.readUInt32LE(cursor + 22);
    assert.equal(compressedSize, uncompressedSize);
    const nameLen = bytes.readUInt16LE(cursor + 26);
    const extraLen = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 30, cursor + 30 + nameLen).toString("utf8");
    const data = bytes.subarray(cursor + 30 + nameLen + extraLen, cursor + 30 + nameLen + extraLen + compressedSize);
    assert.equal(crc32(data), expectedCrc, `CRC mismatch for ${name}`);
    entryNames.push(name);
    const dest = join(extractedDir, name);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, data);
    cursor += 30 + nameLen + extraLen + compressedSize;
  }
  assert.deepEqual(entryNames, [...entryNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  for (const required of [
    "manifest.json",
    "main.js",
    "package.json",
    "renderer/index.mjs",
    "runtime/extension.js",
    "views/workbench-core.js",
    "views/workbench.html",
    "views/workbench.js",
    "views/workbench.css",
  ]) {
    assert.ok(entryNames.includes(required), `Missing ${required} in .piplug`);
  }
  const wbHtml = await readFile(join(extractedDir, "views/workbench.html"), "utf8");
  assert.match(wbHtml, /workbench-core\.js/);
  assert.match(wbHtml, /name="anchorRoot"/);

  // Simulate PI-Desktop's plugin-host-process loading main.js from the extracted .piplug directory.
  (globalThis as Record<string, unknown>).pi = {
    commands: { register: async () => {}, unregister: async () => {} },
    ui: { openPanel: async () => {}, closePanel: async () => {}, showToast: async () => {} },
    session: { getActive: async () => null },
    clipboard: { writeText: async () => {} },
  };
  try {
    const installedMain = await import(pathToFileURL(join(extractedDir, "main.js")).href);
    await installedMain.onLoad();
    const stateRes = await installedMain.onRendererCall("remote.state", {}) as { ok: boolean };
    assert.equal(stateRes.ok, true);
    await installedMain.onUnload();
  } finally {
    delete (globalThis as Record<string, unknown>).pi;
  }
});
