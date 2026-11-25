// SSH tool override patterns reference pi's MIT-licensed example; see THIRD_PARTY_NOTICES.md.
import { dirname, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  agentDir, ConfigStore, parsePersistedSessionState, SessionBindingStore, sessionStateFile,
  slugifyWorkspaceId, validateHost, type PersistedBinding, type PersistedSessionState, type RemoteConfig, type Workspace,
} from "./config.js";
import { ensureWorkspaceAnchor, matchAnchorCwd, removeWorkspaceAnchorIfEmpty, syncWorkspaceAnchors } from "./anchors.js";
import { discoverHosts } from "./ssh-config.js";
import { RemoteClient, RemotePool, type RemoteContextFile } from "./remote.js";
import {
  bashOperations, createRemoteTools, createStandaloneRemoteTools, getNativeReadonlyToolFactories,
  getNativeToolFactories, hasNativeToolFactories, LOCAL_READONLY_TOOL_NAMES,
  REMOTE_DESKTOP_TOOL_NAMES, REMOTE_DESKTOP_TOOL_SCHEMAS,
} from "./tools.js";
import { startDashboard, type Dashboard } from "./server.js";
import {
  applyStatusPresentation, browseRemoteFiles, inspectRemoteGit, isPiWebHost, PiWebLivenessLease,
} from "./pi-web.js";

const ENTRY = "pi-remote-workspace-v1";
export type Binding = PersistedBinding;
type State = PersistedSessionState;

const SUBCOMMANDS: ReadonlyArray<[string, string]> = [
  ["use ", "绑定已保存的远程工作区"],
  ["files", "在原生弹窗中浏览、搜索与编辑远程文件"],
  ["git", "在原生弹窗中查看远程 Git 状态与 Diff"],
  ["add", "从 SSH config 选择主机并添加工作区"],
  ["edit ", "编辑已保存的远程工作区配置"],
  ["remove ", "删除已保存的远程工作区配置"],
  ["hosts", "重新读取 SSH config 并显示或导入主机"],
  ["anchors", "查看并同步 pi-web 远程锚点目录路径"],
  ["status", "查看当前工作区并检查连接"],
  ["test", "测试当前远程连接与工具可用性"],
  ["web", "打开本会话的独立浏览器工作台"],
  ["local", "取消远程绑定并恢复本地工具"],
];

function isNativePiRuntime(pi: ExtensionAPI): boolean {
  const keys = Reflect.ownKeys(pi as object);
  return hasNativeToolFactories() && !keys.includes("registerAgent") && keys.includes("getSettings");
}

const CONTEXT_BASENAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

/** Each factory owns one session; never share an active host through module globals. */
export default function remoteExtension(pi: ExtensionAPI) {
  const nativeMode = isNativePiRuntime(pi);
  const store = new ConfigStore();
  const sessionStore = new SessionBindingStore(sessionStateFile(store.file));
  const pool = new RemotePool();
  let state: State = { mode: "local" };
  let dashboard: Dashboard | undefined;
  let remoteContextCache: { key: string; files: RemoteContextFile[] } | undefined;
  let activeInteractiveOps = 0;
  let flagApplied = false;
  const liveness = new PiWebLivenessLease("pi-remote", () => Boolean(dashboard) || activeInteractiveOps > 0);
  pi.registerFlag("remote", { description: "Bind this session to a saved remote workspace ID", type: "string" });

  const maybeInvalidateContextPath = (mutatedPath: string) => {
    const clean = mutatedPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const leaf = clean.includes("/") ? clean.slice(clean.lastIndexOf("/") + 1) : clean;
    if (CONTEXT_BASENAMES.has(leaf)) remoteContextCache = undefined;
  };

  const unavailableMessage = (error: string) => `Remote workspace unavailable: ${error}. Use /remote use <id> or /remote local.`;
  const sessionIdOf = (ctx: ExtensionContext): string => {
    try { return ctx.sessionManager?.getSessionId?.() ?? ""; }
    catch { return ""; }
  };
  const withInteractiveLease = async <T>(ctx: ExtensionContext, fn: () => Promise<T>): Promise<T> => {
    liveness.sync(ctx);
    activeInteractiveOps += 1;
    try { return await fn(); }
    finally { activeInteractiveOps = Math.max(0, activeInteractiveOps - 1); }
  };
  const syncToolSet = (names: readonly string[], enabled: boolean) => {
    try {
      const current = pi.getActiveTools();
      const targetSet = new Set<string>(names);
      const withoutTargets = current.filter(name => !targetSet.has(name));
      const next = enabled ? [...withoutTargets, ...names] : withoutTargets;
      if (next.length !== current.length || next.some((name, idx) => name !== current[idx])) {
        pi.setActiveTools(next);
      }
    } catch { /* Host may not expose tool activation outside an active session. */ }
  };
  const syncDesktopTools = () => {
    if (nativeMode) return;
    syncToolSet(REMOTE_DESKTOP_TOOL_NAMES, state.mode !== "local");
  };
  const syncLocalTools = () => {
    if (!nativeMode) return;
    syncToolSet(LOCAL_READONLY_TOOL_NAMES, state.mode === "remote");
  };
  const display = (ctx: ExtensionContext) => {
    liveness.sync(ctx);
    applyStatusPresentation(ctx.ui, state, { nativeMode });
  };
  const persist = async (ctx: ExtensionContext) => {
    if (nativeMode) {
      pi.appendEntry(ENTRY, state);
      syncLocalTools();
    } else {
      await sessionStore.set(sessionIdOf(ctx), state);
      syncDesktopTools();
    }
    display(ctx);
  };
  const ensureIdle = (ctx: ExtensionContext) => { if (!ctx.isIdle()) throw new Error("Wait for the current agent turn to finish before switching workspaces"); };
  const switchToLocal = async (ctx: ExtensionContext, notify = true) => {
    ensureIdle(ctx);
    state = { mode: "local" };
    remoteContextCache = undefined;
    await pool.closeHost();
    await persist(ctx);
    if (notify) ctx.ui.notify(nativeMode ? "已切换到本地工具" : "已取消远程工作区绑定", "info");
  };
  const bind = async (id: string, ctx: ExtensionContext) => {
    ensureIdle(ctx);
    const config = await store.read();
    const workspace = config.workspaces.find(w => w.id === id);
    if (!workspace) throw new Error(`Unknown workspace: ${id}. Add it with /remote add or /remote web.`);
    // Only replace the previous binding after the new workspace is verified.
    const client = new RemoteClient(workspace, config, undefined, pool);
    const probe = await client.probe();
    const contextFiles = await client.context().then(files => ({ ok: true as const, files })).catch(() => ({ ok: false as const, files: [] as RemoteContextFile[] }));
    if (state.mode === "remote" && state.binding.workspace.host !== workspace.host) {
      await pool.closeHost(state.binding.workspace.host);
    }
    remoteContextCache = contextFiles.ok ? { key: `${workspace.host}:${probe.root}`, files: contextFiles.files } : undefined;
    state = { mode: "remote", binding: { workspace: { ...workspace, path: probe.root }, probe } };
    await persist(ctx);
    ctx.ui.notify(`已绑定 ${workspace.name}: ${workspace.host}:${probe.root}`, "info");
  };
  const restore = async (ctx: ExtensionContext): Promise<boolean> => {
    let hasSavedBinding = false;
    if (nativeMode) {
      state = { mode: "local" };
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
        hasSavedBinding = true;
        state = parsePersistedSessionState(entry.data);
      }
      syncLocalTools();
    } else {
      const prevHost = state.mode === "remote" ? state.binding.workspace.host : undefined;
      const saved = await sessionStore.get(sessionIdOf(ctx));
      hasSavedBinding = saved !== undefined;
      state = saved ?? { mode: "local" };
      const nextHost = state.mode === "remote" ? state.binding.workspace.host : undefined;
      if (prevHost && prevHost !== nextHost) await pool.closeHost(prevHost);
      syncDesktopTools();
    }
    if (state.mode !== "remote") remoteContextCache = undefined;
    display(ctx);
    return hasSavedBinding;
  };

  if (nativeMode) {
    for (const factory of getNativeToolFactories()) {
      const local = factory(process.cwd()) as ToolDefinition<any, any>;
      pi.registerTool({
        ...local,
        async execute(id, params, signal, onUpdate, ctx) {
          if (state.mode === "blocked") throw new Error(unavailableMessage(state.error));
          if (state.mode === "local") return (factory(ctx.cwd) as ToolDefinition<any, any>).execute(id, params, signal, onUpdate, ctx);
          const binding = state.binding;
          const client = new RemoteClient(binding.workspace, await store.read(), undefined, pool);
          const tool = createRemoteTools(client, binding.probe, signal, maybeInvalidateContextPath)[local.name]!;
          return tool.execute(id, params, signal, onUpdate, ctx);
        },
      });
    }
    for (const spec of getNativeReadonlyToolFactories()) {
      const base = spec.factory(process.cwd());
      pi.registerTool({
        ...base,
        name: spec.name,
        label: spec.label,
        description: spec.description,
        defaultActive: false,
        async execute(id, params, signal, onUpdate, ctx) {
          if (state.mode === "blocked") throw new Error(unavailableMessage(state.error));
          return spec.factory(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
        },
      });
    }
  } else {
    for (const name of REMOTE_DESKTOP_TOOL_NAMES) {
      const schema = REMOTE_DESKTOP_TOOL_SCHEMAS[name];
      pi.registerTool({
        name,
        label: schema.label,
        description: schema.description,
        parameters: schema.parameters,
        async execute(id, params, signal, onUpdate, ctx) {
          if (state.mode === "local") await restore(ctx);
          if (state.mode === "blocked") throw new Error(unavailableMessage(state.error));
          if (state.mode === "local") {
            throw new Error("当前会话未绑定 SSH 远程工作区。请先执行 /remote use <id> 或在右侧「SSH 远程工作区」面板中绑定。");
          }
          const binding = state.binding;
          const client = new RemoteClient(binding.workspace, await store.read(), undefined, pool);
          const tool = createStandaloneRemoteTools(client, binding.probe, signal, maybeInvalidateContextPath)[name];
          return tool.execute(id, params, signal, onUpdate, ctx);
        },
      });
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const hasSavedBinding = await restore(ctx);
    const config = await store.read().catch(() => undefined);
    if (config) await syncWorkspaceAnchors(config, store.file).catch(() => {});
    const id = pi.getFlag("remote");
    if (!flagApplied && typeof id === "string" && id) {
      flagApplied = true;
      try { await bind(id, ctx); }
      catch (error) {
        state = { mode: "blocked", error: (error as Error).message };
        await persist(ctx);
        ctx.ui.notify(state.error, "error");
      }
      return;
    }
    if (!nativeMode || !config || hasSavedBinding) return;
    const anchor = await matchAnchorCwd(ctx.cwd, config, store.file).catch(() => ({ kind: "none" as const }));
    if (anchor.kind === "workspace") {
      try { await bind(anchor.workspace.id, ctx); }
      catch (error) {
        state = { mode: "blocked", error: (error as Error).message };
        await persist(ctx);
        ctx.ui.notify(state.error, "error");
      }
    } else if (anchor.kind === "unknown-workspace") {
      state = { mode: "blocked", error: `Unknown workspace anchor: ${anchor.id}. Use /remote to select a workspace or /remote local.` };
      await persist(ctx);
      ctx.ui.notify(state.error, "error");
    } else if (anchor.kind === "picker") {
      await withInteractiveLease(ctx, () => openPickerOnStart(ctx, config));
    }
  });
  if (nativeMode) {
    pi.on("session_tree", (_event, ctx) => { void restore(ctx); });
    pi.on("input", (_event, ctx) => {
      if (state.mode !== "blocked") return;
      ctx.ui.notify(unavailableMessage(state.error), "error");
      return { action: "handled" };
    });
    pi.on("user_bash", async () => {
      if (state.mode === "blocked") throw new Error(unavailableMessage(state.error));
      if (state.mode === "local") return;
      const binding = state.binding;
      return { operations: bashOperations(new RemoteClient(binding.workspace, await store.read(), undefined, pool), binding.probe.root) };
    });
  }
  pi.on("session_shutdown", async () => {
    const running = dashboard;
    dashboard = undefined;
    liveness.dispose();
    await Promise.allSettled([running?.close(), pool.close()]);
  });
  pi.on("tool_call", event => {
    if (nativeMode) {
      if (state.mode === "blocked") return { block: true, terminate: true, reason: unavailableMessage(state.error) };
      if (state.mode === "remote" && event.toolName === "powershell") {
        return { block: true, reason: "This SSH workspace uses bash. Use the bash tool for remote commands." };
      }
      return;
    }
    if (state.mode === "blocked" && (REMOTE_DESKTOP_TOOL_NAMES as readonly string[]).includes(event.toolName)) {
      return { block: true, reason: unavailableMessage(state.error) };
    }
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (!nativeMode) await restore(ctx);
    const loadRemoteContext = async (host: string, root: string, workspace: Binding["workspace"]) => {
      const cacheKey = `${host}:${root}`;
      if (remoteContextCache?.key === cacheKey) return remoteContextCache.files;
      try {
        const files = await new RemoteClient(workspace, await store.read(), undefined, pool).context();
        remoteContextCache = { key: cacheKey, files };
        return files;
      } catch {
        // Do not poison cache on transient connection hiccups; retry on a later turn.
        return [];
      }
    };

    if (!nativeMode) {
      const desktopEvent = event as unknown as { systemPrompt?: string };
      const basePrompt = desktopEvent.systemPrompt ?? "";
      if (state.mode === "local") return;
      if (state.mode === "blocked") {
        return { systemPrompt: `${basePrompt}\n\n# SSH Remote Workspace (Unavailable)\n${unavailableMessage(state.error)}` };
      }
      const { workspace, probe } = state.binding;
      const files = await loadRemoteContext(workspace.host, probe.root, workspace);
      const section = [
        "# SSH Remote Workspace (Pi Remote)",
        `Host: ${workspace.host} (${probe.hostname})`,
        `Remote working directory: ${probe.root}`,
        `This session is bound to the SSH remote workspace above while keeping local tools available:`,
        `- Use \`remote_read\`, \`remote_write\`, \`remote_edit\`, \`remote_bash\`, \`remote_ls\`, \`remote_find\`, and \`remote_grep\` for all operations on the remote project (${workspace.host}:${probe.root}). Pass remote paths or paths relative to ${probe.root}.`,
        `- Local built-in tools (\`Read\`, \`Write\`, \`Edit\`, \`Bash\`, \`Glob\`, \`Grep\`) still operate on the local machine (${ctx.cwd}) and remain available when local inspection or cross-machine work is needed.`,
        `- Remote file tools enforce containment inside ${probe.root}, including symlink targets. \`remote_bash\` executes on ${workspace.host} with the SSH user's privileges. Remote ripgrep: ${probe.ripgrep ? "available" : "not installed (automatic Python/git fallback active)"}.`,
        ...files.map(file => `\n## Remote Project Context (${file.path})\n\n${file.content.trim()}`),
      ].join("\n");
      return { systemPrompt: `${basePrompt}\n\n${section}` };
    }

    if (state.mode === "blocked") {
      event.systemPromptOptions.contextFiles = [];
      event.systemPromptOptions.selectedTools = [];
      event.systemPromptOptions.sections.ssh_workspace = unavailableMessage(state.error);
      return;
    }
    if (state.mode === "local") return;
    const { workspace, probe } = state.binding;
    const files = await loadRemoteContext(workspace.host, probe.root, workspace);
    const globalDir = resolve(agentDir());
    const globalContext = event.systemPromptOptions.contextFiles.filter(file => dirname(resolve(file.path)) === globalDir);
    event.systemPromptOptions.cwd = probe.root;
    event.systemPromptOptions.contextFiles = [...globalContext, ...files];
    event.systemPromptOptions.sections.ssh_workspace = [
      `Host: ${workspace.host} (${probe.hostname})`,
      `Current working directory: ${probe.root}`,
      `All read, write, edit, bash, grep, find and ls calls operate on this SSH workspace. Use remote paths or paths relative to ${probe.root}.`,
      `File tools are restricted to ${probe.root}, including symlink targets. bash and ! commands execute on the remote host with the SSH user's privileges.`,
      `grep/find use remote ripgrep (${probe.ripgrep ? "available" : "not installed; automatic Python/git fallback active"}). Do not invoke local-only tools to modify this workspace.`,
      `Read-only local tools (local_read, local_ls, local_find, local_grep) are also available to inspect files and directories on the local machine (${ctx.cwd}).`,
    ].join("\n");
  });

  const openWeb = async (ctx: ExtensionContext) => {
    dashboard ??= await startDashboard({ store, sessionStore });
    liveness.sync(ctx);
    const url = state.mode === "remote" ? `${dashboard.url}&workspace=${encodeURIComponent(state.binding.workspace.id)}` : dashboard.url;
    if (nativeMode && isPiWebHost()) {
      ctx.ui.notify(`Pi Remote 独立远程工作台：${url}`, "info");
    } else if (nativeMode) {
      // Plain text widgets/dialogs work in both TUI and pi-web; no terminal component required.
      ctx.ui.setWidget("pi-remote-dashboard", ["Pi Remote 配置与文件管理", url]);
      pi.sendMessage({ customType: "pi-remote-dashboard", content: `Pi Remote 配置与文件管理：${url}`, display: true });
      ctx.ui.notify(url, "info");
    } else {
      ctx.ui.notify(`Pi Remote 管理界面：${url}（也可直接使用右侧工作面板「SSH 远程工作区」视图）`, "info");
    }
  };
  const formatWorkspaceChoice = (workspace: Workspace, activeId?: string) => (
    `${workspace.id === activeId ? "● " : ""}${workspace.name} — ${workspace.host}:${workspace.path} [${workspace.id}]`
  );
  const add = async (ctx: ExtensionContext, presetHost?: string): Promise<boolean> => {
    const config = await store.read();
    let host = presetHost;
    if (!host) {
      const inventory = await discoverHosts(config);
      const manual = "手动输入 SSH 主机";
      const selected = await ctx.ui.select("选择 SSH 主机（动态读取 config）", [...inventory.hosts.map(h => h.alias), manual]);
      if (!selected) return false;
      host = (selected === manual ? await ctx.ui.input("SSH 主机", "例如 dev 或 user@example.com") : selected)?.trim();
    }
    if (!host) return false;
    validateHost(host);
    const rawPath = await ctx.ui.input("远程项目目录", "例如 ~/projects/my-app");
    const path = rawPath?.trim();
    if (!path) return false;
    const rawName = await ctx.ui.input("工作区名称", `${host}:${path}`);
    if (rawName === undefined) return false;
    const name = rawName.trim() || `${host}:${path}`;
    const updated = await store.update(current => {
      const id = slugifyWorkspaceId(host!, path, rawName.trim() || undefined, current.workspaces.map(w => w.id));
      return { ...current, workspaces: [...current.workspaces, { id, name, host: host!, path }] };
    });
    const workspace = updated.workspaces.at(-1)!;
    await ensureWorkspaceAnchor(workspace.id, updated, store.file).catch(() => {});
    ctx.ui.notify(`已保存 ${workspace.name} (${workspace.id})`, "info");
    await bind(workspace.id, ctx);
    return true;
  };
  const edit = async (ctx: ExtensionCommandContext, targetId?: string) => {
    const config = await store.read();
    if (!config.workspaces.length) {
      ctx.ui.notify("当前还没有已保存的远程工作区，请先添加。", "info");
      await add(ctx);
      return;
    }
    let target = targetId ? config.workspaces.find(w => w.id === targetId) : undefined;
    if (targetId && !target) throw new Error(`Unknown workspace: ${targetId}`);
    if (!target) {
      const labels = config.workspaces.map(w => `${w.name} — ${w.host}:${w.path} [${w.id}]`);
      const picked = await ctx.ui.select("选择要编辑的远程工作区", labels);
      if (!picked) return;
      target = config.workspaces[labels.indexOf(picked)];
    }
    if (!target) return;
    const rawHost = await ctx.ui.input(`SSH 主机（留空保持 ${target.host}）`, target.host);
    if (rawHost === undefined) return;
    const nextHost = rawHost.trim() || target.host;
    validateHost(nextHost);
    const rawPath = await ctx.ui.input(`远程项目目录（留空保持 ${target.path}）`, target.path);
    if (rawPath === undefined) return;
    const nextPath = rawPath.trim() || target.path;
    const rawName = await ctx.ui.input(`工作区名称（留空保持 ${target.name}）`, target.name);
    if (rawName === undefined) return;
    const nextName = rawName.trim() || target.name;

    const updated = { id: target.id, name: nextName, host: nextHost, path: nextPath };
    await store.update(current => ({
      ...current,
      workspaces: current.workspaces.map(w => w.id === target!.id ? updated : w),
    }));
    if (nextHost !== target.host) await pool.closeHost(target.host);
    remoteContextCache = undefined;
    if (state.mode === "remote" && state.binding.workspace.id === target.id) {
      await bind(target.id, ctx);
    } else {
      ctx.ui.notify(`已更新工作区 ${updated.name} (${updated.id})`, "info");
    }
  };
  const remove = async (id: string, ctx: ExtensionContext) => {
    const config = await store.read();
    const target = config.workspaces.find(w => w.id === id);
    if (!target) throw new Error(`Unknown workspace: ${id}`);
    if (state.mode === "remote" && state.binding.workspace.id === id) {
      await switchToLocal(ctx, false);
    }
    await store.update(current => ({ ...current, workspaces: current.workspaces.filter(w => w.id !== id) }));
    await sessionStore.clearWorkspace(id);
    await removeWorkspaceAnchorIfEmpty(id, config, store.file);
    ctx.ui.notify(`已删除工作区配置 ${target.name} (${target.id})`, "info");
  };
  const showAnchors = async (ctx: ExtensionContext) => {
    const config = await store.read();
    const synced = await syncWorkspaceAnchors(config, store.file);
    const lines = [
      "Pi Remote · pi-web 独立远程锚点目录（无需绑定本地代码项目）",
      "",
      "共享选服目录（打开后首次发消息或输入 / 自动弹窗选服）：",
      synced.root,
      "",
      "工作区直连目录（在 pi-web 中打开对应目录即可自动绑定）：",
      ...(config.workspaces.length
        ? config.workspaces.map(w => `- ${w.name} [${w.id}]: ${synced.workspaces[w.id]}`)
        : ["- （暂无工作区；可用 /remote add 或 /remote web 添加）"]),
    ];
    if (nativeMode) {
      pi.sendMessage({ customType: "pi-remote-anchors", content: lines.join("\n"), display: true });
    }
    ctx.ui.notify(`锚点目录已同步：${synced.root}`, "info");
  };
  const openPickerOnStart = async (ctx: ExtensionContext, config: RemoteConfig) => {
    if (!ctx.hasUI) {
      state = { mode: "blocked", error: "Opened shared remote anchor without UI. Use --remote <id>, /remote use <id>, or open a workspace anchor directory." };
      display(ctx);
      return;
    }
    const workspaceItems = config.workspaces.map(w => formatWorkspaceChoice(w));
    const actions = ["➕ 添加远程工作区", "🌐 浏览器配置与文件管理", "🔌 暂不绑定（仅本地）"];
    const choice = await ctx.ui.select("Pi Remote · 选择本会话的 SSH 工作区", [...workspaceItems, ...actions]);
    if (!choice) {
      state = { mode: "blocked", error: "未选择 SSH 工作区；点击底边栏或输入 /remote 选择工作区，或 /remote local 切换到本地" };
      display(ctx);
      return;
    }
    const index = workspaceItems.indexOf(choice);
    if (index >= 0) {
      try { await bind(config.workspaces[index]!.id, ctx); }
      catch (error) {
        state = { mode: "blocked", error: (error as Error).message };
        await persist(ctx);
        ctx.ui.notify(state.error, "error");
      }
      return;
    }
    if (choice === "➕ 添加远程工作区") {
      try {
        const bound = await add(ctx);
        if (!bound && state.mode === "local") {
          state = { mode: "blocked", error: "未完成工作区添加；点击底边栏或输入 /remote 重试" };
          display(ctx);
        }
      } catch (error) {
        state = { mode: "blocked", error: (error as Error).message };
        await persist(ctx);
        ctx.ui.notify(state.error, "error");
      }
      return;
    }
    if (choice === "🌐 浏览器配置与文件管理") {
      await openWeb(ctx);
      state = { mode: "blocked", error: "请在管理界面创建工作区后，点击底边栏或输入 /remote 选择绑定" };
      display(ctx);
      return;
    }
    if (choice === "🔌 暂不绑定（仅本地）") {
      await switchToLocal(ctx, true);
    }
  };
  const ensureBoundForModal = async (ctx: ExtensionCommandContext): Promise<Binding | undefined> => {
    if (state.mode === "blocked") throw new Error(state.error);
    if (state.mode === "remote") return state.binding;
    if (!ctx.hasUI) throw new Error("当前未绑定远程工作区，请先执行 /remote use <id>。");
    const currentBinding = (): Binding | undefined => state.mode === "remote" ? state.binding : undefined;
    const config = await store.read();
    if (!config.workspaces.length) {
      const createNow = await ctx.ui.confirm("尚未配置远程工作区", "当前还没有已保存的 SSH 远程工作区，是否现在新建一个？");
      if (createNow) await add(ctx);
      return currentBinding();
    }
    const labels = config.workspaces.map(w => `${w.name} — ${w.host}:${w.path} [${w.id}]`);
    const createOption = "➕ 新建远程工作区";
    const chosen = await ctx.ui.select("请先选择要连接的 SSH 远程工作区", [...labels, createOption]);
    if (!chosen) return undefined;
    if (chosen === createOption) {
      await add(ctx);
    } else {
      const idx = labels.indexOf(chosen);
      if (idx >= 0) await bind(config.workspaces[idx]!.id, ctx);
    }
    return currentBinding();
  };
  const runProbeNotify = async (ctx: ExtensionContext) => {
    if (state.mode === "blocked") throw new Error(state.error);
    if (state.mode === "local") { ctx.ui.notify("当前会话使用本地工具", "info"); return; }
    const probe = await new RemoteClient(state.binding.workspace, await store.read(), undefined, pool).probe();
    remoteContextCache = undefined;
    state = { mode: "remote", binding: { workspace: { ...state.binding.workspace, path: probe.root }, probe } };
    await persist(ctx);
    ctx.ui.notify(`${state.binding.workspace.host}:${probe.root} · ${probe.hostname} · Python ${probe.python} · git ${probe.git ? "✓" : "×"} · rg ${probe.ripgrep ? "✓" : "×"}`, "info");
  };

  pi.registerCommand("remote", {
    description: "SSH 远程工作区：切换、远程文件浏览编辑、Git 状态、配置与连接测试",
    getArgumentCompletions: async prefix => {
      const query = prefix.trimStart();
      const config = await store.read().catch(() => undefined);
      const workspaces = config?.workspaces ?? [];
      for (const [verb, descPrefix] of [["use ", "绑定"], ["edit ", "编辑"], ["remove ", "删除"]] as const) {
        if (query.startsWith(verb)) {
          const partial = query.slice(verb.length).trim().toLowerCase();
          return workspaces
            .filter(w => !partial || w.id.toLowerCase().includes(partial) || w.name.toLowerCase().includes(partial))
            .map(w => ({ value: `${verb}${w.id}`, label: `${verb}${w.id}`, description: `${descPrefix} ${w.name} (${w.host}:${w.path})` }));
        }
      }
      const items = [
        ...workspaces.map(w => ({ value: `use ${w.id}`, label: `use ${w.id}`, description: `${w.name} (${w.host}:${w.path})` })),
        ...SUBCOMMANDS.filter(([cmd]) => cmd !== "use ").map(([cmd, desc]) => ({ value: cmd, label: cmd.trim(), description: desc })),
      ];
      return items.filter(item => !query || item.value.startsWith(query) || item.label.startsWith(query));
    },
    handler: async (args, ctx) => {
      try {
        await withInteractiveLease(ctx, async () => {
          if (!nativeMode) await restore(ctx);
          const text = args.trim();
          if (text === "local" || text === "off" || text === "unbind") { await switchToLocal(ctx); return; }
          if (text.startsWith("use ")) { await bind(text.slice(4).trim(), ctx); return; }
          if (text === "edit" || text.startsWith("edit ")) {
            const id = text === "edit" ? undefined : text.slice(5).trim();
            await edit(ctx, id || undefined);
            return;
          }
          if (text.startsWith("remove ") || text.startsWith("rm ")) {
            const id = text.replace(/^(?:remove|rm)\s+/, "").trim();
            if (!id) throw new Error("Usage: /remote remove <id>");
            await remove(id, ctx);
            return;
          }
          if (text === "files" || text.startsWith("files ")) {
            const binding = await ensureBoundForModal(ctx);
            if (!binding) return;
            const initialPath = text === "files" ? "." : (text.slice(6).trim() || ".");
            const client = new RemoteClient(binding.workspace, await store.read(), undefined, pool);
            await browseRemoteFiles(client, binding.probe.root, binding.probe.ripgrep, ctx.ui, initialPath);
            return;
          }
          if (text === "git") {
            const binding = await ensureBoundForModal(ctx);
            if (!binding) return;
            if (!binding.probe.git) {
              ctx.ui.notify(`远程主机 ${binding.workspace.host} 未检测到 git`, "warning");
              return;
            }
            const client = new RemoteClient(binding.workspace, await store.read(), undefined, pool);
            await inspectRemoteGit(client, binding.probe.root, ctx.ui);
            return;
          }
          if (text === "web") { await openWeb(ctx); return; }
          if (text === "add") { await add(ctx); return; }
          if (text === "anchors") { await showAnchors(ctx); return; }
          if (text === "hosts" || text === "refresh") {
            const inventory = await discoverHosts(await store.read());
            if (inventory.warnings.length) ctx.ui.notify(inventory.warnings.join("\n"), "warning");
            if (nativeMode && (!isPiWebHost() || !ctx.hasUI)) {
              pi.sendMessage({ customType: "pi-remote-hosts", content: inventory.hosts.map(h => `${h.alias} (${h.source}:${h.line})`).join("\n") || "SSH config 中没有明确的 Host 别名；可用 /remote add 手动添加。", display: true });
            } else if (!inventory.hosts.length) {
              ctx.ui.notify("SSH config 中没有明确的 Host 别名；可用 /remote add 手动添加。", "info");
            } else {
              const labels = inventory.hosts.map(h => `${h.alias} — ${h.source}:${h.line}`);
              const chosen = await ctx.ui.select(`发现 ${inventory.hosts.length} 台 SSH 主机（选择可添加工作区）`, labels);
              if (chosen) {
                const idx = labels.indexOf(chosen);
                if (idx >= 0) await add(ctx, inventory.hosts[idx]!.alias);
              }
            }
            return;
          }
          if (text === "status" || text === "test") {
            await runProbeNotify(ctx);
            return;
          }
          if (text) throw new Error("Usage: /remote [use <id> | files [path] | git | add | edit [id] | remove <id> | hosts | anchors | status | test | web | local]");
          const config = await store.read();
          const activeId = state.mode === "remote" ? state.binding.workspace.id : undefined;
          const workspaceItems = config.workspaces.map(w => formatWorkspaceChoice(w, activeId));
          const filesAction = state.mode === "remote" ? "📁 浏览与编辑远程文件" : undefined;
          const gitAction = state.mode === "remote" && state.binding.probe.git ? "🌿 查看远程 Git 状态与 Diff" : undefined;
          const testAction = state.mode === "remote" ? "🩺 测试当前连接" : undefined;
          const addAction = "➕ 添加远程工作区";
          const editAction = config.workspaces.length ? "✏️ 编辑远程工作区" : undefined;
          const deleteAction = config.workspaces.length ? "🗑 删除远程工作区" : undefined;
          const anchorsAction = nativeMode ? "📂 查看 pi-web 锚点目录" : undefined;
          const hostsAction = "🔍 刷新 SSH 主机列表";
          const webAction = "🌐 浏览器配置与文件管理";
          const localAction = state.mode !== "local" ? "🔌 切换到本地" : undefined;

          const actions = [
            filesAction,
            gitAction,
            testAction,
            addAction,
            editAction,
            deleteAction,
            anchorsAction,
            hostsAction,
            webAction,
            localAction,
          ].filter((item): item is string => Boolean(item));

          const title = state.mode === "remote"
            ? `Pi Remote · 当前: ${state.binding.workspace.name} (${state.binding.workspace.host})`
            : state.mode === "blocked"
              ? "Pi Remote · ⚠ 远程工作区不可用"
              : "Pi Remote · SSH 工作区（当前: 本地）";

          const choice = await ctx.ui.select(title, [...workspaceItems, ...actions]);
          if (!choice) return;
          const index = workspaceItems.indexOf(choice);
          if (index >= 0) await bind(config.workspaces[index]!.id, ctx);
          else if (choice === filesAction && state.mode === "remote") {
            const client = new RemoteClient(state.binding.workspace, await store.read(), undefined, pool);
            await browseRemoteFiles(client, state.binding.probe.root, state.binding.probe.ripgrep, ctx.ui);
          } else if (choice === gitAction && state.mode === "remote") {
            const client = new RemoteClient(state.binding.workspace, await store.read(), undefined, pool);
            await inspectRemoteGit(client, state.binding.probe.root, ctx.ui);
          } else if (choice === testAction) {
            await runProbeNotify(ctx);
          } else if (choice === addAction) await add(ctx);
          else if (choice === editAction) await edit(ctx);
          else if (choice === webAction) await openWeb(ctx);
          else if (choice === anchorsAction) await showAnchors(ctx);
          else if (choice === hostsAction) {
            const inventory = await discoverHosts(await store.read());
            if (inventory.warnings.length) ctx.ui.notify(inventory.warnings.join("\n"), "warning");
            if (!inventory.hosts.length) {
              ctx.ui.notify("SSH config 中没有明确的 Host 别名；可用 /remote add 手动输入主机。", "info");
              return;
            }
            const pickedHost = await ctx.ui.select(`发现 ${inventory.hosts.length} 台主机（选择即可添加工作区）`, inventory.hosts.map(h => h.alias));
            if (pickedHost) await add(ctx, pickedHost);
          } else if (choice === deleteAction) {
            const labels = config.workspaces.map(w => `${w.name} [${w.id}]`);
            const selectedLabel = await ctx.ui.select("选择要删除的工作区配置（不影响远程文件）", labels);
            if (!selectedLabel) return;
            const target = config.workspaces[labels.indexOf(selectedLabel)];
            if (target && await ctx.ui.confirm("确认删除", `确定删除工作区「${target.name}」(${target.id}) 吗？远程文件不受影响。`)) {
              await remove(target.id, ctx);
            }
          } else if (choice === localAction) await switchToLocal(ctx);
        });
      } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
    },
  });
}
