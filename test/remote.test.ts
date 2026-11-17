import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "../src/process.js";
import { RemoteClient } from "../src/remote.js";
import { defaults } from "../src/config.js";
import { createRemoteTools, remotePath } from "../src/tools.js";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
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
    tools.bash!.execute("b-timeout", { command: "printf 'streamed-before-timeout\\n'; sleep 5", timeout: 0.4 }, undefined, undefined, ctx),
    /streamed-before-timeout[\s\S]*Command timed out after 0\.4 seconds/,
  );

  // Verify sentinel framing tolerates noisy SSH login banners on stdout.
  const noisyClient = new RemoteClient(workspace(root), defaults(), async (prog, args, opts) => {
    const res = await localTransport(prog, args, opts);
    return { ...res, stdout: Buffer.concat([Buffer.from("Welcome to Corp Bastion!\n"), res.stdout]) };
  });
  assert.equal((await noisyClient.probe()).root, probe.root);
});
