import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigStore, defaults, slugifyWorkspaceId, validateConfig, validateHost } from "../src/config.js";
import { anchorRootDir, matchAnchorCwd, removeWorkspaceAnchorIfEmpty, syncWorkspaceAnchors, workspaceAnchorDir } from "../src/anchors.js";
import { discoverHosts, resolveHost, tokens } from "../src/ssh-config.js";
import { temporary, workspace } from "./helpers.js";

test("SSH discovery reloads nested Includes, quotes, multi-alias Host lines and cycles", async t => {
  const home = await temporary(t), ssh = join(home, ".ssh");
  await mkdir(join(ssh, "conf.d"), { recursive: true });
  const file = join(ssh, "config");
  await writeFile(file, 'Host primary second *.wild !excluded\n HostName example.com\nInclude "conf.d/*.conf"\nHost = last # comment\n');
  await writeFile(join(ssh, "conf.d/a.conf"), "Include config\nHost nested\n");
  let result = await discoverHosts({ sshConfigPath: file }, home);
  assert.deepEqual(result.hosts.map(h => h.alias), ["last", "nested", "primary", "second"]);
  assert.equal(result.files.length, 2);
  assert.match(result.warnings.join(), /Circular/);
  await writeFile(join(ssh, "conf.d/b.conf"), "hOsT added\n");
  result = await discoverHosts({ sshConfigPath: file }, home);
  assert.ok(result.hosts.some(h => h.alias === "added"));
  assert.deepEqual(tokens('Include="some dir/file" # comment'), ["Include", "some dir/file"]);
});

test("system config is discovered only without -F, and OpenSSH owns effective option resolution", async t => {
  const home = await temporary(t); await mkdir(join(home, ".ssh"));
  const file = join(home, ".ssh/config"), system = join(home, "system");
  await writeFile(file, "Host dev\n HostName 127.0.0.1\n Port 2222\n User fixture-user\nHost *\n ServerAliveInterval 7\n");
  await writeFile(system, "Host system-alias\n");
  assert.equal((await discoverHosts({}, home, system)).hosts.length, 2);
  assert.equal((await discoverHosts({ sshConfigPath: file }, home, system)).hosts.length, 1);
  const result = await resolveHost("dev", { ...defaults(), sshConfigPath: file });
  assert.deepEqual(result.hostname, ["127.0.0.1"]);
  assert.deepEqual(result.port, ["2222"]);
  assert.deepEqual(result.user, ["fixture-user"]);
});

test("config updates are atomic across concurrent writers and invalid config is preserved", async t => {
  const dir = await temporary(t), file = join(dir, "nested/remote.json");
  const store = new ConfigStore(file);
  await Promise.all(Array.from({ length: 6 }, (_, index) => store.update(config => ({ ...config, workspaces: [...config.workspaces, { ...workspace("/tmp"), id: `w${index}` }] }))));
  assert.equal((await store.read()).workspaces.length, 6);
  await assert.rejects(store.update(config => ({ ...config, commandTimeoutSeconds: -1 })), /between/);
  assert.equal((await store.read()).workspaces.length, 6);
  await writeFile(file, "{broken");
  await assert.rejects(store.read());
  assert.equal(await readFile(file, "utf8"), "{broken");
});

test("host and workspace validation reject SSH options, shell metacharacters and invalid paths", () => {
  for (const host of ["-oProxyCommand=anything", "host;touch /tmp/oops", "*.example", "host\nother", "user@host $(id)"]) assert.throws(() => validateHost(host));
  validateHost("user@2001:db8::1");
  assert.throws(() => validateConfig({ ...defaults(), workspaces: [{ ...workspace("relative/path") }] }), /Remote path/);
  assert.equal(slugifyWorkspaceId("user@dev.example.com", "~/projects/my-app"), "dev-example-com-my-app");
  assert.equal(slugifyWorkspaceId("dev", "~/app", "My Service", ["my-service"]), "my-service-2");
});

test("SSH discovery ignores complex shell quotes in ProxyCommand and Match lines", async t => {
  const home = await temporary(t), file = join(home, "ssh_config");
  await writeFile(file, [
    "Host JumpBox",
    '  ProxyCommand sh -c \'exec nc %h %p\' \\',
    "Match host *.internal exec 'test \"$ENV\" = prod'",
    "Host clean-host",
  ].join("\n"));
  const inventory = await discoverHosts({ sshConfigPath: file }, home);
  assert.deepEqual(inventory.hosts.map(h => h.alias), ["clean-host", "JumpBox"].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(inventory.warnings, []);
});

test("anchorRoot validation, directory defaults, sync, safe removal and cwd matching", async t => {
  const valid = validateConfig({ ...defaults(), anchorRoot: "  /tmp/my-anchors  " });
  assert.equal(valid.anchorRoot, "/tmp/my-anchors");
  assert.throws(() => validateConfig({ ...defaults(), anchorRoot: "relative/anchors" }), /anchorRoot/);
  assert.throws(() => validateConfig({ ...defaults(), anchorRoot: "/tmp/bad\nanchor" }), /anchorRoot/);

  const oldEnv = process.env.PI_REMOTE_ANCHOR_DIR;
  delete process.env.PI_REMOTE_ANCHOR_DIR;
  t.after(() => {
    if (oldEnv === undefined) delete process.env.PI_REMOTE_ANCHOR_DIR;
    else process.env.PI_REMOTE_ANCHOR_DIR = oldEnv;
  });

  const defaultStoreFile = resolve(homedir(), ".pi/agent/remote.json");
  assert.equal(anchorRootDir(undefined, defaultStoreFile), resolve(homedir(), ".pi/remote-workspaces"));

  const tempDir = await temporary(t);
  const customStoreFile = join(tempDir, "nested/remote.json");
  assert.equal(anchorRootDir(undefined, customStoreFile), resolve(tempDir, "nested/remote-workspaces"));
  assert.equal(anchorRootDir({ anchorRoot: join(tempDir, "configured/") }, customStoreFile), resolve(tempDir, "configured"));

  process.env.PI_REMOTE_ANCHOR_DIR = join(tempDir, "env-anchors/");
  assert.equal(anchorRootDir({ anchorRoot: join(tempDir, "configured") }, customStoreFile), resolve(tempDir, "env-anchors"));
  delete process.env.PI_REMOTE_ANCHOR_DIR;

  const ws = { ...workspace("/srv/app"), id: "demo-ws" };
  const cfg = { ...defaults(), workspaces: [ws] };
  const synced = await syncWorkspaceAnchors(cfg, customStoreFile);
  assert.equal(synced.root, resolve(tempDir, "nested/remote-workspaces"));
  assert.equal(synced.workspaces["demo-ws"], workspaceAnchorDir("demo-ws", cfg, customStoreFile));
  assert.ok((await stat(synced.workspaces["demo-ws"]!)).isDirectory());

  assert.equal((await matchAnchorCwd(synced.root, cfg, customStoreFile)).kind, "picker");
  const wsMatch = await matchAnchorCwd(synced.workspaces["demo-ws"]!, cfg, customStoreFile);
  assert.equal(wsMatch.kind, "workspace");
  if (wsMatch.kind === "workspace") assert.equal(wsMatch.workspace.id, "demo-ws");
  assert.equal((await matchAnchorCwd(join(synced.root, "missing-ws"), cfg, customStoreFile)).kind, "unknown-workspace");
  assert.equal((await matchAnchorCwd(tempDir, cfg, customStoreFile)).kind, "none");

  const symlinkPath = join(tempDir, "anchor-link");
  await symlink(synced.workspaces["demo-ws"]!, symlinkPath);
  assert.equal((await matchAnchorCwd(symlinkPath, cfg, customStoreFile)).kind, "workspace");

  await removeWorkspaceAnchorIfEmpty("demo-ws", cfg, customStoreFile);
  await assert.rejects(stat(synced.workspaces["demo-ws"]!), /ENOENT/);

  await mkdir(synced.workspaces["demo-ws"]!, { recursive: true });
  await writeFile(join(synced.workspaces["demo-ws"]!, "keep.txt"), "data");
  await removeWorkspaceAnchorIfEmpty("demo-ws", cfg, customStoreFile);
  assert.ok((await stat(join(synced.workspaces["demo-ws"]!, "keep.txt"))).isFile());
});
