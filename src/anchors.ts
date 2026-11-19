import { mkdir, realpath, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { configFile, type RemoteConfig, type Workspace } from "./config.js";

const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,80}$/;

function expandHome(target: string): string {
  if (target === "~") return homedir();
  if (target.startsWith("~/")) return resolve(homedir(), target.slice(2));
  return resolve(target);
}

function stripTrailingSep(target: string): string {
  let end = target.length;
  while (end > 1 && (target[end - 1] === "/" || target[end - 1] === sep)) end--;
  return end === target.length ? target : target.slice(0, end);
}

async function canonicalPath(target: string): Promise<string> {
  const resolved = resolve(target);
  try {
    return stripTrailingSep(await realpath(resolved));
  } catch {
    try {
      return stripTrailingSep(join(await realpath(dirname(resolved)), basename(resolved)));
    } catch {
      return stripTrailingSep(resolved);
    }
  }
}

/** Resolve the root directory holding local pi-web anchor directories for remote workspaces. */
export function anchorRootDir(config?: Pick<RemoteConfig, "anchorRoot">, storeFile = configFile()): string {
  const envRoot = process.env.PI_REMOTE_ANCHOR_DIR?.trim();
  if (envRoot) return stripTrailingSep(expandHome(envRoot));
  if (config?.anchorRoot) return stripTrailingSep(resolve(config.anchorRoot));
  const resolvedStore = resolve(storeFile);
  if (resolvedStore === resolve(homedir(), ".pi/agent/remote.json")) {
    return resolve(homedir(), ".pi/remote-workspaces");
  }
  return resolve(dirname(resolvedStore), "remote-workspaces");
}

/** Compute the local anchor directory path for a specific workspace ID. */
export function workspaceAnchorDir(workspaceId: string, config?: Pick<RemoteConfig, "anchorRoot">, storeFile = configFile()): string {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error("Invalid workspace ID for anchor directory");
  }
  return join(anchorRootDir(config, storeFile), workspaceId);
}

/** Ensure the shared remote anchor root directory exists. */
export async function ensureAnchorRoot(config?: Pick<RemoteConfig, "anchorRoot">, storeFile = configFile()): Promise<string> {
  const root = anchorRootDir(config, storeFile);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

/** Ensure the local anchor directory for a specific workspace exists. */
export async function ensureWorkspaceAnchor(workspaceId: string, config?: Pick<RemoteConfig, "anchorRoot">, storeFile = configFile()): Promise<string> {
  const dir = workspaceAnchorDir(workspaceId, config, storeFile);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Ensure the shared anchor root and all configured workspace anchor directories exist. */
export async function syncWorkspaceAnchors(config: RemoteConfig, storeFile = configFile()): Promise<{ root: string; workspaces: Record<string, string> }> {
  const root = await ensureAnchorRoot(config, storeFile);
  const workspaces: Record<string, string> = {};
  for (const workspace of config.workspaces) {
    workspaces[workspace.id] = await ensureWorkspaceAnchor(workspace.id, config, storeFile);
  }
  return { root, workspaces };
}

/** Remove a workspace anchor directory only when it is empty. */
export async function removeWorkspaceAnchorIfEmpty(workspaceId: string, config?: Pick<RemoteConfig, "anchorRoot">, storeFile = configFile()): Promise<void> {
  await rmdir(workspaceAnchorDir(workspaceId, config, storeFile)).catch(() => {});
}

export type AnchorMatch =
  | { kind: "none" }
  | { kind: "picker"; root: string }
  | { kind: "workspace"; workspace: Workspace; dir: string }
  | { kind: "unknown-workspace"; id: string; dir: string };

/** Match a session working directory against the shared picker anchor or a workspace anchor. */
export async function matchAnchorCwd(cwd: string, config: RemoteConfig, storeFile = configFile()): Promise<AnchorMatch> {
  const [canonCwd, canonRoot] = await Promise.all([canonicalPath(cwd), canonicalPath(anchorRootDir(config, storeFile))]);
  if (canonCwd === canonRoot) return { kind: "picker", root: canonRoot };
  if (stripTrailingSep(dirname(canonCwd)) === canonRoot) {
    const id = basename(canonCwd);
    const workspace = config.workspaces.find(w => w.id === id);
    return workspace ? { kind: "workspace", workspace, dir: canonCwd } : { kind: "unknown-workspace", id, dir: canonCwd };
  }
  return { kind: "none" };
}
