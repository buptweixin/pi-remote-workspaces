import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export interface Workspace { id: string; name: string; host: string; path: string }
export interface RemoteConfig {
  version: 1;
  sshConfigPath?: string;
  anchorRoot?: string;
  connectTimeoutSeconds: number;
  commandTimeoutSeconds: number;
  workspaces: Workspace[];
}
export interface PersistedProbe {
  root: string;
  home: string;
  hostname: string;
  python: string;
  git: boolean;
  ripgrep: boolean;
}
export interface PersistedBinding {
  workspace: Workspace;
  probe: PersistedProbe;
}
export type PersistedSessionState =
  | { mode: "local" }
  | { mode: "remote"; binding: PersistedBinding }
  | { mode: "blocked"; error: string };

interface SessionStateFile {
  version: 1;
  sessions: Record<string, { state: PersistedSessionState; updatedAt: number }>;
}

const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = 40;
const MAX_SAVED_SESSIONS = 500;

export const defaults = (): RemoteConfig => ({ version: 1, connectTimeoutSeconds: 10, commandTimeoutSeconds: 120, workspaces: [] });
export function agentDir(): string { return process.env.PI_CODING_AGENT_DIR || resolve(homedir(), ".pi/agent"); }
export function configFile(): string { return process.env.PI_REMOTE_CONFIG || resolve(agentDir(), "remote.json"); }
export function sessionStateFile(forConfigFile = configFile()): string {
  return process.env.PI_REMOTE_SESSIONS || resolve(dirname(forConfigFile), "remote-sessions.json");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolveTimer => setTimeout(resolveTimer, ms));
}

/** Cross-process atomic directory lock with race-free rename eviction for stale locks. */
async function acquireFileLock(targetFile: string): Promise<() => Promise<void>> {
  await mkdir(dirname(targetFile), { recursive: true, mode: 0o700 });
  const lockDir = `${targetFile}.lock`;
  const ownerFile = join(lockDir, "owner");
  const token = randomUUID();

  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt++) {
    try {
      await mkdir(lockDir, { mode: 0o700 });
      await writeFile(ownerFile, token, { mode: 0o600 });
      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(lockDir, now, now).catch(() => {});
      }, 2500);
      heartbeat.unref();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        try {
          const currentOwner = await readFile(ownerFile, "utf8");
          if (currentOwner !== token) return;
          const trash = `${lockDir}.rel.${randomUUID()}`;
          await rename(lockDir, trash);
          await rm(trash, { recursive: true, force: true });
        } catch { /* Lock was already cleaned up or superseded after staleness. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await stat(lockDir);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          const staleTrash = `${lockDir}.stale.${randomUUID()}`;
          await rename(lockDir, staleTrash);
          await rm(staleTrash, { recursive: true, force: true });
          continue;
        }
      } catch { /* Concurrent holder released or rotated the lock; retry. */ }
      if (attempt === LOCK_RETRIES) throw new Error(`Timed out waiting for config lock: ${targetFile}`);
      await sleep(20 + Math.floor(Math.random() * 60));
    }
  }
  throw new Error(`Timed out waiting for config lock: ${targetFile}`);
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export function slugifyWorkspaceId(host: string, path: string, name?: string, existingIds: Iterable<string> = []): string {
  const taken = new Set(existingIds);
  const hostSlug = host.replace(/^.*@/, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  const leaf = posix.basename(path.replace(/\/+$/, "")).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  const named = (name ?? "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  const raw = (named && named !== `${hostSlug}-${leaf}` ? named : [hostSlug, leaf].filter(Boolean).join("-")).slice(0, 48).replace(/-+$/g, "");
  const base = raw || `ws-${randomBytes(4).toString("hex")}`;
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const candidate = `${base.slice(0, 72)}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return randomBytes(6).toString("hex");
}

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
  const sshConfigPath = typeof v.sshConfigPath === "string" ? v.sshConfigPath.trim() : v.sshConfigPath;
  if (sshConfigPath !== undefined && (typeof sshConfigPath !== "string" || !sshConfigPath || !sshConfigPath.startsWith("/") || /[\0\r\n]/.test(sshConfigPath))) {
    throw new Error("sshConfigPath must be an absolute path, or omitted for the system default");
  }
  const anchorRoot = typeof v.anchorRoot === "string" ? v.anchorRoot.trim() : v.anchorRoot;
  if (anchorRoot !== undefined && (typeof anchorRoot !== "string" || !anchorRoot || !anchorRoot.startsWith("/") || /[\0\r\n]/.test(anchorRoot))) {
    throw new Error("anchorRoot must be an absolute path, or omitted for the default");
  }
  const ids = new Set<string>();
  for (const w of v.workspaces) {
    if (!w || typeof w.id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(w.id) || ids.has(w.id)) throw new Error("Workspace IDs must be unique, using letters, digits, _ or -");
    ids.add(w.id);
    validateHost(w.host);
    if (typeof w.name !== "string" || !w.name.trim() || w.name.length > 120) throw new Error("Workspace name is required (max 120 characters)");
    if (typeof w.path !== "string" || !/^(\/|~(?:\/|$))/.test(w.path) || /[\0\r\n]/.test(w.path)) throw new Error("Remote path must be absolute or start with ~/ (no control characters)");
  }
  return { version: 1, sshConfigPath, anchorRoot, connectTimeoutSeconds: v.connectTimeoutSeconds, commandTimeoutSeconds: v.commandTimeoutSeconds, workspaces: v.workspaces.map(w => ({ id: w.id, name: w.name.trim(), host: w.host, path: w.path })) };
}

export function parsePersistedSessionState(value: unknown): PersistedSessionState {
  const candidate = value as PersistedSessionState | undefined;
  if (candidate?.mode === "remote") {
    try {
      const checked = validateConfig({ version: 1, connectTimeoutSeconds: 10, commandTimeoutSeconds: 120, workspaces: [candidate.binding?.workspace] });
      const probe = candidate.binding?.probe;
      if (!probe || typeof probe.root !== "string" || !probe.root.startsWith("/") || typeof probe.home !== "string" || !probe.home.startsWith("/")) {
        throw new Error("Invalid saved remote paths");
      }
      return {
        mode: "remote",
        binding: {
          workspace: checked.workspaces[0]!,
          probe: {
            root: probe.root,
            home: probe.home,
            hostname: typeof probe.hostname === "string" ? probe.hostname : checked.workspaces[0]!.host,
            python: typeof probe.python === "string" ? probe.python : "3",
            git: Boolean(probe.git),
            ripgrep: Boolean(probe.ripgrep),
          },
        },
      };
    } catch (error) {
      return { mode: "blocked", error: (error as Error).message };
    }
  }
  if (candidate?.mode === "local") return { mode: "local" };
  if (candidate?.mode === "blocked" && typeof candidate.error === "string" && candidate.error) {
    return { mode: "blocked", error: candidate.error };
  }
  return { mode: "blocked", error: "Invalid saved workspace binding; select a workspace with /remote" };
}

export class ConfigStore {
  constructor(readonly file = configFile()) {}
  async read(): Promise<RemoteConfig> {
    try { return validateConfig(JSON.parse(await readFile(this.file, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults(); throw error; }
  }
  async update(change: (config: RemoteConfig) => RemoteConfig): Promise<RemoteConfig> {
    const release = await acquireFileLock(this.file);
    try {
      const config = validateConfig(change(await this.read()));
      await atomicWriteJson(this.file, config);
      return config;
    } finally {
      await release();
    }
  }
}

/** Durable per-session binding store shared between PI-Desktop's Agent sidecar and Work Panel process. */
export class SessionBindingStore {
  constructor(readonly file = sessionStateFile()) {}

  private async readAll(): Promise<SessionStateFile> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<SessionStateFile>;
      if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !parsed.sessions || typeof parsed.sessions !== "object") {
        return { version: 1, sessions: {} };
      }
      const sessions: SessionStateFile["sessions"] = {};
      for (const [id, entry] of Object.entries(parsed.sessions)) {
        if (!id || !entry || typeof entry !== "object") continue;
        sessions[id] = {
          state: parsePersistedSessionState((entry as { state?: unknown }).state),
          updatedAt: typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
        };
      }
      return { version: 1, sessions };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sessions: {} };
      return { version: 1, sessions: {} };
    }
  }

  async get(sessionId: string): Promise<PersistedSessionState | undefined> {
    if (!sessionId) return undefined;
    const all = await this.readAll();
    return all.sessions[sessionId]?.state;
  }

  async set(sessionId: string, state: PersistedSessionState): Promise<void> {
    if (!sessionId) return;
    const release = await acquireFileLock(this.file);
    try {
      const current = await this.readAll();
      if (state.mode === "local") {
        delete current.sessions[sessionId];
      } else {
        current.sessions[sessionId] = { state: parsePersistedSessionState(state), updatedAt: Date.now() };
      }
      const entries = Object.entries(current.sessions).sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, MAX_SAVED_SESSIONS);
      await atomicWriteJson(this.file, { version: 1, sessions: Object.fromEntries(entries) } satisfies SessionStateFile);
    } finally {
      await release();
    }
  }

  async clearWorkspace(workspaceId: string): Promise<void> {
    const release = await acquireFileLock(this.file);
    try {
      const current = await this.readAll();
      let changed = false;
      for (const [id, entry] of Object.entries(current.sessions)) {
        if (entry.state.mode === "remote" && entry.state.binding.workspace.id === workspaceId) {
          delete current.sessions[id];
          changed = true;
        }
      }
      if (changed) await atomicWriteJson(this.file, current);
    } finally {
      await release();
    }
  }
}
