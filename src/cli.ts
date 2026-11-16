#!/usr/bin/env node
import { ConfigStore } from "./config.js";
import { discoverHosts } from "./ssh-config.js";
import { RemoteClient } from "./remote.js";
import { startDashboard } from "./server.js";

async function main(args = process.argv.slice(2)) {
  const [command = "serve", ...rest] = args;
  const store = new ConfigStore();
  if (command === "help" || command === "--help" || command === "-h") {
    console.log("pi-remote serve [--port N]\npi-remote hosts\npi-remote list\npi-remote test <workspace-id>\n\nPI_REMOTE_CONFIG selects the config file. Default: ~/.pi/agent/remote.json"); return;
  }
  if (command === "serve") {
    if (rest.length && (rest.length !== 2 || rest[0] !== "--port")) throw new Error("Usage: pi-remote serve [--port N]");
    const port = rest[1] === undefined ? 0 : Number(rest[1]);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
    const dashboard = await startDashboard({ store, port });
    console.log(`Pi Remote · 配置与远程工作区\n${dashboard.url}\n\n按 Ctrl+C 退出`);
    const close = () => { void dashboard.close().then(() => process.exit(0)); };
    process.once("SIGINT", close); process.once("SIGTERM", close); return;
  }
  const config = await store.read();
  if (command === "hosts" && !rest.length) { console.log(JSON.stringify(await discoverHosts(config), null, 2)); return; }
  if (command === "list" && !rest.length) { console.table(config.workspaces); return; }
  if (command === "test" && rest.length === 1) {
    const workspace = config.workspaces.find(w => w.id === rest[0]);
    if (!workspace) throw new Error(`Unknown workspace: ${rest[0]}`);
    console.log(JSON.stringify(await new RemoteClient(workspace, config).probe(), null, 2)); return;
  }
  throw new Error("Unknown command. Run pi-remote --help");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
