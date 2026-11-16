import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { ConfigStore, validateConfig, validateHost, type Workspace } from "./config.js";
import { discoverHosts, resolveHost } from "./ssh-config.js";
import { RemoteClient } from "./remote.js";

const packageVersion: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export interface Dashboard { url: string; close(): Promise<void> }
export interface DashboardOptions { store?: ConfigStore; port?: number; client?: (workspace: Workspace, config: Awaited<ReturnType<ConfigStore["read"]>>) => RemoteClient }

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 12 * 1024 * 1024) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
function send(res: ServerResponse, code: number, value: unknown) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

export async function startDashboard(options: DashboardOptions = {}): Promise<Dashboard> {
  const store = options.store ?? new ConfigStore();
  const token = randomBytes(32).toString("hex");
  const controllers = new Set<AbortController>();
  const server = createServer((req, res) => { void handle(req, res); });
  let origin = "";
  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    // Prevent DNS rebinding and browser requests from other origins.
    const requestOrigin = `http://${req.headers.host}`;
    if (!/^127\.0\.0\.1(?::\d{1,5})?$/.test(req.headers.host ?? "") || (req.headers.origin && req.headers.origin !== requestOrigin)) { send(res, 403, { error: "Invalid request origin" }); return; }
    const url = new URL(req.url ?? "/", origin);
    const assets: Record<string, [string, string]> = { "/": ["index.html", "text/html"], "/app.js": ["app.js", "text/javascript"], "/style.css": ["style.css", "text/css"], "/favicon.svg": ["favicon.svg", "image/svg+xml"] };
    const asset = assets[url.pathname];
    if (asset && req.method === "GET") {
      try { res.writeHead(200, { "Content-Type": `${asset[1]}; charset=utf-8` }); res.end(await readFile(new URL(`../public/${asset[0]}`, import.meta.url))); }
      catch { res.end(); }
      return;
    }
    const supplied = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { send(res, 401, { error: "Open the full dashboard URL including its access token" }); return; }
    const controller = new AbortController(); controllers.add(controller);
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    try {
      const config = await store.read();
      if (url.pathname === "/api/state" && req.method === "GET") {
        send(res, 200, { version: packageVersion, config, inventory: await discoverHosts(config), configFile: store.file }); return;
      }
      if (url.pathname === "/api/config" && req.method === "PUT") {
        const input = await body(req);
        const next = await store.update(current => validateConfig({ ...current, sshConfigPath: input.sshConfigPath || undefined, connectTimeoutSeconds: input.connectTimeoutSeconds, commandTimeoutSeconds: input.commandTimeoutSeconds }));
        send(res, 200, next); return;
      }
      if (url.pathname === "/api/workspaces" && req.method === "POST") {
        const input = await body(req);
        const workspace = { id: input.id || randomBytes(6).toString("hex"), name: input.name, host: input.host, path: input.path } as Workspace;
        await store.update(current => ({ ...current, workspaces: [...current.workspaces, workspace] }));
        send(res, 201, workspace); return;
      }
      if (url.pathname === "/api/resolve" && req.method === "POST") {
        const input = await body(req); validateHost(input.host);
        const resolved = await resolveHost(input.host, config, controller.signal);
        // Do not expose unrelated environment/proxy command content in the dashboard.
        send(res, 200, Object.fromEntries(["hostname", "user", "port", "identityfile", "proxyjump"].map(key => [key, resolved[key]]))); return;
      }
      const match = /^\/api\/workspaces\/([a-zA-Z0-9_-]+)(?:\/(probe|list|read|write|search|git|exec))?$/.exec(url.pathname);
      if (!match) { send(res, 404, { error: "Unknown endpoint" }); return; }
      const workspace = config.workspaces.find(w => w.id === match[1]);
      if (!workspace) { send(res, 404, { error: "Workspace not found" }); return; }
      if (!match[2] && req.method === "DELETE") {
        await store.update(current => ({ ...current, workspaces: current.workspaces.filter(w => w.id !== workspace.id) }));
        send(res, 200, { ok: true }); return;
      }
      if (!match[2] && req.method === "PUT") {
        const input = await body(req);
        const updated = { id: workspace.id, name: input.name, host: input.host, path: input.path } as Workspace;
        await store.update(current => ({ ...current, workspaces: current.workspaces.map(w => w.id === workspace.id ? updated : w) }));
        send(res, 200, updated); return;
      }
      if (req.method !== "POST") { send(res, 405, { error: "Use POST for remote operations" }); return; }
      const input = await body(req);
      const client = options.client?.(workspace, config) ?? new RemoteClient(workspace, config);
      const signal = controller.signal;
      let result: unknown;
      switch (match[2]) {
        case "probe": result = await client.probe(signal); break;
        case "list": result = await client.list(requiredString(input.path ?? ".", "path"), signal); break;
        case "read": result = await client.read(requiredString(input.path, "path"), signal); break;
        case "write": {
          const etag = requiredString(input.etag, "etag");
          result = await client.write(requiredString(input.path, "path"), requiredString(input.content, "content"), etag, signal); break;
        }
        case "search": result = await client.rpc(input.mode === "find" ? "find" : "grep", { ...input, pattern: requiredString(input.pattern, "pattern") }, signal); break;
        case "git": result = await client.rpc("git", { action: input.action }, signal); break;
        case "exec": {
          const output = await client.bash(requiredString(input.command, "command"), workspace.path, { signal, maxBytes: 1024 * 1024 });
          result = { text: output.stdout.toString() + output.stderr.toString(), exitCode: output.exitCode }; break;
        }
        default: throw new Error("Unknown operation");
      }
      send(res, 200, result);
    } catch (error) {
      if (!res.destroyed) send(res, 400, { error: (error as Error).message });
    } finally { controllers.delete(controller); }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot determine dashboard port");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/#token=${token}`,
    async close() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
