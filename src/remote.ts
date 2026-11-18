import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { validateHost, type RemoteConfig, type Workspace } from "./config.js";
import { killProcessGroup, ProcessAbortError, ProcessTimeoutError, runProcess, shellQuote, sshChildEnv, type RunOptions, type RunResult } from "./process.js";
import { sshArgs, sshConfigSignature } from "./ssh-config.js";
import { REMOTE_JSON_SENTINEL, remoteScript } from "./remote-script.js";

export interface Probe { root: string; home: string; hostname: string; python: string; git: boolean; ripgrep: boolean }
export interface RemoteContextFile { path: string; content: string }
export interface DirectoryEntry { name: string; directory: boolean; symlink: boolean; escaped?: boolean }
export interface RemoteFile { data: string; etag: string }
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

/** Session-scoped pool of warm SSH Python RPC processes; never shared through module globals. */
export class RemotePool {
  private readonly workers = new Set<PooledWorker>();
  private readonly trackedConfigs = new Map<string, { signature: string; files: string[] }>();
  private nextRequestId = 0;
  private closed = false;
  private readonly idleTimeoutMs: number;
  private readonly maxIdlePerKey: number;
  private readonly onProcessExit = () => { for (const worker of this.workers) worker.terminate(); };

  constructor(options: { idleTimeoutMs?: number; maxIdlePerKey?: number } = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.maxIdlePerKey = options.maxIdlePerKey ?? 2;
    process.once("beforeExit", this.onProcessExit);
    process.once("exit", this.onProcessExit);
  }

  get size(): number {
    return this.workers.size;
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
      return;
    }
    let idleCount = 0;
    for (const candidate of this.workers) {
      if (!candidate.busy && !candidate.dead && candidate.key === worker.key) idleCount++;
    }
    if (idleCount > this.maxIdlePerKey) {
      worker.terminate();
      this.workers.delete(worker);
      return;
    }
    worker.unref();
    worker.idleTimer = setTimeout(() => {
      worker.terminate();
      this.workers.delete(worker);
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
      }
    }
    const timeoutMs = config.commandTimeoutSeconds * 1000;
    const executeOnce = async (allowReuse: boolean): Promise<{ value: T; reused: boolean }> => {
      let worker: PooledWorker | undefined;
      let reused = false;
      if (allowReuse) {
        for (const candidate of this.workers) {
          if (!candidate.busy && !candidate.dead && candidate.key === key) {
            worker = candidate;
            reused = true;
            break;
          }
        }
      }
      if (worker) {
        if (worker.idleTimer) { clearTimeout(worker.idleTimer); worker.idleTimer = undefined; }
        worker.busy = true;
        worker.ref();
      } else {
        const args = [...sshArgs(config), "--", workspace.host, `python3 -u -c ${shellQuote(remoteScript)} --loop`];
        worker = new PooledWorker(workspace.host, key, args);
        this.workers.add(worker);
        void worker.closed.then(() => this.workers.delete(worker!));
        try {
          const handshake = await worker.nextMessage<{ ready?: boolean }>(timeoutMs, signal);
          if (!handshake?.ready) throw new Error("Invalid remote worker handshake");
        } catch (error) {
          worker.terminate();
          this.workers.delete(worker);
          throw error;
        }
      }
      const id = ++this.nextRequestId;
      try {
        worker.send({ ...params, root: workspace.path, timeout: config.commandTimeoutSeconds, op, id });
        const response = await worker.nextMessage<{ id?: number; ok: boolean; value: T; error?: string }>(timeoutMs, signal);
        if (response.id !== id) {
          worker.terminate();
          this.workers.delete(worker);
          throw new Error("Mismatched remote RPC response");
        }
        this.release(worker);
        if (!response.ok) throw new Error(response.error || "Remote operation failed");
        return { value: response.value, reused };
      } catch (error) {
        if (worker.busy) {
          worker.terminate();
          this.workers.delete(worker);
        } else if (worker.dead) {
          this.workers.delete(worker);
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
        closing.push(worker.closed);
      }
    }
    await Promise.allSettled(closing);
  }

  async close(): Promise<void> {
    this.closed = true;
    process.off("beforeExit", this.onProcessExit);
    process.off("exit", this.onProcessExit);
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
    const result = await this.runner("ssh", [...sshArgs(this.config), "--", this.workspace.host, `python3 -c ${shellQuote(remoteScript)}`], {
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
