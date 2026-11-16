import { validateHost, type RemoteConfig, type Workspace } from "./config.js";
import { runProcess, shellQuote, type RunOptions, type RunResult } from "./process.js";
import { sshArgs } from "./ssh-config.js";
import { remoteScript } from "./remote-script.js";

export interface Probe { root: string; home: string; hostname: string; python: string; git: boolean; ripgrep: boolean }
export interface DirectoryEntry { name: string; directory: boolean; symlink: boolean }
export interface RemoteFile { data: string; etag: string }
export interface TextOutput { text: string; exitCode: number; truncated: boolean }
export type Runner = (program: string, args: string[], options?: RunOptions) => Promise<RunResult>;

export class RemoteClient {
  constructor(readonly workspace: Workspace, readonly config: RemoteConfig, private readonly runner: Runner = runProcess) {
    validateHost(workspace.host);
  }
  async rpc<T>(op: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const result = await this.runner("ssh", [...sshArgs(this.config), "--", this.workspace.host, `python3 -c ${shellQuote(remoteScript)}`], {
      input: JSON.stringify({ ...params, root: this.workspace.path, op }), signal,
      timeoutMs: this.config.commandTimeoutSeconds * 1000,
    });
    if (result.exitCode !== 0) throw new Error(`SSH ${this.workspace.host} exited ${result.exitCode}: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`);
    let response: { ok: boolean; value: T; error?: string };
    try { response = JSON.parse(result.stdout.toString()); }
    catch { throw new Error("Invalid remote response. Ensure Python 3 is installed and SSH startup scripts do not print to stdout."); }
    if (!response.ok) throw new Error(response.error || "Remote operation failed");
    return response.value;
  }
  probe(signal?: AbortSignal) { return this.rpc<Probe>("probe", {}, signal); }
  list(path = ".", signal?: AbortSignal) { return this.rpc<DirectoryEntry[]>("list", { path }, signal); }
  read(path: string, signal?: AbortSignal) { return this.rpc<RemoteFile>("read", { path }, signal); }
  write(path: string, content: Buffer | string, etag?: string, signal?: AbortSignal) {
    return this.rpc<{ etag: string }>("write", { path, data: Buffer.from(content).toString("base64"), ...(etag !== undefined ? { etag } : {}) }, signal);
  }
  async bash(command: string, cwd = this.workspace.path, options: RunOptions = {}): Promise<RunResult> {
    // Expand ~/ using the remote shell's HOME, never the local user's home.
    const remoteCwd = cwd === "~" ? '"$HOME"' : cwd.startsWith("~/") ? `"$HOME"/${shellQuote(cwd.slice(2))}` : shellQuote(cwd);
    const script = `cd -- ${remoteCwd} || exit $?\n${command}`;
    const result = await this.runner("ssh", [...sshArgs(this.config), "--", this.workspace.host, `exec bash -lc ${shellQuote(script)}`], {
      timeoutMs: this.config.commandTimeoutSeconds * 1000, ...options,
    });
    if (result.exitCode === 255) throw new Error(`SSH connection failed: ${result.stderr.toString().trim()}`);
    return result;
  }
}
