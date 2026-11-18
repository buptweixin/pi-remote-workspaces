import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ConfigStore, SessionBindingStore, sessionStateFile, slugifyWorkspaceId,
  validateConfig, validateHost, type PersistedSessionState, type RemoteConfig, type Workspace,
} from "./config.js";
import { discoverHosts, resolveHost } from "./ssh-config.js";
import { RemoteClient, RemotePool, type Probe } from "./remote.js";

const MAX_EXEC_BYTES = 1024 * 1024;

function readRuntimeVersion(): string {
  for (const rel of ["../package.json", "../manifest.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version) return parsed.version;
    } catch { /* Try next candidate. */ }
  }
  return "0.2.0";
}

const packageVersion = readRuntimeVersion();

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

export interface ControllerOptions {
  store?: ConfigStore;
  sessionStore?: SessionBindingStore;
  client?: (workspace: Workspace, config: RemoteConfig) => RemoteClient;
}

export interface ApiResult {
  status: number;
  body: unknown;
}

export class DashboardController {
  readonly store: ConfigStore;
  readonly sessionStore: SessionBindingStore;
  readonly pool = new RemotePool();
  private readonly controllers = new Set<AbortController>();
  private readonly clientFactory?: (workspace: Workspace, config: RemoteConfig) => RemoteClient;

  constructor(options: ControllerOptions = {}) {
    this.store = options.store ?? new ConfigStore();
    this.sessionStore = options.sessionStore ?? new SessionBindingStore(sessionStateFile(this.store.file));
    this.clientFactory = options.client;
  }

  private clientFor(workspace: Workspace, config: RemoteConfig): RemoteClient {
    return this.clientFactory?.(workspace, config) ?? new RemoteClient(workspace, config, undefined, this.pool);
  }

  async getSessionBinding(sessionId: string): Promise<{ sessionId: string; state: PersistedSessionState }> {
    if (!sessionId) return { sessionId: "", state: { mode: "local" } };
    return { sessionId, state: (await this.sessionStore.get(sessionId)) ?? { mode: "local" } };
  }

  async bindSession(sessionId: string, workspaceId: string, signal?: AbortSignal): Promise<{ sessionId: string; state: PersistedSessionState; probe: Probe }> {
    if (!sessionId) throw new Error("当前没有活动的聊天会话，请先打开或新建一个会话。");
    const config = await this.store.read();
    const workspace = config.workspaces.find(w => w.id === workspaceId);
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    const probe = await this.clientFor(workspace, config).probe(signal);
    const state: PersistedSessionState = {
      mode: "remote",
      binding: { workspace: { ...workspace, path: probe.root }, probe },
    };
    await this.sessionStore.set(sessionId, state);
    return { sessionId, state, probe };
  }

  async unbindSession(sessionId: string): Promise<{ sessionId: string; state: PersistedSessionState }> {
    if (!sessionId) return { sessionId: "", state: { mode: "local" } };
    const state: PersistedSessionState = { mode: "local" };
    await this.sessionStore.set(sessionId, state);
    return { sessionId, state };
  }

  async dispatch(pathname: string, method: string, input: Record<string, unknown> = {}, upstreamSignal?: AbortSignal): Promise<ApiResult> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const onAbort = () => controller.abort(upstreamSignal?.reason);
    upstreamSignal?.addEventListener("abort", onAbort, { once: true });
    if (upstreamSignal?.aborted) controller.abort(upstreamSignal.reason);

    try {
      const config = await this.store.read();
      if (pathname === "/api/state" && method === "GET") {
        return { status: 200, body: { version: packageVersion, config, inventory: await discoverHosts(config), configFile: this.store.file } };
      }
      if (pathname === "/api/config" && method === "PUT") {
        const sshConfigPath = typeof input.sshConfigPath === "string" ? input.sshConfigPath.trim() : input.sshConfigPath;
        const next = await this.store.update(current => validateConfig({
          ...current,
          sshConfigPath: sshConfigPath || undefined,
          connectTimeoutSeconds: input.connectTimeoutSeconds,
          commandTimeoutSeconds: input.commandTimeoutSeconds,
        }));
        await this.pool.closeHost();
        return { status: 200, body: next };
      }
      if (pathname === "/api/workspaces" && method === "POST") {
        const host = typeof input.host === "string" ? input.host.trim() : input.host;
        const path = typeof input.path === "string" ? input.path.trim() : input.path;
        const name = typeof input.name === "string" ? input.name.trim() : input.name;
        const requestedId = typeof input.id === "string" ? input.id.trim() : input.id;
        let created!: Workspace;
        await this.store.update(current => {
          const id = requestedId || (typeof host === "string" && typeof path === "string" ? slugifyWorkspaceId(host, path, typeof name === "string" ? name : undefined, current.workspaces.map(w => w.id)) : randomBytes(6).toString("hex"));
          created = { id, name, host, path } as Workspace;
          return { ...current, workspaces: [...current.workspaces, created] };
        });
        return { status: 201, body: created };
      }
      if (pathname === "/api/resolve" && method === "POST") {
        const host = typeof input.host === "string" ? input.host.trim() : input.host;
        validateHost(host);
        const resolved = await resolveHost(host, config, controller.signal);
        // Do not expose unrelated environment/proxy command content in the dashboard.
        return { status: 200, body: Object.fromEntries(["hostname", "user", "port", "identityfile", "proxyjump"].map(key => [key, resolved[key]])) };
      }
      const match = /^\/api\/workspaces\/([a-zA-Z0-9_-]+)(?:\/(probe|list|read|write|search|git|exec))?$/.exec(pathname);
      if (!match) return { status: 404, body: { error: "Unknown endpoint" } };
      const workspace = config.workspaces.find(w => w.id === match[1]);
      if (!workspace) return { status: 404, body: { error: "Workspace not found" } };
      if (!match[2] && method === "DELETE") {
        await this.store.update(current => ({ ...current, workspaces: current.workspaces.filter(w => w.id !== workspace.id) }));
        await this.sessionStore.clearWorkspace(workspace.id);
        await this.pool.closeHost(workspace.host);
        return { status: 200, body: { ok: true } };
      }
      if (!match[2] && method === "PUT") {
        const updated = {
          id: workspace.id,
          name: typeof input.name === "string" ? input.name.trim() : input.name,
          host: typeof input.host === "string" ? input.host.trim() : input.host,
          path: typeof input.path === "string" ? input.path.trim() : input.path,
        } as Workspace;
        await this.store.update(current => ({ ...current, workspaces: current.workspaces.map(w => w.id === workspace.id ? updated : w) }));
        if (updated.host !== workspace.host) await this.pool.closeHost(workspace.host);
        return { status: 200, body: updated };
      }
      if (method !== "POST") return { status: 405, body: { error: "Use POST for remote operations" } };
      const client = this.clientFor(workspace, config);
      const signal = controller.signal;
      let result: unknown;
      switch (match[2]) {
        case "probe": result = await client.probe(signal); break;
        case "list": result = await client.list(requiredString(input.path ?? ".", "path"), signal); break;
        case "read": result = await client.read(requiredString(input.path, "path"), signal); break;
        case "write": {
          const etag = input.etag === null ? null : requiredString(input.etag, "etag");
          result = await client.write(requiredString(input.path, "path"), requiredString(input.content, "content"), etag, signal);
          break;
        }
        case "search": result = await client.rpc(input.mode === "find" ? "find" : "grep", { ...input, pattern: requiredString(input.pattern, "pattern") }, signal); break;
        case "git": result = await client.rpc("git", { action: input.action }, signal); break;
        case "exec": {
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          const execAbort = new AbortController();
          const onUpstreamAbort = () => execAbort.abort(signal.reason);
          signal.addEventListener("abort", onUpstreamAbort, { once: true });
          let exceeded = false;
          try {
            const output = await client.bash(requiredString(input.command, "command"), workspace.path, {
              signal: execAbort.signal,
              collect: false,
              onData: chunk => {
                totalBytes += chunk.length;
                if (totalBytes > MAX_EXEC_BYTES) {
                  exceeded = true;
                  execAbort.abort();
                  return;
                }
                chunks.push(chunk);
              },
            });
            result = { text: Buffer.concat(chunks).toString("utf8"), exitCode: output.exitCode };
          } catch (error) {
            if (exceeded) throw new Error("Process output exceeds 1 MiB limit");
            throw error;
          } finally {
            signal.removeEventListener("abort", onUpstreamAbort);
          }
          break;
        }
        default: throw new Error("Unknown operation");
      }
      return { status: 200, body: result };
    } finally {
      upstreamSignal?.removeEventListener("abort", onAbort);
      this.controllers.delete(controller);
    }
  }

  async close(): Promise<void> {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    await this.pool.close();
  }
}
