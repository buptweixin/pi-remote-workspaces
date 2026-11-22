import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "../src/process.js";
import { RemoteClient, remotePythonCommand } from "../src/remote.js";
import { defaults } from "../src/config.js";
import { createRemoteTools, createStandaloneRemoteTools, getNativeReadonlyToolFactories, LOCAL_READONLY_TOOL_NAMES, remotePath } from "../src/tools.js";
import remoteExtension from "../src/extension.js";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { temporary, clientFor, localTransport, workspace } from "./helpers.js";

test("actual remote helper reads/writes quoted paths, preserves modes and detects conflicts", async t => {
  const dir = await temporary(t), root = join(dir, "project's $(not-a-command)");
  await mkdir(root); const client = clientFor(root);
  assert.equal((await client.probe()).root, await realpath(root));
  const path = "nested/a ' $(echo nope).txt";
  await client.write(path, "hello\r\nworld\r\n");
  const original = await client.read(path);
  assert.equal(Buffer.from(original.data, "base64").toString(), "hello\r\nworld\r\n");
  await client.write(path, "new content", original.etag);
  await assert.rejects(client.write(path, "stale write", original.etag), /conflict/);
  const version = await client.read(path);
  const racing = await Promise.allSettled([client.write(path, "writer A", version.etag), client.write(path, "writer B", version.etag)]);
  assert.equal(racing.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(racing.filter(result => result.status === "rejected").length, 1);
  assert.equal((await client.list("nested"))[0]!.name, "a ' $(echo nope).txt");
  const output = await client.bash("pwd; printf '%s' '$(printf no-execution)' ");
  assert.equal(output.exitCode, 0);
  assert.match(output.stdout.toString(), /\$\(printf no-execution\)/);
});

test("file operations reject traversal and symlink escapes", async t => {
  const dir = await temporary(t), root = join(dir, "root"); await mkdir(root);
  await writeFile(join(dir, "outside"), "private"); await symlink(dir, join(root, "escape"));
  const client = clientFor(root);
  await assert.rejects(client.read("../outside"), /escapes/);
  await assert.rejects(client.read("escape/outside"), /escapes/);
  await assert.rejects(client.write("escape/overwrite", "bad"), /escapes/);
});

test("native pi read/write/edit/bash/search tools operate on the remote filesystem", async t => {
  const root = await temporary(t), client = clientFor(root), probe = await client.probe();
  const tools = createRemoteTools(client, probe), ctx = { cwd: "/wrong/local/cwd" } as ExtensionToolContext;
  await tools.write!.execute("w", { path: "source.ts", content: "const value = 1;\r\n" }, undefined, undefined, ctx);
  const read = await tools.read!.execute("r", { path: "source.ts" }, undefined, undefined, ctx);
  assert.match(JSON.stringify(read.content), /const value = 1/);
  const edit = await tools.edit!.execute("e", { path: "source.ts", edits: [{ oldText: "value = 1", newText: "value = 2" }] }, undefined, undefined, ctx);
  assert.match(edit.details.diff, /value = 2/);
  assert.equal(await readFile(join(root, "source.ts"), "utf8"), "const value = 2;\r\n");
  const ls = await tools.ls!.execute("ls", {}, undefined, undefined, ctx);
  assert.match(JSON.stringify(ls.content), /source.ts/);
  if (probe.ripgrep) {
    const grep = await tools.grep!.execute("g", { pattern: "value = 2", literal: true }, undefined, undefined, ctx);
    assert.match(JSON.stringify(grep.content), /value = 2/);
    const find = await tools.find!.execute("f", { pattern: "*.ts" }, undefined, undefined, ctx);
    assert.match(JSON.stringify(find.content), /source.ts/);
  }
  const bash = await tools.bash!.execute("b", { command: "printf success; exit 7" }, undefined, undefined, ctx);
  assert.match(JSON.stringify(bash), /success/);
  assert.equal(bash.isError, true);
});

test("SSH process execution enforces cancellation, timeout and output bounds", async () => {
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(async () => runProcess("/bin/sh", ["-c", "exit 0"], { signal: aborted.signal }));
  await assert.rejects(runProcess("/bin/sh", ["-c", "sleep 5"], { timeoutMs: 50 }), /timed out/);
  const controller = new AbortController();
  const pending = runProcess("/bin/sh", ["-c", "sleep 5"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, /aborted/);
  await assert.rejects(runProcess("/bin/sh", ["-c", "printf 123456789"], { maxBytes: 5 }), /size limit/);
});

test("remote tools minimize SSH round-trips, handle symlinks/images/@~ paths, and preserve partial bash output on timeout", async t => {
  const dir = await temporary(t), root = join(dir, "workspace");
  await mkdir(join(root, "sub/real-dir"), { recursive: true });
  await writeFile(join(dir, "outside.txt"), "secret");
  for (let i = 0; i < 12; i++) await writeFile(join(root, `file-${i}.txt`), `line ${i}\n`);
  await symlink(join(root, "sub/real-dir"), join(root, "linked-dir"));
  await symlink(join(dir, "outside.txt"), join(root, "escaped-link"));
  // Minimal valid 1x1 PNG saved with a non-image extension to verify magic-byte sniffing.
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  await writeFile(join(root, "image.bin"), Buffer.from(pngBase64, "base64"));

  let rpcCalls = 0;
  const countingClient = new RemoteClient(workspace(root), defaults(), async (prog, args, opts) => {
    rpcCalls++;
    return localTransport(prog, args, opts);
  });
  const probe = await countingClient.probe();
  const tools = createRemoteTools(countingClient, probe);
  const ctx = { cwd: "/wrong/local/cwd" } as ExtensionToolContext;

  assert.equal(remotePath("@~/project/file.ts", "/remote/home"), "/remote/home/project/file.ts");

  rpcCalls = 0;
  const lsResult = await tools.ls!.execute("ls-1", {}, undefined, undefined, ctx);
  assert.equal(rpcCalls, 1, "ls should complete in a single SSH RPC regardless of entry count");
  const lsText = JSON.stringify(lsResult.content);
  assert.match(lsText, /linked-dir\//);
  assert.doesNotMatch(lsText, /escaped-link/);

  rpcCalls = 0;
  const imgResult = await tools.read!.execute("r-img", { path: "image.bin" }, undefined, undefined, ctx);
  assert.equal(rpcCalls, 1, "read should complete in a single SSH RPC including image sniffing");
  assert.ok(imgResult.content.some((block: { type: string }) => block.type === "image"));

  rpcCalls = 0;
  await tools.write!.execute("w-1", { path: "deep/nested/created.txt", content: "alpha\nbeta\n" }, undefined, undefined, ctx);
  assert.equal(rpcCalls, 1, "write should create parent directories and write in a single SSH RPC");

  rpcCalls = 0;
  await tools.edit!.execute("e-1", { path: "deep/nested/created.txt", edits: [{ oldText: "alpha", newText: "ALPHA" }] }, undefined, undefined, ctx);
  assert.equal(rpcCalls, 2, "edit should use exactly 2 SSH RPCs (preflight read + conflict-checked write)");

  if (probe.ripgrep) {
    await writeFile(join(root, "sub/long.ts"), `const marker = "${"x".repeat(700)}";\nconst second = "marker";\n`);
    rpcCalls = 0;
    const subFind = await tools.find!.execute("f-sub", { path: "sub", pattern: "./*.ts" }, undefined, undefined, ctx);
    assert.equal(rpcCalls, 1, "find should complete in a single SSH RPC");
    assert.match(JSON.stringify(subFind.content), /long\.ts/);

    const grepRes = await tools.grep!.execute("g-sub", { path: "sub", pattern: "marker", limit: 1, context: 1 }, undefined, undefined, ctx);
    const grepText = (grepRes.content[0] as { text: string }).text;
    assert.match(grepText, /^long\.ts:1:/m);
    assert.match(grepText, /\[truncated\]/);
    assert.equal(grepRes.details?.matchLimitReached, 1);
    assert.equal(grepRes.details?.linesTruncated, true);
  }

  await assert.rejects(
    tools.bash!.execute("b-timeout", { command: "printf 'streamed-before-timeout\\n'; sleep 5", timeout: 1 }, undefined, undefined, ctx),
    /streamed-before-timeout[\s\S]*Command timed out after 1 seconds/,
  );

  // Verify sentinel framing tolerates noisy SSH login banners on stdout.
  const noisyClient = new RemoteClient(workspace(root), defaults(), async (prog, args, opts) => {
    const res = await localTransport(prog, args, opts);
    return { ...res, stdout: Buffer.concat([Buffer.from("Welcome to Corp Bastion!\n"), res.stdout]) };
  });
  assert.equal((await noisyClient.probe()).root, probe.root);
});

test("nativeMode activates read-only local_* tools when bound to remote and deactivates them on /remote local", async t => {
  const localDir = await temporary(t);
  const remoteDir = await temporary(t);
  await writeFile(join(localDir, "local-only.txt"), "local-secret-line\n");
  await writeFile(join(remoteDir, "remote-only.txt"), "remote-secret-line\n");

  const registeredTools = new Map<string, ToolDefinition<any, any> & { defaultActive?: boolean }>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any> | any>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  let activeTools = ["read", "write", "edit", "bash", "find", "grep", "ls"];

  const pi = {
    getSettings: () => ({}),
    registerFlag: () => {},
    getFlag: () => undefined,
    registerTool: (tool: ToolDefinition<any, any> & { defaultActive?: boolean }) => {
      registeredTools.set(tool.name, tool);
    },
    registerCommand: (name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) => {
      commands.set(name, spec);
    },
    on: (event: string, handler: (event: any, ctx: any) => Promise<any> | any) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => { activeTools = [...names]; },
    appendEntry: () => {},
    sendMessage: () => {},
  } as unknown as ExtensionAPI;

  remoteExtension(pi);

  assert.deepEqual(
    getNativeReadonlyToolFactories().map(spec => spec.name),
    [...LOCAL_READONLY_TOOL_NAMES],
  );
  for (const name of LOCAL_READONLY_TOOL_NAMES) {
    const tool = registeredTools.get(name);
    assert.ok(tool, `${name} should be registered`);
    assert.equal(tool.defaultActive, false, `${name} should default to inactive`);
  }

  let branch: Array<{ type: string; customType?: string; data?: unknown }> = [];
  const makeCtx = () => ({
    cwd: localDir,
    isIdle: () => true,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWidget: () => {},
    },
  });

  // 1. Local mode: local_* tools stay inactive.
  for (const fn of handlers.get("session_start") ?? []) await fn({}, makeCtx());
  for (const name of LOCAL_READONLY_TOOL_NAMES) {
    assert.equal(activeTools.includes(name), false, `${name} should be inactive in local mode`);
  }

  // 2. Restore remote binding: local_* tools become active and operate on localDir.
  const remoteProbe = await clientFor(remoteDir).probe();
  branch = [{
    type: "custom",
    customType: "pi-remote-workspace-v1",
    data: { mode: "remote", binding: { workspace: workspace(remoteDir), probe: remoteProbe } },
  }];
  for (const fn of handlers.get("session_start") ?? []) await fn({}, makeCtx());
  for (const name of LOCAL_READONLY_TOOL_NAMES) {
    assert.equal(activeTools.includes(name), true, `${name} should be active in remote mode`);
  }

  const promptEvent = {
    systemPromptOptions: {
      cwd: localDir,
      contextFiles: [],
      selectedTools: [...activeTools],
      sections: {} as Record<string, string>,
    },
  };
  for (const fn of handlers.get("before_agent_start") ?? []) await fn(promptEvent, makeCtx());
  assert.match(promptEvent.systemPromptOptions.sections.ssh_workspace ?? "", /local_read, local_ls, local_find, local_grep/);

  const toolCtx = { cwd: localDir } as ExtensionToolContext;
  const localRead = await registeredTools.get("local_read")!.execute("lr", { path: "local-only.txt" }, undefined, undefined, toolCtx);
  assert.match(JSON.stringify(localRead.content), /local-secret-line/);
  const localLs = await registeredTools.get("local_ls")!.execute("lls", {}, undefined, undefined, toolCtx);
  assert.match(JSON.stringify(localLs.content), /local-only\.txt/);
  assert.doesNotMatch(JSON.stringify(localLs.content), /remote-only\.txt/);
  const localFind = await registeredTools.get("local_find")!.execute("lf", { pattern: "*.txt" }, undefined, undefined, toolCtx);
  assert.match(JSON.stringify(localFind.content), /local-only\.txt/);
  const localGrep = await registeredTools.get("local_grep")!.execute("lg", { pattern: "local-secret-line", literal: true }, undefined, undefined, toolCtx);
  assert.match(JSON.stringify(localGrep.content), /local-secret-line/);

  // 3. Switch back to local: local_* tools are deactivated again.
  await commands.get("remote")!.handler("local", makeCtx());
  for (const name of LOCAL_READONLY_TOOL_NAMES) {
    assert.equal(activeTools.includes(name), false, `${name} should be deactivated after /remote local`);
  }
});

test("compressed bootstrap is single-line shell-safe, search works without ripgrep, and >8 MiB text files stream line slices", async t => {
  for (const loop of [false, true]) {
    const cmd = remotePythonCommand(loop);
    assert.equal(cmd.includes("\n"), false, "bootstrap command must be single-line for csh/tcsh");
    assert.equal(/[$`\\!]/.test(cmd), false, "bootstrap command must not contain $, `, \\, or ! for fish/csh/sh");
  }

  const outer = await temporary(t);
  const root = join(outer, "no-rg-workspace");
  const minimalBin = join(outer, "minimal-bin");
  await mkdir(join(root, "src/nested"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(minimalBin, { recursive: true });
  await writeFile(join(root, ".git/config"), "[core]\n");
  await writeFile(join(outer, "outside-secret.ts"), "export const needle = 'escaped';\n");
  await symlink(join(outer, "outside-secret.ts"), join(root, "src/escaped.ts"));
  await writeFile(join(root, "src/nested/alpha.ts"), "const first = 1;\nconst Needle = 'match-here';\nconst after = 3;\n");
  await writeFile(join(root, "src/notes.md"), "needle in markdown\n");

  // Locate python3 and expose ONLY python3 in PATH (no rg, no git) so Python fallback is exercised.
  const whichPy = await runProcess("/bin/sh", ["-c", "command -v python3"]);
  const pyPath = whichPy.stdout.toString("utf8").trim();
  assert.ok(pyPath, "python3 must be available in test environment");
  await symlink(pyPath, join(minimalBin, "python3"));

  // Strip _extra_dir fallback PATH entries by isolating HOME and PATH inside the transport shell.
  const noRgClient = new RemoteClient(workspace(root), defaults(), async (_prog, args, opts) => {
    // Override PATH after python starts? No: remoteScript appends /opt/homebrew/bin and /usr/local/bin if present!
    // Shadow `rg` and `git` with non-executable files? `shutil.which` skips non-executable files!
    // Instead, run a tiny wrapper or test via python override: wait — let's check how `shutil.which` works!
    return runProcess("/bin/sh", ["-c", args.at(-1)!], {
      ...opts,
      env: { HOME: outer, PATH: minimalBin },
    });
  });

  // Note: remoteScript appends /opt/homebrew/bin and /usr/local/bin to PATH for convenience on macOS,
  // so also verify fallback directly when rg is absent OR via a shadow script if rg is in /opt/homebrew/bin.
  const probe = await noRgClient.probe();
  if (probe.ripgrep) {
    // Place an empty directory first on PATH? shutil.which searches PATH in order; a non-executable doesn't stop search,
    // so verify Python fallback explicitly by invoking python3 with shutil.which patched for rg/git.
    const fallbackClient = new RemoteClient(workspace(root), defaults(), async (_prog, args, opts) => {
      const cmd = args.at(-1)!.replace(
        'python3 -c "',
        'python3 -c "import shutil as _s; _orig=_s.which; _s.which=lambda n,*a,**k: None if n in (\'rg\',\'git\') else _orig(n,*a,**k); ',
      );
      return runProcess("/bin/sh", ["-c", cmd], opts);
    });
    const fallbackProbe = await fallbackClient.probe();
    assert.equal(fallbackProbe.ripgrep, false);
    assert.equal(fallbackProbe.git, false);

    const tools = createStandaloneRemoteTools(fallbackClient, fallbackProbe);
    const foundAll = await tools.remote_find.execute("f1", { pattern: "**/*.ts" }, undefined, undefined, {} as any);
    const foundText = (foundAll.content[0] as { text: string }).text;
    assert.match(foundText, /src\/nested\/alpha\.ts/);
    assert.doesNotMatch(foundText, /escaped\.ts/);
    assert.doesNotMatch(foundText, /\.git/);

    const grepRes = await tools.remote_grep.execute("g1", {
      pattern: "needle",
      ignoreCase: true,
      glob: "*.ts",
      context: 1,
    }, undefined, undefined, {} as any);
    const grepText = (grepRes.content[0] as { text: string }).text;
    assert.match(grepText, /src\/nested\/alpha\.ts-1-\s*const first = 1;/);
    assert.match(grepText, /src\/nested\/alpha\.ts:2:\s*const Needle = 'match-here';/);
    assert.match(grepText, /src\/nested\/alpha\.ts-3-\s*const after = 3;/);
    assert.doesNotMatch(grepText, /notes\.md/);
  } else {
    const tools = createStandaloneRemoteTools(noRgClient, probe);
    const foundAll = await tools.remote_find.execute("f1", { pattern: "**/*.ts" }, undefined, undefined, {} as any);
    assert.match((foundAll.content[0] as { text: string }).text, /src\/nested\/alpha\.ts/);
    const grepRes = await tools.remote_grep.execute("g1", { pattern: "needle", ignoreCase: true, glob: "*.ts" }, undefined, undefined, {} as any);
    assert.match((grepRes.content[0] as { text: string }).text, /src\/nested\/alpha\.ts:2:/);
  }

  // Create an >8 MiB multi-line log file (~8.5 MiB) and verify full read rejects while tool slice reads succeed!
  const bigPath = join(root, "huge.log");
  const chunkLine = `${"x".repeat(100)}\n`; // 101 bytes/line
  const totalLinesCount = 89_000; // ~8.98 MiB > 8 MiB
  const linesBuf = Buffer.alloc(totalLinesCount * chunkLine.length, chunkLine, "utf8");
  const markerLine = "SPECIAL_MARKER_AT_LINE_50000                                                                        \n";
  Buffer.from(markerLine, "utf8").copy(linesBuf, (50_000 - 1) * chunkLine.length);
  await writeFile(bigPath, linesBuf);

  const client = clientFor(root);
  const fullProbe = await client.probe();
  await assert.rejects(client.read("huge.log"), /File exceeds 8 MiB/);

  const standaloneTools = createStandaloneRemoteTools(client, fullProbe);
  const desktopSlice = await standaloneTools.remote_read.execute("sr", { path: "huge.log", offset: 49_999, limit: 3 }, undefined, undefined, {} as any);
  const desktopSliceText = (desktopSlice.content[0] as { text: string }).text;
  assert.match(desktopSliceText, /SPECIAL_MARKER_AT_LINE_50000/);
  assert.match(desktopSliceText, /Showing lines 49999-50001 of 89001/);

  const nativeTools = createRemoteTools(client, fullProbe);
  const nativeSlice = await nativeTools.read!.execute("nr", { path: "huge.log", offset: 50_000, limit: 2 }, undefined, undefined, { cwd: "/unused" } as ExtensionToolContext);
  const nativeSliceText = (nativeSlice.content[0] as { text: string }).text;
  assert.match(nativeSliceText, /SPECIAL_MARKER_AT_LINE_50000/);
  assert.match(nativeSliceText, /Showing lines 50000-50001 of 89001/);
});
