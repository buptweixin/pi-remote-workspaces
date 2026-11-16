import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "../src/process.js";
import { createRemoteTools } from "../src/tools.js";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { temporary, clientFor } from "./helpers.js";

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
