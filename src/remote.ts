import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { deflateSync } from "node:zlib";
import { validateHost, type RemoteConfig, type Workspace } from "./config.js";
import { killProcessGroup, ProcessAbortError, ProcessTimeoutError, runProcess, shellQuote, sshChildEnv, type RunOptions, type RunResult } from "./process.js";
import { sshArgs, sshConfigSignature } from "./ssh-config.js";
import { REMOTE_JSON_SENTINEL, remoteScript } from "./remote-script.js";

const COMPRESSED_REMOTE_SCRIPT = deflateSync(Buffer.from(remoteScript, "utf8")).toString("base64");

/**
 * Single-line ASCII bootstrap free of newlines, backslashes, `$`, or nested double quotes so
 * non-POSIX remote login shells (`fish`, `csh`, `tcsh`, `zsh`, `sh`) invoke Python identically.
 */
export function remotePythonCommand(loop: boolean): string {
  const bootstrap = `import base64,zlib;exec(compile(zlib.decompress(base64.b64decode('${COMPRESSED_REMOTE_SCRIPT}')),'<pi-remote>','exec'))`;
  return loop ? `python3 -u -c "${bootstrap}" --loop` : `python3 -c "${bootstrap}"`;
}

export interface Probe { root: string; home: string; hostname: string; python: string; git: boolean; ripgrep: boolean }
export interface RemoteContextFile { path: string; content: string }
export interface DirectoryEntry { name: string; directory: boolean; symlink: boolean; escaped?: boolean }
export interface RemoteFile { data: string; etag: string }
export interface RemoteTextSlice {
  image: boolean;
  text?: string;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  truncatedByBytes?: boolean;
}
export interface TextOutput {
  text: string;
  exitCode: number;
  truncated: boolean;
  matchLimitReached?: number | null;
  byteTruncated?: boolean;
  linesTruncated?: boolean;
}
export type Runner = (program: string, args: string[], options?: RunOptions) => Promise<RunResult>;

function parseRemoteJson<T>(raw: string): T {
  for (const line of raw.split(/\r?\n/).reverse()) {
    const idx = line.indexOf(REMOTE_JSON_SENTINEL);
    if (idx >= 0) return JSON.parse(line.slice(idx + REMOTE_JSON_SENTINEL.length)) as T;
  }
  return JSON.parse(raw) as T;
}

class PooledWorker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  busy = true;
  dead = false;
  idleTimer: NodeJS.Timeout | undefined;
  private stdoutBuf = "";
  private stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private escalation: NodeJS.Timeout | undefined;
  private waiter: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;

  constructor(readonly host: string, readonly key: string, args: string[]) {
    this.child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env: sshChildEnv() });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.stdoutBuf += chunk;
      if (this.stdoutBuf.length > 24 * 1024 * 1024) {
        this.fail(new Error("Process output exceeds size limit"));
        return;
      }
      this.drainLines();
    });
    this.child.stderr.on("data", (data: Buffer) => {
      this.stderrChunks.push(data);
      this.stderrBytes += data.length;
      while (this.stderrChunks.length > 1 && this.stderrBytes - this.stderrChunks[0]!.length >= 65_536) {
        this.stderrBytes -= this.stderrChunks.shift()!.length;
      }
    });
    this.child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") this.fail(error);
    });
    this.closed = new Promise<void>(resolve => {
      this.child.on("error", error => {
        this.dead = true;
        this.clearTimers();
        this.waiter?.reject(error);
        this.waiter = undefined;
        resolve();
      });
      this.child.on("close", (code, signal) => {
        this.dead = true;
        this.exitCode = code;
        this.exitSignal = signal;
        this.clearTimers();
        if (this.waiter) {
          const pending = this.waiter;
          this.waiter = undefined;
          pending.reject(this.exitError());
        }
        resolve();
      });
    });
  }

  private exitError(): Error {
    const stderr = Buffer.concat(this.stderrChunks).subarray(-65_536).toString().trim();
    const stdout = this.stdoutBuf.trim();
    if (this.exitSignal) return new Error(`SSH ${this.host} terminated by ${this.exitSignal}${stderr ? `: ${stderr}` : ""}`);
    return new Error(`SSH ${this.host} exited ${this.exitCode ?? 255}: ${stderr || stdout || "connection closed"}`);
  }

  private drainLines() {
    while (this.waiter) {
      const nl = this.stdoutBuf.indexOf("\n");
      if (nl < 0) return;
      const line = this.stdoutBuf.slice(0, nl).replace(/\r$/, "");
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      const idx = line.indexOf(REMOTE_JSON_SENTINEL);
      if (idx < 0) continue;
      const pending = this.waiter;
      this.waiter = undefined;
      pending.resolve(line.slice(idx + REMOTE_JSON_SENTINEL.length));
    }
  }

  private fail(error: Error) {
    const pending = this.waiter;
    this.waiter = undefined;
    this.terminate();
    pending?.reject(error);
  }

  private clearTimers() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    if (this.escalation) { clearTimeout(this.escalation); this.escalation = undefined; }
  }

  nextMessage<T>(timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      this.terminate();
      return Promise.reject(new ProcessAbortError(signal.reason));
    }
    if (this.dead) return Promise.reject(this.exitError());
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.waiter = undefined;
        this.terminate();
        reject(new ProcessAbortError(signal?.reason));
      };
      const timer = setTimeout(() => {
        this.waiter = undefined;
        this.terminate();
        reject(new ProcessTimeoutError(timeoutMs));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiter = {
        resolve: payload => {
          cleanup();
          try { resolve(JSON.parse(payload) as T); }
          catch {
            this.terminate();
            reject(new Error("Invalid remote response. Ensure Python 3 is installed and SSH startup scripts do not print to stdout."));
          }
        },
        reject: error => { cleanup(); reject(error); },
      };
      this.drainLines();
    });
  }

  send(payload: Record<string, unknown>) {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  ref() {
    this.child.ref();
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      (stream as unknown as { ref?: () => void }).ref?.();
    }
  }

  unref() {
    this.child.unref();
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      (stream as unknown as { unref?: () => void }).unref?.();
    }
  }

  terminate() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined; }
    if (this.dead) return;
    this.dead = true;
    try { this.child.stdin.end(); } catch { /* Ignore closed pipe. */ }
    this.escalation = killProcessGroup(this.child.pid, sig => this.child.kill(sig));
  }
}

const activePools = new Set<RemotePool>();
let exitHooksInstalled = false;
const cleanupAllPoolsOnExit = () => {
  for (const pool of activePools) pool.terminateAllSync();
};
function trackPool(pool: RemotePool) {
  activePools.add(pool);
  if (!exitHooksInstalled) {
    exitHooksInstalled = true;
    process.on("beforeExit", cleanupAllPoolsOnExit);
    process.on("exit", cleanupAllPoolsOnExit);
  }
}
function untrackPool(pool: RemotePool) {
  activePools.delete(pool);
  if (activePools.size === 0 && exitHooksInstalled) {
    exitHooksInstalled = false;
    process.off("beforeExit", cleanupAllPoolsOnExit);
    process.off("exit", cleanupAllPoolsOnExit);
  }
}

/** Session-scoped pool of warm SSH Python RPC processes; never shared through module globals. */
export class RemotePool {
  private readonly workers = new Set<PooledWorker>();
  private readonly waitersByKey = new Map<string, Array<() => void>>();
  private readonly trackedConfigs = new Map<string, { signature: string; files: string[] }>();
  private nextRequestId = 0;
  private closed = false;
  private readonly idleTimeoutMs: number;
  private readonly maxIdlePerKey: number;
  private readonly maxConcurrentPerKey: number;

  constructor(options: { idleTimeoutMs?: number; maxIdlePerKey?: number; maxConcurrentPerKey?: number } = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.maxConcurrentPerKey = Math.max(1, options.maxConcurrentPerKey ?? 4);
    this.maxIdlePerKey = Math.min(options.maxIdlePerKey ?? 2, this.maxConcurrentPerKey);
    trackPool(this);
  }

  terminateAllSync() {
    for (const worker of this.workers) worker.terminate();
  }

  get size(): number {
    return this.workers.size;
  }

  private notifyWaiters(key?: string) {
    if (key !== undefined) {
      const queue = this.waitersByKey.get(key);
      const next = queue?.shift();
      if (queue && queue.length === 0) this.waitersByKey.delete(key);
      next?.();
      return;
    }
    for (const [k, queue] of [...this.waitersByKey.entries()]) {
      this.waitersByKey.delete(k);
      for (const wake of queue) wake();
    }
  }

  private countActiveForKey(key: string): number {
    let count = 0;
    for (const candidate of this.workers) {
      if (!candidate.dead && candidate.key === key) count++;
    }
    return count;
  }

  private waitForSlot(key: string, deadlineMs: number, signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Remote connection pool is closed"));
    if (signal?.aborted) return Promise.reject(new ProcessAbortError(signal.reason));
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) return Promise.reject(new ProcessTimeoutError(0));

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const queue = this.waitersByKey.get(key) ?? [];
      if (!this.waitersByKey.has(key)) this.waitersByKey.set(key, queue);

      const removeFromQueue = () => {
        const idx = queue.indexOf(wake);
        if (idx >= 0) queue.splice(idx, 1);
        if (queue.length === 0 && this.waitersByKey.get(key) === queue) this.waitersByKey.delete(key);
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        removeFromQueue();
        cleanup();
        reject(new ProcessAbortError(signal?.reason));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        removeFromQueue();
        cleanup();
        reject(new ProcessTimeoutError(remainingMs));
      }, remainingMs);
      const wake = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(wake);
    });
  }

  private async computeKey(host: string, config: RemoteConfig): Promise<string> {
    const configKey = config.sshConfigPath ?? "";
    const previous = this.trackedConfigs.get(configKey);
    let sig = await sshConfigSignature(config, previous?.files);
    if (previous && sig.signature !== previous.signature) {
      sig = await sshConfigSignature(config);
    }
    this.trackedConfigs.set(configKey, sig);
    return `${host}\0${configKey}\0${config.connectTimeoutSeconds}\0${sig.signature}`;
  }

  private release(worker: PooledWorker) {
    worker.busy = false;
    if (this.closed || worker.dead) {
      worker.terminate();
      this.workers.delete(worker);
      this.notifyWaiters(worker.key);
      return;
    }
    // If a queued request is already waiting for this key, wake it before parking idle.
    if ((this.waitersByKey.get(worker.key)?.length ?? 0) > 0) {
      this.notifyWaiters(worker.key);
      return;
    }
    let idleCount = 0;
    for (const candidate of this.workers) {
      if (!candidate.busy && !candidate.dead && candidate.key === worker.key) idleCount++;
    }
    if (idleCount > this.maxIdlePerKey) {
      worker.terminate();
      this.workers.delete(worker);
      this.notifyWaiters(worker.key);
      return;
    }
    worker.unref();
    worker.idleTimer = setTimeout(() => {
      worker.terminate();
      this.workers.delete(worker);
      this.notifyWaiters(worker.key);
    }, this.idleTimeoutMs);
    worker.idleTimer.unref();
  }

  async rpc<T>(workspace: Workspace, config: RemoteConfig, op: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    validateHost(workspace.host);
    if (this.closed) throw new Error("Remote connection pool is closed");
    if (signal?.aborted) throw new ProcessAbortError(signal.reason);
    const key = await this.computeKey(workspace.host, config);
    for (const stale of [...this.workers]) {
      if (!stale.busy && stale.host === workspace.host && stale.key !== key) {
        stale.terminate();
        this.workers.delete(stale);
        this.notifyWaiters(stale.key);
      }
    }
    const timeoutMs = config.commandTimeoutSeconds * 1000;
    const deadlineMs = Date.now() + timeoutMs;
    const executeOnce = async (allowReuse: boolean): Promise<{ value: T; reused: boolean }> => {
      let worker: PooledWorker | undefined;
      let reused = false;
      while (!worker) {
        if (this.closed) throw new Error("Remote connection pool is closed");
        if (signal?.aborted) throw new ProcessAbortError(signal.reason);
        if (allowReuse) {
          for (const candidate of this.workers) {
            if (!candidate.busy && !candidate.dead && candidate.key === key) {
              worker = candidate;
              reused = true;
              break;
            }
          }
        }
        if (worker) break;
        if (!allowReuse && this.countActiveForKey(key) >= this.maxConcurrentPerKey) {
          for (const candidate of this.workers) {
            if (!candidate.busy && !candidate.dead && candidate.key === key) {
              candidate.terminate();
              this.workers.delete(candidate);
              break;
            }
          }
        }
        if (this.countActiveForKey(key) < this.maxConcurrentPerKey) break;
        await this.waitForSlot(key, deadlineMs, signal);
      }

      const stepTimeoutMs = () => {
        const left = deadlineMs - Date.now();
        if (left <= 0) throw new ProcessTimeoutError(timeoutMs);
        return left;
      };

      if (worker) {
        if (worker.idleTimer) { clearTimeout(worker.idleTimer); worker.idleTimer = undefined; }
        worker.busy = true;
        worker.ref();
      } else {
        const args = [...sshArgs(config), "--", workspace.host, remotePythonCommand(true)];
        worker = new PooledWorker(workspace.host, key, args);
        this.workers.add(worker);
        void worker.closed.then(() => {
          this.workers.delete(worker!);
          this.notifyWaiters(key);
        });
        try {
          const handshake = await worker.nextMessage<{ ready?: boolean }>(stepTimeoutMs(), signal);
          if (!handshake?.ready) throw new Error("Invalid remote worker handshake");
        } catch (error) {
          worker.terminate();
          this.workers.delete(worker);
          this.notifyWaiters(key);
          throw error;
        }
      }
      const id = ++this.nextRequestId;
      try {
        worker.send({ ...params, root: workspace.path, timeout: config.commandTimeoutSeconds, op, id });
        const response = await worker.nextMessage<{ id?: number; ok: boolean; value: T; error?: string }>(stepTimeoutMs(), signal);
        if (response.id !== id) {
          worker.terminate();
          this.workers.delete(worker);
          this.notifyWaiters(key);
          throw new Error("Mismatched remote RPC response");
        }
        this.release(worker);
        if (!response.ok) throw new Error(response.error || "Remote operation failed");
        return { value: response.value, reused };
      } catch (error) {
        if (worker.busy) {
          worker.terminate();
          this.workers.delete(worker);
          this.notifyWaiters(key);
        } else if (worker.dead) {
          this.workers.delete(worker);
          this.notifyWaiters(key);
        }
        throw Object.assign(error as Error, { _reusedWorkerDead: reused && worker.dead });
      }
    };

    try {
      return (await executeOnce(true)).value;
    } catch (error) {
      const canRetry = (error as { _reusedWorkerDead?: boolean })._reusedWorkerDead && !signal?.aborted && !(error instanceof ProcessTimeoutError) && (op !== "write" || params.etag !== undefined);
      if (!canRetry) throw error;
      return (await executeOnce(false)).value;
    }
  }

  async closeHost(host?: string): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const worker of [...this.workers]) {
      if (!host || worker.host === host) {
        worker.terminate();
        this.workers.delete(worker);
        this.notifyWaiters(worker.key);
        closing.push(worker.closed);
      }
    }
    if (!host) this.notifyWaiters();
    await Promise.allSettled(closing);
  }

  async close(): Promise<void> {
    this.closed = true;
    untrackPool(this);
    this.notifyWaiters();
    await this.closeHost();
  }
}

export class RemoteClient {
  constructor(
    readonly workspace: Workspace,
    readonly config: RemoteConfig,
    private readonly runner: Runner = runProcess,
    private readonly pool?: RemotePool,
  ) {
    validateHost(workspace.host);
  }
  async rpc<T>(op: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    if (this.pool && this.runner === runProcess) {
      return this.pool.rpc<T>(this.workspace, this.config, op, params, signal);
    }
    const result = await this.runner("ssh", [...sshArgs(this.config), "--", this.workspace.host, remotePythonCommand(false)], {
      input: JSON.stringify({ ...params, root: this.workspace.path, timeout: this.config.commandTimeoutSeconds, op }), signal,
      timeoutMs: this.config.commandTimeoutSeconds * 1000,
    });
    if (result.exitCode !== 0) throw new Error(`SSH ${this.workspace.host} exited ${result.exitCode}: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`);
    let response: { ok: boolean; value: T; error?: string };
    try { response = parseRemoteJson(result.stdout.toString()); }
    catch { throw new Error("Invalid remote response. Ensure Python 3 is installed and SSH startup scripts do not print to stdout."); }
    if (!response.ok) throw new Error(response.error || "Remote operation failed");
    return response.value;
  }
  probe(signal?: AbortSignal) { return this.rpc<Probe>("probe", {}, signal); }
  context(signal?: AbortSignal) { return this.rpc<RemoteContextFile[]>("context", {}, signal); }
  list(path = ".", signal?: AbortSignal) { return this.rpc<DirectoryEntry[]>("list", { path }, signal); }
  read(path: string, signal?: AbortSignal) { return this.rpc<RemoteFile>("read", { path }, signal); }
  readLines(path: string, options: { offset?: number; limit?: number; maxBytes?: number } = {}, signal?: AbortSignal) {
    return this.rpc<RemoteTextSlice>("read_lines", { path, ...options }, signal);
  }
  write(path: string, content: Buffer | string, etag?: string | null, signal?: AbortSignal) {
    return this.rpc<{ etag: string }>("write", { path, data: Buffer.from(content).toString("base64"), ...(etag !== undefined ? { etag } : {}) }, signal);
  }
  async bash(command: string, cwd = this.workspace.path, options: RunOptions = {}): Promise<RunResult> {
    // Expand ~/ using the remote shell's HOME, never the local user's home.
    const remoteCwd = cwd === "~" ? '"$HOME"' : cwd.startsWith("~/") ? `"$HOME"/${shellQuote(cwd.slice(2))}` : shellQuote(cwd);
    const script = `cd -- ${remoteCwd} || exit $?\n${command}`;
    const result = await this.runner("ssh", [...sshArgs(this.config), "--", this.workspace.host, `exec bash -lc ${shellQuote(script)}`], {
      timeoutMs: this.config.commandTimeoutSeconds * 1000, ...options,
    });
    if (result.exitCode === 255) {
      throw new Error(`SSH connection failed: ${result.stderr.toString().trim() || "SSH exited with status 255"}`);
    }
    return result;
  }
}
