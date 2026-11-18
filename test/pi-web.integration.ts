import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { sshFixture } from "./ssh-fixture.js";

test("npx pi-web loads the package, serves /remote dialogs and binds real SSH workspaces", { skip: process.env.PI_REMOTE_TEST_PI_WEB !== "1", timeout: 180_000 }, async t => {
  const fixture = await sshFixture(t), agentDir = join(fixture.root, "pi-web-agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [process.cwd()], defaultTools: ["read", "write", "edit", "bash", "grep", "find", "ls"] }));
  const port = await new Promise<number>(resolve => {
    const socket = createServer(); socket.listen(0, "127.0.0.1", () => {
      const address = socket.address() as { port: number }; socket.close(() => resolve(address.port));
    });
  });
  const child = spawn("npx", ["--yes", process.env.PI_REMOTE_PI_WEB_PACKAGE || "@agegr/pi-web@latest", "--no-open", "--port", String(port)], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_REMOTE_CONFIG: fixture.store.file, PI_WEB_NO_OPEN: "1", PI_WEB_SKIP_VERSION_CHECK: "1" },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let logs = "";
  child.stdout.on("data", data => { logs = (logs + data).slice(-20_000); });
  child.stderr.on("data", data => { logs = (logs + data).slice(-20_000); });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode) return;
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    try { process.kill(-child.pid!, "SIGTERM"); } catch { return; }
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} }, 3000);
    await closed; clearTimeout(timer);
  });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 600; attempt++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { if ((await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(ready, logs);
  async function post(path: string, value: unknown) {
    const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value), signal: AbortSignal.timeout(30_000) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result) + logs);
    return result;
  }
  const created = await post("/api/agent/new", { cwd: fixture.root, type: "ensure_session" });
  const id = created.sessionId; assert.ok(id);
  const commands = await post(`/api/agent/${id}`, { type: "get_commands" });
  assert.match(JSON.stringify(commands), /remote/);
  const controller = new AbortController();
  const events = await fetch(`${origin}/api/agent/${id}/events`, { signal: controller.signal });
  const reader = events.body!.getReader(); let captured = "";
  const reading = (async () => {
    try { while (true) { const value = await reader.read(); if (value.done) break; captured += Buffer.from(value.value).toString(); } } catch {}
  })();
  t.after(async () => { controller.abort(); await reading; });
  // Extension commands use no model credentials and make no LLM calls.
  await post(`/api/agent/${id}`, { type: "prompt", message: "/remote use test" });
  await post(`/api/agent/${id}`, { type: "prompt", message: "/remote test" });
  for (let attempt = 0; attempt < 40 && !captured.includes('"statusKey":"command:/remote files"'); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.match(captured, /"statusKey":"command:\/remote"/);
  assert.match(captured, /"statusKey":"command:\/remote files"/);
  assert.match(captured, /"statusKey":"command:\/remote unbind"/);
  // Opening /remote emits a browser-compatible select dialog. Stop closes it.
  // This HTTP call stays pending until the select is answered or aborted.
  const selecting = post(`/api/agent/${id}`, { type: "prompt", message: "/remote" }).catch(() => undefined);
  for (let attempt = 0; attempt < 40 && !captured.includes('"method":"select"'); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.match(captured, /SSH fixture/);
  assert.match(captured, /Python/);
  assert.match(captured, /"method":"select"/);
  await post(`/api/agent/${id}`, { type: "abort" });
  await selecting;
  await post(`/api/agent/${id}`, { type: "prompt", message: "/remote unbind" });
  for (let attempt = 0; attempt < 40 && !captured.includes("SSH: 本地"); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.match(captured, /SSH: 本地/);
  assert.doesNotMatch(logs, /Failed to load extension|Cannot find module|Extension load error/);
});
