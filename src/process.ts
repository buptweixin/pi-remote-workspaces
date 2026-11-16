import { spawn } from "node:child_process";

export interface RunOptions {
  input?: string | Buffer;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  onData?: (data: Buffer) => void;
  collect?: boolean;
}

export interface RunResult { stdout: Buffer; stderr: Buffer; exitCode: number }

/** No local shell: config aliases and arguments never become shell source. */
export function runProcess(program: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    const stdout: Buffer[] = [];
    let stderr = Buffer.alloc(0);
    let size = 0;
    let failure: Error | undefined;
    let escalation: NodeJS.Timeout | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      const kill = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch { /* Already exited. */ }
      };
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 500);
      escalation.unref();
    };
    const abort = () => stop(new Error("Operation aborted", { cause: options.signal?.reason }));
    const timer = setTimeout(() => stop(new Error(`Operation timed out after ${options.timeoutMs ?? 30_000} ms`)), options.timeoutMs ?? 30_000);
    const clean = () => {
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", abort);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (data: Buffer) => {
      options.onData?.(data);
      if (options.collect !== false) {
        size += data.length;
        if (size > (options.maxBytes ?? 24 * 1024 * 1024)) stop(new Error("Process output exceeds size limit"));
        else stdout.push(data);
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      options.onData?.(data);
      stderr = Buffer.concat([stderr, data]).subarray(-65_536);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") stop(error);
    });
    child.on("error", (error) => { clean(); reject(error); });
    child.on("close", (code, signal) => {
      clean();
      if (failure) reject(failure);
      else if (signal) reject(new Error(`Process terminated by ${signal}`));
      else resolve({ stdout: Buffer.concat(stdout), stderr, exitCode: code ?? 255 });
    });
    child.stdin.end(options.input);
  });
}

export function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("NUL is not allowed in shell arguments");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
