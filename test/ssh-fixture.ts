import { spawn } from "node:child_process";
import { access, readFile, writeFile, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { runProcess } from "../src/process.js";
import { ConfigStore, defaults } from "../src/config.js";
import { RemoteClient } from "../src/remote.js";
import type { TestContext } from "node:test";
import { temporary, workspace } from "./helpers.js";

export async function sshFixture(t: TestContext) {
  const root = await realpath(await temporary(t));
  const sshd = process.env.PI_REMOTE_SSHD || "/usr/sbin/sshd";
  await access(sshd);
  for (const name of ["host", "identity"]) {
    const result = await runProcess("ssh-keygen", ["-q", "-t", "ed25519", "-f", join(root, name), "-N", ""]);
    if (result.exitCode) throw new Error(result.stderr.toString());
  }
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No port"));
      const selected = address.port; server.close(() => resolve(selected));
    });
  });
  const daemonConfig = join(root, "sshd_config");
  await writeFile(daemonConfig, `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${root}/host\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile ${root}/identity.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowUsers ${userInfo().username}\nLogLevel ERROR\n`);
  const daemon = spawn(sshd, ["-D", "-e", "-f", daemonConfig], { stdio: ["ignore", "ignore", "pipe"] });
  let log = ""; daemon.stderr.on("data", data => { log += data; });
  t.after(async () => {
    if (daemon.exitCode !== null || daemon.signalCode) return;
    daemon.kill("SIGTERM"); await new Promise<void>(resolve => daemon.once("close", () => resolve()));
  });
  const hostKey = (await readFile(join(root, "host.pub"), "utf8")).split(" ").slice(0, 2).join(" ");
  await writeFile(join(root, "known_hosts"), `[127.0.0.1]:${port} ${hostKey}\n`);
  const sshConfigPath = join(root, "ssh_config");
  await writeFile(sshConfigPath, `Host fixture\n HostName 127.0.0.1\n Port ${port}\n User ${userInfo().username}\n IdentityFile "${root}/identity"\n IdentitiesOnly yes\n UserKnownHostsFile "${root}/known_hosts"\n`);
  const config = { ...defaults(), sshConfigPath, workspaces: [workspace(root)] };
  const client = new RemoteClient(config.workspaces[0]!, config);
  let connected = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    if (daemon.exitCode !== null) throw new Error(`Fixture sshd exited: ${log}`);
    try { await client.probe(); connected = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!connected) throw new Error(`Cannot connect to fixture sshd: ${log}`);
  const store = new ConfigStore(join(root, "remote.json")); await store.update(() => config);
  return { root, config, client, store };
}
