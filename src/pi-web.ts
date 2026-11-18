import { posix } from "node:path";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { PersistedSessionState } from "./config.js";
import type { DirectoryEntry, RemoteClient, TextOutput } from "./remote.js";

export const PI_WEB_SESSION_LIVENESS_KEY = "@agegr/pi-web/session-liveness/v1";

export const PI_WEB_COMMAND_STATUS_KEYS = [
  "command:/remote",
  "command:/remote files",
  "command:/remote git",
  "command:/remote test",
  "command:/remote unbind",
] as const;

export interface PiWebLivenessProvider {
  name: string;
  sessionId: string;
  sessionFile?: string;
  isActive(): boolean;
}

export interface PiWebLivenessRegistry {
  version: 1;
  register(provider: PiWebLivenessProvider): () => void;
}

function getPiWebLivenessRegistry(): PiWebLivenessRegistry | undefined {
  const candidate = (globalThis as Record<PropertyKey, unknown>)[Symbol.for(PI_WEB_SESSION_LIVENESS_KEY)];
  if (!candidate || typeof candidate !== "object") return undefined;
  const reg = candidate as Partial<PiWebLivenessRegistry>;
  if (reg.version === 1 && typeof reg.register === "function") {
    return reg as PiWebLivenessRegistry;
  }
  return undefined;
}

/**
 * True when running inside `@agegr/pi-web` (which initializes its global
 * session-liveness v1 registry at server startup) or when explicitly forced.
 */
export function isPiWebHost(): boolean {
  if (process.env.PI_REMOTE_FORCE_PI_WEB_UI === "1") return true;
  if (process.env.PI_REMOTE_FORCE_PI_WEB_UI === "0") return false;
  return Boolean(getPiWebLivenessRegistry());
}

/**
 * Manages a session-scoped liveness lease in `pi-web` so active background
 * dashboards or interactive SSH dialogs prevent 10-minute idle eviction.
 */
export class PiWebLivenessLease {
  private currentKey = "";
  private releaseFn: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly isActive: () => boolean,
  ) {}

  sync(ctx: Pick<ExtensionContext, "sessionManager">): void {
    const registry = getPiWebLivenessRegistry();
    if (!registry) return;
    let sessionId = "";
    let sessionFile = "";
    try {
      sessionId = ctx.sessionManager?.getSessionId?.()?.trim() ?? "";
      sessionFile = ctx.sessionManager?.getSessionFile?.()?.trim() ?? "";
    } catch {
      return;
    }
    if (!sessionId) return;
    const nextKey = `${sessionId}\0${sessionFile}`;
    if (this.currentKey === nextKey && this.releaseFn) return;
    this.dispose();
    try {
      this.releaseFn = registry.register({
        name: this.name,
        sessionId,
        ...(sessionFile ? { sessionFile } : {}),
        isActive: () => Boolean(this.isActive()),
      });
      this.currentKey = nextKey;
    } catch {
      // Never block extension startup if host liveness contract changes.
      this.releaseFn = undefined;
      this.currentKey = "";
    }
  }

  dispose(): void {
    const release = this.releaseFn;
    this.releaseFn = undefined;
    this.currentKey = "";
    try {
      release?.();
    } catch { /* Ignore release errors on shutdown. */ }
  }
}

export function compactRemotePath(root: string, home?: string): string {
  const cleanHome = home?.replace(/\/+$/, "") ?? "";
  let display = root;
  if (cleanHome && root === cleanHome) {
    display = "~";
  } else if (cleanHome && root.startsWith(`${cleanHome}/`)) {
    display = `~${root.slice(cleanHome.length)}`;
  }
  if (display.length > 36) {
    return `…${display.slice(-35)}`;
  }
  return display;
}

function compactSingleLine(text: string, maxChars = 32): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars - 1)}…`;
}

export interface PiWebStatusSnapshot {
  statuses: Record<string, string | undefined>;
  widget: string[] | undefined;
}

export function buildPiWebStatusSnapshot(state: PersistedSessionState): PiWebStatusSnapshot {
  const statuses: Record<string, string | undefined> = {
    "pi-remote": undefined,
    "command:/remote": undefined,
    "command:/remote files": undefined,
    "command:/remote git": undefined,
    "command:/remote test": undefined,
    "command:/remote unbind": undefined,
  };

  if (state.mode === "local") {
    statuses["command:/remote"] = "SSH: 本地";
    return { statuses, widget: undefined };
  }

  if (state.mode === "blocked") {
    statuses["command:/remote"] = `⚠ SSH 不可用 · ${compactSingleLine(state.error, 28)}`;
    statuses["command:/remote unbind"] = "切回本地";
    return {
      statuses,
      // 4 lines (> DEFAULT_EXPANDED_WIDGET_LINES=3 in pi-web) keeps the widget
      // collapsed as a compact shelf trigger until the user clicks to expand.
      widget: [
        "\x1b[31m⚠ SSH 远程工作区不可用\x1b[0m",
        `原因: ${state.error}`,
        "保护: 已阻止工具回退到本地目录执行",
        "恢复: 点击「切回本地」或点击状态栏切换其他工作区",
      ],
    };
  }

  const { workspace, probe } = state.binding;
  statuses["command:/remote"] = `● SSH ${workspace.host} · ${compactRemotePath(probe.root, probe.home)}`;
  statuses["command:/remote files"] = "远程文件";
  if (probe.git) statuses["command:/remote git"] = "Git 状态";
  statuses["command:/remote test"] = "探测连接";
  statuses["command:/remote unbind"] = "切回本地";

  return {
    statuses,
    widget: [
      `\x1b[32m●\x1b[0m \x1b[1m${workspace.name}\x1b[0m [${workspace.id}]`,
      `主机: \x1b[36m${workspace.host}\x1b[0m (${probe.hostname})`,
      `目录: \x1b[33m${probe.root}\x1b[0m`,
      `环境: Python ${probe.python} · git ${probe.git ? "\x1b[32m✓\x1b[0m" : "\x1b[90m×\x1b[0m"} · rg ${probe.ripgrep ? "\x1b[32m✓\x1b[0m" : "\x1b[90m×\x1b[0m"}`,
    ],
  };
}

export function applyStatusPresentation(
  ui: Pick<ExtensionUIContext, "setStatus" | "setWidget">,
  state: PersistedSessionState,
  options: { nativeMode: boolean; piWeb?: boolean },
): void {
  const piWeb = options.piWeb ?? (options.nativeMode && isPiWebHost());
  if (options.nativeMode && piWeb) {
    const snapshot = buildPiWebStatusSnapshot(state);
    for (const [key, value] of Object.entries(snapshot.statuses)) {
      ui.setStatus(key, value);
    }
    ui.setWidget("pi-remote", snapshot.widget);
    return;
  }

  for (const key of PI_WEB_COMMAND_STATUS_KEYS) {
    ui.setStatus(key, undefined);
  }
  const text = state.mode === "remote"
    ? `SSH ${state.binding.workspace.host} · ${state.binding.probe.root}`
    : state.mode === "blocked"
      ? `SSH blocked: ${state.error}`
      : undefined;
  ui.setStatus("pi-remote", text);
  if (options.nativeMode) {
    ui.setWidget("pi-remote", text ? [text, "/remote — 切换工作区 / 远程文件 / Git / 配置"] : undefined);
  }
}

export function normalizeWorkspaceRelPath(input: string, root?: string): string {
  const trimmed = input.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === "." || trimmed === "/") return ".";
  let candidate = trimmed;
  if (root) {
    const cleanRoot = root.replace(/\/+$/, "");
    if (candidate === cleanRoot) return ".";
    if (candidate.startsWith(`${cleanRoot}/`)) {
      candidate = candidate.slice(cleanRoot.length + 1);
    }
  }
  const normalized = posix.normalize(candidate).replace(/^\/+/, "");
  if (!normalized || normalized === ".") return ".";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`路径不能超出远程工作区根目录：${input}`);
  }
  return normalized;
}

const MAX_INLINE_EDITOR_BYTES = 512 * 1024;

export async function openRemoteFileEditor(
  client: RemoteClient,
  relPath: string,
  ui: Pick<ExtensionUIContext, "editor" | "confirm" | "notify">,
): Promise<{ saved: boolean }> {
  const file = await client.read(relPath);
  const raw = Buffer.from(file.data, "base64");
  if (raw.subarray(0, 8192).includes(0)) {
    ui.notify(`二进制文件 (${raw.length} bytes)，无法在文本编辑器中打开：${relPath}`, "warning");
    return { saved: false };
  }
  if (raw.length > MAX_INLINE_EDITOR_BYTES) {
    const preview = raw.subarray(0, 32 * 1024).toString("utf8");
    await ui.editor(
      `${client.workspace.host}:${relPath}（文件较大 ${(raw.length / 1024).toFixed(1)} KiB · 只读前 32 KiB 预览）`,
      preview,
    );
    return { saved: false };
  }
  const original = raw.toString("utf8");
  const edited = await ui.editor(`${client.workspace.host}:${relPath}（修改后保存写入远端，取消不保存）`, original);
  if (edited === undefined) return { saved: false };
  if (edited === original) {
    ui.notify(`文件未修改：${relPath}`, "info");
    return { saved: false };
  }
  try {
    await client.write(relPath, edited, file.etag);
    ui.notify(`已保存远程文件：${relPath}`, "info");
    return { saved: true };
  } catch (error) {
    const message = (error as Error).message;
    if (/changed remotely|conflict/i.test(message)) {
      const overwrite = await ui.confirm("远程文件冲突", `远程文件 ${relPath} 在编辑期间已被修改，是否强制覆盖保存？`);
      if (overwrite) {
        await client.write(relPath, edited);
        ui.notify(`已覆盖保存远程文件：${relPath}`, "info");
        return { saved: true };
      }
      ui.notify(`已取消覆盖保存：${relPath}`, "warning");
      return { saved: false };
    }
    throw error;
  }
}

export async function browseRemoteFiles(
  client: RemoteClient,
  root: string,
  hasRipgrep: boolean,
  ui: Pick<ExtensionUIContext, "select" | "input" | "editor" | "confirm" | "notify">,
  initialPath = ".",
): Promise<void> {
  let currentDir = normalizeWorkspaceRelPath(initialPath, root);
  if (currentDir !== ".") {
    const stat = await client.rpc<{ exists: boolean; directory: boolean }>("stat", { path: currentDir });
    if (!stat.exists) throw new Error(`远程路径不存在：${currentDir}`);
    if (!stat.directory) {
      await openRemoteFileEditor(client, currentDir, ui);
      return;
    }
  }

  while (true) {
    const entries = await client.list(currentDir);
    const upItem = currentDir !== "." ? "⬆ 返回上级目录 (..)" : undefined;
    const findItem = hasRipgrep ? "🔍 按文件名搜索 (find)" : undefined;
    const grepItem = hasRipgrep ? "🔎 按内容搜索 (grep)" : undefined;
    const createItem = "➕ 在当前目录新建文件";

    const entryLabels = entries.map((entry: DirectoryEntry) => {
      if (entry.escaped) return `⚠ ${entry.name} (越界软链 · 已阻止)`;
      if (entry.directory) return `📁 ${entry.name}/${entry.symlink ? " (symlink)" : ""}`;
      return `📄 ${entry.name}${entry.symlink ? " (symlink)" : ""}`;
    });

    const topActions = [upItem, findItem, grepItem, createItem].filter((v): v is string => Boolean(v));
    const displayDir = currentDir === "." ? root : `${root.replace(/\/+$/, "")}/${currentDir}`;
    const choice = await ui.select(
      `远程文件 · ${client.workspace.host}:${displayDir}`,
      [...topActions, ...entryLabels],
    );
    if (!choice) return;

    if (choice === upItem) {
      const parent = posix.dirname(currentDir);
      currentDir = !parent || parent === "." ? "." : parent;
      continue;
    }

    if (choice === createItem) {
      const rawName = await ui.input("新建远程文件（相对当前目录）", "例如 notes.md 或 sub/new.ts");
      const trimmed = rawName?.trim();
      if (!trimmed) continue;
      const targetRel = normalizeWorkspaceRelPath(currentDir === "." ? trimmed : `${currentDir}/${trimmed}`, root);
      const initialContent = await ui.editor(`新建远程文件 · ${client.workspace.host}:${targetRel}`, "");
      if (initialContent === undefined) continue;
      await client.write(targetRel, initialContent, null);
      ui.notify(`已创建远程文件：${targetRel}`, "info");
      continue;
    }

    if (choice === findItem) {
      const pattern = (await ui.input("搜索远程文件名 (find)", "例如 *.ts 或 package.json"))?.trim();
      if (!pattern) continue;
      const output = await client.rpc<TextOutput>("find", { path: currentDir, pattern, limit: 80 });
      const hits = output.text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith("["));
      if (!hits.length) {
        ui.notify(`未找到匹配「${pattern}」的文件`, "info");
        continue;
      }
      const picked = await ui.select(`文件名搜索结果 (${hits.length}) · ${pattern}`, hits);
      if (!picked) continue;
      const targetRel = normalizeWorkspaceRelPath(currentDir === "." ? picked : `${currentDir}/${picked}`, root);
      const stat = await client.rpc<{ exists: boolean; directory: boolean }>("stat", { path: targetRel });
      if (stat.directory) currentDir = targetRel;
      else if (stat.exists) await openRemoteFileEditor(client, targetRel, ui);
      continue;
    }

    if (choice === grepItem) {
      const pattern = (await ui.input("搜索远程文件内容 (grep)", "输入关键字或正则表达式"))?.trim();
      if (!pattern) continue;
      const output = await client.rpc<TextOutput>("grep", { path: currentDir, pattern, limit: 80 });
      const lines = output.text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith("["));
      if (!lines.length) {
        ui.notify(`未找到包含「${pattern}」的内容`, "info");
        continue;
      }
      const picked = await ui.select(`内容搜索结果 · ${pattern}（选择打开对应文件）`, lines);
      if (!picked) continue;
      const match = /^(.+?):\d+:/.exec(picked);
      const filePart = match ? match[1]! : picked;
      const targetRel = normalizeWorkspaceRelPath(filePart, root);
      await openRemoteFileEditor(client, targetRel, ui);
      continue;
    }

    const idx = entryLabels.indexOf(choice);
    if (idx < 0) continue;
    const entry = entries[idx]!;
    if (entry.escaped) {
      ui.notify(`软链接 ${entry.name} 指向工作区外部，已被安全策略阻止`, "warning");
      continue;
    }
    const nextRel = normalizeWorkspaceRelPath(currentDir === "." ? entry.name : `${currentDir}/${entry.name}`, root);
    if (entry.directory) {
      currentDir = nextRel;
    } else {
      await openRemoteFileEditor(client, nextRel, ui);
    }
  }
}

export interface GitStatusChange {
  code: string;
  path: string;
  raw: string;
}

export interface ParsedGitStatus {
  branch: string;
  changes: GitStatusChange[];
}

export function parseGitShortStatus(text: string): ParsedGitStatus {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  let branch = "HEAD";
  const changes: GitStatusChange[] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      branch = line.slice(3).trim() || "HEAD";
      continue;
    }
    const code = line.slice(0, 2).trim() || "?";
    const rest = line.slice(3).trim();
    const arrowIdx = rest.indexOf(" -> ");
    const filePath = arrowIdx >= 0 ? rest.slice(arrowIdx + 4).trim() : rest;
    if (filePath) changes.push({ code, path: filePath, raw: line });
  }
  return { branch, changes };
}

export async function inspectRemoteGit(
  client: RemoteClient,
  root: string,
  ui: Pick<ExtensionUIContext, "select" | "editor" | "confirm" | "notify">,
): Promise<void> {
  while (true) {
    const statusOut = await client.rpc<TextOutput>("git", { action: "status" });
    const parsed = parseGitShortStatus(statusOut.text);
    const diffAllItem = "📄 查看全部未暂存 Diff (git diff)";
    const stagedAllItem = "📦 查看全部暂存区 Diff (git diff --cached)";
    const refreshItem = "🔄 刷新 Git 状态";

    const changeLabels = parsed.changes.map(c => `📝 [${c.code}] ${c.path}`);
    const cleanNotice = parsed.changes.length === 0 ? ["✓ 工作区干净（无未提交变更）"] : [];
    const choice = await ui.select(
      `远程 Git · ${client.workspace.host} (${parsed.branch})`,
      [...cleanNotice, ...changeLabels, diffAllItem, stagedAllItem, refreshItem],
    );
    if (!choice || choice === cleanNotice[0]) return;
    if (choice === refreshItem) continue;

    if (choice === diffAllItem || choice === stagedAllItem) {
      const action = choice === stagedAllItem ? "staged" : "diff";
      const diffOut = await client.rpc<TextOutput>("git", { action });
      const content = diffOut.text.trim();
      if (!content) {
        ui.notify(action === "staged" ? "暂存区没有 Diff 变更" : "当前没有未暂存的 Diff 变更", "info");
        continue;
      }
      await ui.editor(
        `${client.workspace.host} · git ${action === "staged" ? "diff --cached" : "diff"}（只读预览，点取消返回）`,
        content,
      );
      continue;
    }

    const idx = changeLabels.indexOf(choice);
    if (idx < 0) continue;
    const target = parsed.changes[idx]!;
    const relPath = normalizeWorkspaceRelPath(target.path, root);
    const viewDiff = `📄 查看文件 Diff (${relPath})`;
    const editFile = !target.code.includes("D") ? `✏️ 打开/编辑远程文件 (${relPath})` : undefined;
    const backItem = "⬅ 返回 Git 状态列表";
    const subChoice = await ui.select(
      `Git 变更 · [${target.code}] ${relPath}`,
      [viewDiff, ...(editFile ? [editFile] : []), backItem],
    );
    if (!subChoice || subChoice === backItem) continue;
    if (subChoice === editFile) {
      await openRemoteFileEditor(client, relPath, ui);
      continue;
    }
    if (subChoice === viewDiff) {
      const [unstaged, staged] = await Promise.all([
        client.rpc<TextOutput>("git", { action: "diff", path: relPath }),
        client.rpc<TextOutput>("git", { action: "staged", path: relPath }),
      ]);
      const combined = [
        unstaged.text.trim() ? `# Unstaged diff (${relPath})\n${unstaged.text.trim()}` : "",
        staged.text.trim() ? `# Staged diff (${relPath})\n${staged.text.trim()}` : "",
      ].filter(Boolean).join("\n\n");
      if (!combined) {
        if (target.code === "??") {
          await openRemoteFileEditor(client, relPath, ui);
        } else {
          ui.notify(`${relPath} 暂无文本 Diff`, "info");
        }
        continue;
      }
      await ui.editor(`Diff · ${client.workspace.host}:${relPath}（只读预览，点取消返回）`, combined);
    }
  }
}
