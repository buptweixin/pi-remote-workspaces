import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

export interface Workspace { id: string; name: string; host: string; path: string }
export interface RemoteConfig {
  version: 1;
  sshConfigPath?: string;
  connectTimeoutSeconds: number;
  commandTimeoutSeconds: number;
  workspaces: Workspace[];
}
export const defaults = (): RemoteConfig => ({ version: 1, connectTimeoutSeconds: 10, commandTimeoutSeconds: 120, workspaces: [] });
export function agentDir(): string { return process.env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi/agent"); }
export function configFile(): string { return process.env.PI_REMOTE_CONFIG || resolve(agentDir(), "remote.json"); }

export function validateHost(host: unknown): asserts host is string {
  if (typeof host !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:\-]*$/.test(host) || host.length > 255) {
    throw new Error("Host must be a concrete SSH alias or user@hostname (no patterns, spaces or options)");
  }
}
export function validateConfig(value: unknown): RemoteConfig {
  if (!value || typeof value !== "object") throw new Error("Invalid remote configuration");
  const v = value as RemoteConfig;
  if (v.version !== 1 || !Array.isArray(v.workspaces)) throw new Error("Unsupported remote configuration version");
  for (const field of ["connectTimeoutSeconds", "commandTimeoutSeconds"] as const) {
    if (!Number.isInteger(v[field]) || v[field] < 1 || v[field] > 3600) throw new Error(`${field} must be between 1 and 3600`);
  }
  if (v.sshConfigPath !== undefined && (typeof v.sshConfigPath !== "string" || !v.sshConfigPath.trim() || !v.sshConfigPath.startsWith("/") || /[\0\r\n]/.test(v.sshConfigPath))) {
    throw new Error("sshConfigPath must be an absolute path, or omitted for the system default");
  }
  const ids = new Set<string>();
  for (const w of v.workspaces) {
    if (!w || typeof w.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(w.id) || ids.has(w.id)) throw new Error("Workspace IDs must be unique, using letters, digits, _ or -");
    ids.add(w.id);
    validateHost(w.host);
    if (typeof w.name !== "string" || !w.name.trim() || w.name.length > 120) throw new Error("Workspace name is required (max 120 characters)");
    if (typeof w.path !== "string" || !/^(\/|~(?:\/|$))/.test(w.path) || /[\0\r\n]/.test(w.path)) throw new Error("Remote path must be absolute or start with ~/ (no control characters)");
  }
  return { version: 1, sshConfigPath: v.sshConfigPath, connectTimeoutSeconds: v.connectTimeoutSeconds, commandTimeoutSeconds: v.commandTimeoutSeconds, workspaces: v.workspaces.map(w => ({ id: w.id, name: w.name, host: w.host, path: w.path })) };
}
export class ConfigStore {
  constructor(readonly file = configFile()) {}
  async read(): Promise<RemoteConfig> {
    try { return validateConfig(JSON.parse(await readFile(this.file, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults(); throw error; }
  }
  async update(change: (config: RemoteConfig) => RemoteConfig): Promise<RemoteConfig> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(this.file, { realpath: false, retries: { retries: 30, minTimeout: 20, maxTimeout: 100 }, stale: 10_000 });
    let temporary: string | undefined;
    try {
      const config = validateConfig(change(await this.read()));
      temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.file);
      return config;
    } finally {
      if (temporary) { const { rm } = await import("node:fs/promises"); await rm(temporary, { force: true }); }
      await release();
    }
  }
}
