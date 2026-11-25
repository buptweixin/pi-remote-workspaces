import { glob, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { validateHost, type RemoteConfig } from "./config.js";
import { runProcess } from "./process.js";

export interface SshHost { alias: string; source: string; line: number }
export interface HostInventory { hosts: SshHost[]; files: string[]; warnings: string[] }

const DISCOVERY_DIRECTIVE = /^\s*"?(?:host|include)"?(?:[\s=]|$)/i;

/** Tokenizes only discovery directives; OpenSSH resolves all actual connection options. */
export function tokens(line: string): string[] {
  const result: string[] = [];
  let token = "", quoted = false, escaped = false, started = false;
  for (const char of line) {
    if (escaped) { token += char; escaped = false; started = true; }
    else if (char === "\\") escaped = true;
    else if (char === '"') { quoted = !quoted; started = true; }
    else if (!quoted && char === "#") break;
    else if (!quoted && (/\s/.test(char) || (char === "=" && result.length === 0))) {
      if (started) { result.push(token); token = ""; started = false; }
    } else { token += char; started = true; }
  }
  if (quoted || escaped) throw new Error("Unterminated SSH config quote or escape");
  if (started) result.push(token);
  if (result[1] === "=") result.splice(1, 1);
  else if (result[1]?.startsWith("=")) result[1] = result[1].slice(1);
  return result;
}

export async function discoverHosts(config: Pick<RemoteConfig, "sshConfigPath">, home = homedir(), systemConfig = "/etc/ssh/ssh_config"): Promise<HostInventory> {
  const inventory: HostInventory = { hosts: [], files: [], warnings: [] };
  const aliases = new Set<string>();
  const active = new Set<string>();
  const seen = new Set<string>();
  const visit = async (file: string, base: string, depth: number) => {
    if (depth > 32 || seen.size > 512) throw new Error("SSH Include depth/file limit exceeded");
    let canonical: string, source: string;
    try { canonical = await realpath(file); source = await readFile(canonical, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") inventory.warnings.push(`${file}: ${(error as Error).message}`);
      return;
    }
    if (active.has(canonical)) { inventory.warnings.push(`Circular SSH Include: ${file}`); return; }
    if (seen.has(canonical)) return;
    active.add(canonical); seen.add(canonical); inventory.files.push(canonical);
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      if (!DISCOVERY_DIRECTIVE.test(line)) continue;
      let parts: string[];
      try { parts = tokens(line); } catch (error) { inventory.warnings.push(`${file}:${index + 1}: ${(error as Error).message}`); continue; }
      const directive = parts.shift()?.toLowerCase();
      if (directive === "host") for (const alias of parts) {
        try { validateHost(alias); } catch { continue; }
        if (!aliases.has(alias)) { aliases.add(alias); inventory.hosts.push({ alias, source: file, line: index + 1 }); }
      }
      if (directive === "include") for (const include of parts) {
        const expanded = include.replace(/^~(?=\/|$)/, home).replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? "");
        const pattern = isAbsolute(expanded) ? expanded : resolve(base, expanded);
        try {
          const matches: string[] = [];
          for await (const match of glob(pattern)) matches.push(match);
          for (const match of matches.sort()) await visit(match, base, depth + 1);
        } catch (error) { inventory.warnings.push(`${file}:${index + 1}: ${(error as Error).message}`); }
      }
    }
    active.delete(canonical);
  };
  // -F explicitly selects one config and disables the system config, just as ssh does.
  if (config.sshConfigPath) await visit(config.sshConfigPath, resolve(home, ".ssh"), 0);
  else {
    await visit(resolve(home, ".ssh/config"), resolve(home, ".ssh"), 0);
    await visit(systemConfig, "/etc/ssh", 0);
  }
  inventory.hosts.sort((a, b) => a.alias.localeCompare(b.alias));
  return inventory;
}

/** Fast fingerprint of active SSH config files so pooled workers rotate when configs change. */
export async function sshConfigSignature(config: Pick<RemoteConfig, "sshConfigPath">, trackedFiles?: readonly string[], home = homedir(), systemConfig = "/etc/ssh/ssh_config"): Promise<{ signature: string; files: string[] }> {
  const candidates = trackedFiles?.length
    ? trackedFiles
    : config.sshConfigPath ? [config.sshConfigPath] : [resolve(home, ".ssh/config"), systemConfig];
  const targets = [...new Set([...candidates, ...candidates.map(file => dirname(file))])];
  const parts = await Promise.all(targets.map(async file => {
    try {
      const info = await stat(file);
      return `${file}:${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch {
      return `${file}:missing`;
    }
  }));
  if (!trackedFiles?.length) {
    try {
      const inventory = await discoverHosts(config, home, systemConfig);
      if (inventory.files.length) return sshConfigSignature(config, inventory.files, home, systemConfig);
    } catch { /* Keep root-level stat signature. */ }
  }
  return { signature: parts.join("|"), files: [...candidates] };
}

export interface HostOptionOverrides {
  hasExplicitStrictHostKeyChecking?: boolean;
  hasExplicitConnectTimeout?: boolean;
  hasExplicitServerAliveInterval?: boolean;
  hasExplicitServerAliveCountMax?: boolean;
}

export function sshArgs(config: RemoteConfig, overrides?: HostOptionOverrides): string[] {
  return [
    ...(config.sshConfigPath ? ["-F", config.sshConfigPath] : []),
    "-T", "-o", "BatchMode=yes",
    ...(overrides?.hasExplicitStrictHostKeyChecking ? [] : ["-o", "StrictHostKeyChecking=yes"]),
    ...(overrides?.hasExplicitConnectTimeout && config.connectTimeoutSeconds === 10 ? [] : ["-o", `ConnectTimeout=${config.connectTimeoutSeconds}`]),
    ...(overrides?.hasExplicitServerAliveInterval ? [] : ["-o", "ServerAliveInterval=15"]),
    ...(overrides?.hasExplicitServerAliveCountMax ? [] : ["-o", "ServerAliveCountMax=3"]),
  ];
}

export async function inspectHostOptionOverrides(host: string, config: RemoteConfig, signal?: AbortSignal): Promise<HostOptionOverrides> {
  validateHost(host);
  const baseArgs = [...(config.sshConfigPath ? ["-F", config.sshConfigPath] : []), "-G", "--", host];
  const result = await runProcess("ssh", baseArgs, { signal, timeoutMs: 5_000 });
  if (result.exitCode) return {};
  const map = new Map<string, string>();
  for (const line of result.stdout.toString("utf8").split(/\r?\n/)) {
    const space = line.indexOf(" ");
    if (space > 0 && !map.has(line.slice(0, space))) {
      map.set(line.slice(0, space), line.slice(space + 1).trim());
    }
  }
  const strict = map.get("stricthostkeychecking")?.toLowerCase();
  const connectTimeout = Number(map.get("connecttimeout") ?? "0");
  const aliveInterval = Number(map.get("serveraliveinterval") ?? "0");
  const aliveCountMax = Number(map.get("serveralivecountmax") ?? "3");
  return {
    // OpenSSH defaults to `ask` when unconfigured; honor explicit `yes`, `no`, or `accept-new` in ssh_config.
    hasExplicitStrictHostKeyChecking: Boolean(strict && strict !== "ask"),
    hasExplicitConnectTimeout: Number.isFinite(connectTimeout) && connectTimeout > 0,
    hasExplicitServerAliveInterval: Number.isFinite(aliveInterval) && aliveInterval > 0,
    hasExplicitServerAliveCountMax: Number.isFinite(aliveInterval) && aliveInterval > 0 && Number.isFinite(aliveCountMax) && aliveCountMax > 0,
  };
}

export async function resolveHost(host: string, config: RemoteConfig, signal?: AbortSignal): Promise<Record<string, string[]>> {
  validateHost(host);
  const overrides = await inspectHostOptionOverrides(host, config, signal).catch(() => ({}));
  const result = await runProcess("ssh", [...sshArgs(config, overrides), "-G", "--", host], { signal, timeoutMs: 10_000 });
  if (result.exitCode) throw new Error(result.stderr.toString() || "ssh -G failed");
  const resolved: Record<string, string[]> = {};
  for (const line of result.stdout.toString().split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) (resolved[line.slice(0, space)] ??= []).push(line.slice(space + 1));
  }
  return resolved;
}
