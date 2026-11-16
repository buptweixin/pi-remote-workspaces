import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRemoteTools } from "../src/tools.js";
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
    t.after(() => result.dispose());
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
});
