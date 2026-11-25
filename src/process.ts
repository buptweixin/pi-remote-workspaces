import { spawn, spawnSync } from "node:child_process";

export interface RunOptions {
  input?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  onData?: (data: Buffer) => void;
  onStdout?: (data: Buffer) => void;
  collect?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult { stdout: Buffer; stderr: Buffer; exitCode: number }

export class ProcessAbortError extends Error {
  constructor(cause?: unknown) { super("Operation aborted", { cause }); this.name = "ProcessAbortError"; }
}
export class ProcessTimeoutError extends Error {
  constructor(readonly timeoutMs: number) { super(`Operation timed out after ${timeoutMs} ms`); this.name = "ProcessTimeoutError"; }
}

const MAX_STDERR_BYTES = 65_536;
let cachedLaunchdAuthSock: string | null | undefined;

/**
 * Resolve child environment for OpenSSH. PI-Desktop's plugin utility process omits
 * SSH_AUTH_SOCK from its minimal environment; on macOS, recover launchd's agent socket.
 */
export function sshChildEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (baseEnv.SSH_AUTH_SOCK || process.platform !== "darwin") return baseEnv;
  if (cachedLaunchdAuthSock === undefined) {
    try {
      const probe = spawnSync("/bin/launchctl", ["getenv", "SSH_AUTH_SOCK"], { encoding: "utf8", timeout: 1000 });
      const sock = probe.status === 0 ? probe.stdout.trim() : "";
      cachedLaunchdAuthSock = sock || null;
    } catch {
      cachedLaunchdAuthSock = null;
    }
  }
  return cachedLaunchdAuthSock ? { ...baseEnv, SSH_AUTH_SOCK: cachedLaunchdAuthSock } : baseEnv;
}

export function killProcessGroup(pid: number | undefined, killChild: (signal: NodeJS.Signals) => void): NodeJS.Timeout {
  const send = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && pid) process.kill(-pid, signal);
      else killChild(signal);
    } catch { /* Already exited. */ }
  };
  send("SIGTERM");
  const escalation = setTimeout(() => send("SIGKILL"), 500);
  escalation.unref();
  return escalation;
}

/** No local shell: config aliases and arguments never become shell source. */
export function runProcess(program: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  if (options.signal?.aborted) return Promise.reject(new ProcessAbortError(options.signal.reason));
  return new Promise((resolve, reject) => {
    const env = options.env ?? (program === "ssh" ? sshChildEnv() : process.env);
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env });
    const stdout: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let size = 0;
    let failure: Error | undefined;
    let escalation: NodeJS.Timeout | undefined;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      escalation = killProcessGroup(child.pid, signal => child.kill(signal));
    };
    const abort = () => stop(new ProcessAbortError(options.signal?.reason));
    const timer = setTimeout(() => stop(new ProcessTimeoutError(timeoutMs)), timeoutMs);
    const clean = () => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", abort);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (data: Buffer) => {
      options.onStdout?.(data);
      options.onData?.(data);
      if (options.collect !== false) {
        size += data.length;
        if (size > (options.maxBytes ?? 24 * 1024 * 1024)) stop(new Error("Process output exceeds size limit"));
        else stdout.push(data);
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      options.onData?.(data);
      stderrChunks.push(data);
      stderrBytes += data.length;
      while (stderrChunks.length > 1 && stderrBytes - stderrChunks[0]!.length >= MAX_STDERR_BYTES) {
        stderrBytes -= stderrChunks.shift()!.length;
      }
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop(error);
    });
    child.on("error", (error) => { clean(); reject(error); });
    child.on("close", (code, signal) => {
      clean();
      if (failure) reject(failure);
      else if (signal) reject(new Error(`Process terminated by ${signal}`));
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderrChunks).subarray(-MAX_STDERR_BYTES), exitCode: code ?? 255 });
    });
    child.stdin.end(options.input);
  });
}

export function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("NUL is not allowed in shell arguments");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
