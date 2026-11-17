// SSH tool override patterns reference pi's MIT-licensed example; see THIRD_PARTY_NOTICES.md.
import {
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition,
  createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition,
  type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { agentDir, ConfigStore, slugifyWorkspaceId, validateConfig, validateHost, type Workspace } from "./config.js";
import { discoverHosts } from "./ssh-config.js";
import { RemoteClient, RemotePool, type Probe, type RemoteContextFile } from "./remote.js";
import { bashOperations, createRemoteTools } from "./tools.js";
import { startDashboard, type Dashboard } from "./server.js";

const ENTRY = "pi-remote-workspace-v1";
export interface Binding { workspace: Workspace; probe: Probe }
type State = { mode: "local" } | { mode: "remote"; binding: Binding } | { mode: "blocked"; error: string };

const SUBCOMMANDS: ReadonlyArray<[string, string]> = [
  ["use ", "绑定已保存的远程工作区"],
  ["add", "从 SSH config 选择主机并添加工作区"],
  ["remove ", "删除已保存的远程工作区配置"],
  ["hosts", "重新读取 SSH config 并显示主机来源"],
  ["status", "查看当前工作区并检查连接"],
  ["test", "测试当前远程连接与工具可用性"],
  ["web", "打开本会话的浏览器配置与文件管理界面"],
  ["local", "取消远程绑定并恢复本地工具"],
];

/** Each factory owns one session; never share an active host through module globals. */
export default function remoteExtension(pi: ExtensionAPI) {
  const store = new ConfigStore();
  const pool = new RemotePool();
  let state: State = { mode: "local" };
  let dashboard: Dashboard | undefined;
  let remoteContextCache: { key: string; files: RemoteContextFile[] } | undefined;
  let flagApplied = false;
  pi.registerFlag("remote", { description: "Bind this session to a saved remote workspace ID", type: "string" });

  const unavailableMessage = (error: string) => `Remote workspace unavailable: ${error}. Use /remote use <id> or /remote local.`;
  const display = (ctx: ExtensionContext) => {
    const text = state.mode === "remote" ? `SSH ${state.binding.workspace.host} · ${state.binding.probe.root}` : state.mode === "blocked" ? `SSH blocked: ${state.error}` : undefined;
    ctx.ui.setStatus("pi-remote", text);
    ctx.ui.setWidget("pi-remote", text ? [text, "/remote — 切换工作区 / 配置 / 浏览器管理"] : undefined);
  };
  const persist = (ctx: ExtensionContext) => { pi.appendEntry(ENTRY, state); display(ctx); };
  const ensureIdle = (ctx: ExtensionContext) => { if (!ctx.isIdle()) throw new Error("Wait for the current agent turn to finish before switching workspaces"); };
  const switchToLocal = async (ctx: ExtensionContext, notify = true) => {
    ensureIdle(ctx);
    state = { mode: "local" };
    remoteContextCache = undefined;
    await pool.closeHost();
    persist(ctx);
    if (notify) ctx.ui.notify("已切换到本地工具", "info");
  };
  const bind = async (id: string, ctx: ExtensionContext) => {
    ensureIdle(ctx);
    const config = await store.read();
    const workspace = config.workspaces.find(w => w.id === id);
    if (!workspace) throw new Error(`Unknown workspace: ${id}. Add it with /remote add or /remote web.`);
    // Only replace the previous binding after the new workspace is verified.
    const client = new RemoteClient(workspace, config, undefined, pool);
    const probe = await client.probe();
    const contextFiles = await client.context().catch(() => []);
    if (state.mode === "remote" && state.binding.workspace.host !== workspace.host) {
      await pool.closeHost(state.binding.workspace.host);
    }
    remoteContextCache = { key: `${workspace.host}:${probe.root}`, files: contextFiles };
    state = { mode: "remote", binding: { workspace: { ...workspace, path: probe.root }, probe } };
    persist(ctx);
    ctx.ui.notify(`已绑定 ${workspace.name}: ${workspace.host}:${probe.root}`, "info");
  };
  const restore = (ctx: ExtensionContext) => {
    state = { mode: "local" };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
      const value = entry.data as State;
      if (value?.mode === "remote") {
        try {
          validateConfig({ version: 1, connectTimeoutSeconds: 10, commandTimeoutSeconds: 120, workspaces: [value.binding.workspace] });
          if (!value.binding.probe.root.startsWith("/") || !value.binding.probe.home.startsWith("/")) throw new Error("Invalid saved remote paths");
          state = value;
        } catch (error) { state = { mode: "blocked", error: (error as Error).message }; }
      } else if (value?.mode === "local" || value?.mode === "blocked") state = value;
      else state = { mode: "blocked", error: "Invalid saved workspace binding; select a workspace with /remote" };
    }
    if (state.mode !== "remote") remoteContextCache = undefined;
    display(ctx);
  };

  const localFactories = [createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition];
  for (const factory of localFactories) {
    const local = factory(process.cwd()) as ToolDefinition<any, any>;
    pi.registerTool({
      ...local,
      async execute(id, params, signal, onUpdate, ctx) {
        if (state.mode === "blocked") throw new Error(unavailableMessage(state.error));
        if (state.mode === "local") return (factory(ctx.cwd) as ToolDefinition<any, any>).execute(id, params, signal, onUpdate, ctx);
        const binding = state.binding;
        const client = new RemoteClient(binding.workspace, await store.read(), undefined, pool);
        const tool = createRemoteTools(client, binding.probe, signal)[local.name]!;
        return tool.execute(id, params, signal, onUpdate, ctx);
      },
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
    const id = pi.getFlag("remote");
    if (!flagApplied && typeof id === "string" && id) {
      flagApplied = true;
      try { await bind(id, ctx); }
      catch (error) {
        state = { mode: "blocked", error: (error as Error).message };
        persist(ctx);
        ctx.ui.notify(state.error, "error");
      }
    }
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", async () => {
    const running = dashboard;
    dashboard = undefined;
    await Promise.allSettled([running?.close(), pool.close()]);
  });
  pi.on("input", (_event, ctx) => {
    if (state.mode !== "blocked") return;
    ctx.ui.notify(unavailableMessage(state.error), "error");
    return { action: "handled" };
  });
  pi.on("tool_call", event => {
    if (state.mode === "blocked") return { block: true, terminate: true, reason: unavailableMessage(state.error) };
    if (state.mode === "remote" && event.toolName === "powershell") {
      return { block: true, reason: "This SSH workspace uses bash. Use the bash tool for remote commands." };
    }
  });
  pi.on("user_bash", async () => {
    if (state.mode === "blocked") throw new Error(unavailableMessage(state.error));
    if (state.mode === "local") return;
    const binding = state.binding;
    return { operations: bashOperations(new RemoteClient(binding.workspace, await store.read(), undefined, pool), binding.probe.root) };
  });
  pi.on("before_agent_start", async event => {
    if (state.mode === "blocked") {
      event.systemPromptOptions.contextFiles = [];
      event.systemPromptOptions.selectedTools = [];
      event.systemPromptOptions.sections.ssh_workspace = unavailableMessage(state.error);
      return;
    }
    if (state.mode === "local") return;
    const { workspace, probe } = state.binding;
    const cacheKey = `${workspace.host}:${probe.root}`;
    if (remoteContextCache?.key !== cacheKey) {
      try {
        const files = await new RemoteClient(workspace, await store.read(), undefined, pool).context();
        remoteContextCache = { key: cacheKey, files };
      } catch {
        remoteContextCache = { key: cacheKey, files: [] };
      }
    }
    const globalPrefix = `${agentDir().replace(/\/+$/, "")}/`;
    const globalContext = event.systemPromptOptions.contextFiles.filter(file => file.path.startsWith(globalPrefix));
    event.systemPromptOptions.cwd = probe.root;
    event.systemPromptOptions.contextFiles = [...globalContext, ...remoteContextCache.files];
    event.systemPromptOptions.sections.ssh_workspace = [
      `Host: ${workspace.host} (${probe.hostname})`,
      `Current working directory: ${probe.root}`,
      `All read, write, edit, bash, grep, find and ls calls operate on this SSH workspace. Use remote paths or paths relative to ${probe.root}.`,
      `File tools are restricted to ${probe.root}, including symlink targets. bash and ! commands execute on the remote host with the SSH user's privileges.`,
      `grep/find use remote ripgrep (${probe.ripgrep ? "available" : "not detected; use bash if needed"}). Do not invoke local-only tools to modify this workspace.`,
    ].join("\n");
  });

  const openWeb = async (ctx: ExtensionContext) => {
    dashboard ??= await startDashboard({ store });
    const url = state.mode === "remote" ? `${dashboard.url}&workspace=${encodeURIComponent(state.binding.workspace.id)}` : dashboard.url;
    // Plain text widgets/dialogs work in both TUI and pi-web; no terminal component required.
    ctx.ui.setWidget("pi-remote-dashboard", ["Pi Remote 配置与文件管理", url]);
    pi.sendMessage({ customType: "pi-remote-dashboard", content: `Pi Remote 配置与文件管理：${url}`, display: true });
    ctx.ui.notify(url, "info");
  };
  const add = async (ctx: ExtensionCommandContext, presetHost?: string) => {
    const config = await store.read();
    let host = presetHost;
    if (!host) {
      const inventory = await discoverHosts(config);
      const manual = "手动输入 SSH 主机";
      const selected = await ctx.ui.select("选择 SSH 主机（动态读取 config）", [...inventory.hosts.map(h => h.alias), manual]);
      if (!selected) return;
      host = (selected === manual ? await ctx.ui.input("SSH 主机", "例如 dev 或 user@example.com") : selected)?.trim();
    }
    if (!host) return;
    validateHost(host);
    const rawPath = await ctx.ui.input("远程项目目录", "例如 ~/projects/my-app");
    const path = rawPath?.trim();
    if (!path) return;
    const rawName = await ctx.ui.input("工作区名称", `${host}:${path}`);
    if (rawName === undefined) return;
    const name = rawName.trim() || `${host}:${path}`;
    const workspace = await store.update(current => {
      const id = slugifyWorkspaceId(host!, path, rawName.trim() || undefined, current.workspaces.map(w => w.id));
      return { ...current, workspaces: [...current.workspaces, { id, name, host: host!, path }] };
    }).then(updated => updated.workspaces.at(-1)!);
    ctx.ui.notify(`已保存 ${workspace.name} (${workspace.id})`, "info");
    await bind(workspace.id, ctx);
  };
  const remove = async (id: string, ctx: ExtensionCommandContext) => {
    const config = await store.read();
    const target = config.workspaces.find(w => w.id === id);
    if (!target) throw new Error(`Unknown workspace: ${id}`);
    if (state.mode === "remote" && state.binding.workspace.id === id) {
      await switchToLocal(ctx, false);
    }
    await store.update(current => ({ ...current, workspaces: current.workspaces.filter(w => w.id !== id) }));
    ctx.ui.notify(`已删除工作区配置 ${target.name} (${target.id})`, "info");
  };

  pi.registerCommand("remote", {
    description: "SSH 远程工作区：配置、切换、连接测试和浏览器文件管理",
    getArgumentCompletions: async prefix => {
      const query = prefix.trimStart();
      const config = await store.read().catch(() => undefined);
      const workspaces = config?.workspaces ?? [];
      if (query.startsWith("use ")) {
        const partial = query.slice(4).trim().toLowerCase();
        return workspaces
          .filter(w => !partial || w.id.toLowerCase().includes(partial) || w.name.toLowerCase().includes(partial))
          .map(w => ({ value: `use ${w.id}`, label: `use ${w.id}`, description: `${w.name} (${w.host}:${w.path})` }));
      }
      if (query.startsWith("remove ")) {
        const partial = query.slice(7).trim().toLowerCase();
        return workspaces
          .filter(w => !partial || w.id.toLowerCase().includes(partial) || w.name.toLowerCase().includes(partial))
          .map(w => ({ value: `remove ${w.id}`, label: `remove ${w.id}`, description: `删除 ${w.name}` }));
      }
      const items = [
        ...workspaces.map(w => ({ value: `use ${w.id}`, label: `use ${w.id}`, description: `${w.name} (${w.host}:${w.path})` })),
        ...SUBCOMMANDS.filter(([cmd]) => cmd !== "use ").map(([cmd, desc]) => ({ value: cmd, label: cmd.trim(), description: desc })),
      ];
      return items.filter(item => !query || item.value.startsWith(query) || item.label.startsWith(query));
    },
    handler: async (args, ctx) => {
      try {
        const text = args.trim();
        if (text === "local" || text === "off") { await switchToLocal(ctx); return; }
        if (text.startsWith("use ")) { await bind(text.slice(4).trim(), ctx); return; }
        if (text.startsWith("remove ") || text.startsWith("rm ")) {
          const id = text.replace(/^(?:remove|rm)\s+/, "").trim();
          if (!id) throw new Error("Usage: /remote remove <id>");
          await remove(id, ctx);
          return;
        }
        if (text === "web") { await openWeb(ctx); return; }
        if (text === "add") { await add(ctx); return; }
        if (text === "hosts" || text === "refresh") {
          const inventory = await discoverHosts(await store.read());
          pi.sendMessage({ customType: "pi-remote-hosts", content: inventory.hosts.map(h => `${h.alias} (${h.source}:${h.line})`).join("\n") || "SSH config 中没有明确的 Host 别名；可用 /remote add 手动添加。", display: true });
          if (inventory.warnings.length) ctx.ui.notify(inventory.warnings.join("\n"), "warning");
          return;
        }
        if (text === "status" || text === "test") {
          if (state.mode === "blocked") throw new Error(state.error);
          if (state.mode === "local") { ctx.ui.notify("当前会话使用本地工具", "info"); return; }
          const probe = await new RemoteClient(state.binding.workspace, await store.read(), undefined, pool).probe();
          ctx.ui.notify(`${state.binding.workspace.host}:${probe.root} · Python ${probe.python} · git ${probe.git ? "✓" : "×"} · rg ${probe.ripgrep ? "✓" : "×"}`, "info");
          return;
        }
        if (text) throw new Error("Usage: /remote [use <id> | add | remove <id> | hosts | status | test | web | local]");
        const config = await store.read();
        const activeId = state.mode === "remote" ? state.binding.workspace.id : undefined;
        const workspaceItems = config.workspaces.map(w => `${w.id === activeId ? "● " : ""}${w.name} — ${w.host}:${w.path} [${w.id}]`);
        const actions = [
          "添加远程工作区",
          "浏览器配置与文件管理",
          "刷新 SSH 主机列表",
          "测试当前连接",
          ...(config.workspaces.length ? ["删除远程工作区"] : []),
          "切换到本地",
        ];
        const choice = await ctx.ui.select("Pi Remote · SSH 工作区", [...workspaceItems, ...actions]);
        if (!choice) return;
        const index = workspaceItems.indexOf(choice);
        if (index >= 0) await bind(config.workspaces[index]!.id, ctx);
        else if (choice === "添加远程工作区") await add(ctx);
        else if (choice === "浏览器配置与文件管理") await openWeb(ctx);
        else if (choice === "刷新 SSH 主机列表") {
          const inventory = await discoverHosts(await store.read());
          if (inventory.warnings.length) ctx.ui.notify(inventory.warnings.join("\n"), "warning");
          if (!inventory.hosts.length) {
            ctx.ui.notify("SSH config 中没有明确的 Host 别名；可用 /remote add 手动输入主机。", "info");
            return;
          }
          const pickedHost = await ctx.ui.select(`发现 ${inventory.hosts.length} 台主机（选择即可添加工作区）`, inventory.hosts.map(h => h.alias));
          if (pickedHost) await add(ctx, pickedHost);
        } else if (choice === "测试当前连接") {
          if (state.mode !== "remote") throw new Error("请先选择远程工作区");
          const probe = await new RemoteClient(state.binding.workspace, await store.read(), undefined, pool).probe();
          ctx.ui.notify(`连接成功：${probe.hostname} · ${probe.root}`, "info");
        } else if (choice === "删除远程工作区") {
          const labels = config.workspaces.map(w => `${w.name} [${w.id}]`);
          const selectedLabel = await ctx.ui.select("选择要删除的工作区配置（不影响远程文件）", labels);
          if (!selectedLabel) return;
          const target = config.workspaces[labels.indexOf(selectedLabel)];
          if (target && await ctx.ui.confirm("确认删除", `确定删除工作区「${target.name}」(${target.id}) 吗？远程文件不受影响。`)) {
            await remove(target.id, ctx);
          }
        } else if (choice === "切换到本地") await switchToLocal(ctx);
      } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
    },
  });
}
