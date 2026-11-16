// SSH tool override patterns reference pi's MIT-licensed example; see THIRD_PARTY_NOTICES.md.
import { randomBytes } from "node:crypto";
import {
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition,
  createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition,
  type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ConfigStore, validateConfig, type Workspace } from "./config.js";
import { discoverHosts } from "./ssh-config.js";
import { RemoteClient, type Probe } from "./remote.js";
import { bashOperations, createRemoteTools } from "./tools.js";
import { startDashboard, type Dashboard } from "./server.js";

const ENTRY = "pi-remote-workspace-v1";
export interface Binding { workspace: Workspace; probe: Probe }
type State = { mode: "local" } | { mode: "remote"; binding: Binding } | { mode: "blocked"; error: string };

/** Each factory owns one session; never share an active host through module globals. */
export default function remoteExtension(pi: ExtensionAPI) {
  const store = new ConfigStore();
  let state: State = { mode: "local" };
  let dashboard: Dashboard | undefined;
  let flagApplied = false;
  pi.registerFlag("remote", { description: "Bind this session to a saved remote workspace ID", type: "string" });

  const display = (ctx: ExtensionContext) => {
    const text = state.mode === "remote" ? `SSH ${state.binding.workspace.host} · ${state.binding.probe.root}` : state.mode === "blocked" ? `SSH blocked: ${state.error}` : undefined;
    ctx.ui.setStatus("pi-remote", text);
    ctx.ui.setWidget("pi-remote", text ? [text, "/remote — 切换工作区 / 配置 / 浏览器管理"] : undefined);
  };
  const persist = (ctx: ExtensionContext) => { pi.appendEntry(ENTRY, state); display(ctx); };
  const ensureIdle = (ctx: ExtensionContext) => { if (!ctx.isIdle()) throw new Error("Wait for the current agent turn to finish before switching workspaces"); };
  const bind = async (id: string, ctx: ExtensionContext) => {
    ensureIdle(ctx);
    const config = await store.read();
    const workspace = config.workspaces.find(w => w.id === id);
    if (!workspace) throw new Error(`Unknown workspace: ${id}. Add it with /remote add or /remote web.`);
    // Only replace the previous binding after the new workspace is verified.
    const probe = await new RemoteClient(workspace, config).probe();
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
    display(ctx);
  };

  const localFactories = [createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition];
  for (const factory of localFactories) {
    const local = factory(process.cwd()) as ToolDefinition<any, any>;
    pi.registerTool({
      ...local,
      async execute(id, params, signal, onUpdate, ctx) {
        if (state.mode === "blocked") throw new Error(`Remote workspace unavailable: ${state.error}. Use /remote use <id> or /remote local.`);
        if (state.mode === "local") return (factory(ctx.cwd) as ToolDefinition<any, any>).execute(id, params, signal, onUpdate, ctx);
        const binding = state.binding;
        const client = new RemoteClient(binding.workspace, await store.read());
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
  pi.on("session_shutdown", async () => { const running = dashboard; dashboard = undefined; await running?.close(); });
  pi.on("tool_call", event => {
    if (state.mode !== "local" && event.toolName === "powershell") return { block: true, reason: "This SSH workspace uses bash. Use the bash tool for remote commands." };
  });
  pi.on("user_bash", async () => {
    if (state.mode === "blocked") throw new Error(state.error);
    if (state.mode === "local") return;
    const binding = state.binding;
    return { operations: bashOperations(new RemoteClient(binding.workspace, await store.read()), binding.probe.root) };
  });
  pi.on("before_agent_start", event => {
    if (state.mode === "blocked") throw new Error(`Remote workspace unavailable: ${state.error}`);
    if (state.mode === "local") return;
    const { workspace, probe } = state.binding;
    return { systemPrompt: `${event.systemPrompt}\n\n## Active SSH workspace\nHost: ${workspace.host}\nCurrent working directory: ${probe.root}\nAll read, write, edit, bash, grep, find and ls calls operate on this SSH workspace. Use remote paths or paths relative to ${probe.root}. File tools are restricted to this root, including symlink targets. bash and ! commands execute on the remote host with the SSH user's privileges. grep/find require remote ripgrep. Local project context above belongs to the pi host; inspect remote AGENTS.md before making changes. Do not invoke local-only tools to modify this workspace.` };
  });

  const openWeb = async (ctx: ExtensionContext) => {
    dashboard ??= await startDashboard({ store });
    // Plain text widgets/dialogs work in both TUI and pi-web; no terminal component required.
    ctx.ui.setWidget("pi-remote-dashboard", ["Pi Remote 配置与文件管理", dashboard.url]);
    pi.sendMessage({ customType: "pi-remote-dashboard", content: `Pi Remote 配置与文件管理：${dashboard.url}`, display: true });
    ctx.ui.notify(dashboard.url, "info");
  };
  const add = async (ctx: ExtensionCommandContext) => {
    const config = await store.read();
    const inventory = await discoverHosts(config);
    const manual = "手动输入 SSH 主机";
    const selected = await ctx.ui.select("选择 SSH 主机（动态读取 config）", [...inventory.hosts.map(h => h.alias), manual]);
    if (!selected) return;
    const host = selected === manual ? await ctx.ui.input("SSH 主机", "例如 dev 或 user@example.com") : selected;
    if (!host) return;
    const path = await ctx.ui.input("远程项目目录", "例如 ~/projects/my-app");
    if (!path) return;
    const name = await ctx.ui.input("工作区名称", `${host}:${path}`);
    if (name === undefined) return;
    const workspace: Workspace = { id: randomBytes(6).toString("hex"), name: name || `${host}:${path}`, host, path };
    await store.update(current => ({ ...current, workspaces: [...current.workspaces, workspace] }));
    ctx.ui.notify(`已保存 ${workspace.name} (${workspace.id})`, "info");
    await bind(workspace.id, ctx);
  };

  pi.registerCommand("remote", {
    description: "SSH 远程工作区：配置、切换、连接测试和浏览器文件管理",
    handler: async (args, ctx) => {
      try {
        const text = args.trim();
        if (text === "local" || text === "off") { ensureIdle(ctx); state = { mode: "local" }; persist(ctx); ctx.ui.notify("已切换到本地工具", "info"); return; }
        if (text.startsWith("use ")) { await bind(text.slice(4).trim(), ctx); return; }
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
          const probe = await new RemoteClient(state.binding.workspace, await store.read()).probe();
          ctx.ui.notify(`${state.binding.workspace.host}:${probe.root} · Python ${probe.python} · git ${probe.git ? "✓" : "×"} · rg ${probe.ripgrep ? "✓" : "×"}`, "info"); return;
        }
        if (text) throw new Error("Usage: /remote [use <id> | add | hosts | status | test | web | local]");
        const config = await store.read();
        const workspaceItems = config.workspaces.map(w => `${w.name} — ${w.host}:${w.path} [${w.id}]`);
        const actions = ["添加远程工作区", "浏览器配置与文件管理", "刷新 SSH 主机列表", "测试当前连接", "切换到本地"];
        const choice = await ctx.ui.select("Pi Remote · SSH 工作区", [...workspaceItems, ...actions]);
        if (!choice) return;
        const index = workspaceItems.indexOf(choice);
        if (index >= 0) await bind(config.workspaces[index]!.id, ctx);
        else if (choice === actions[0]) await add(ctx);
        else if (choice === actions[1]) await openWeb(ctx);
        else if (choice === actions[2]) {
          const inventory = await discoverHosts(await store.read());
          await ctx.ui.select(`发现 ${inventory.hosts.length} 台主机`, inventory.hosts.map(h => h.alias));
        } else if (choice === actions[3]) {
          if (state.mode !== "remote") throw new Error("请先选择远程工作区");
          const probe = await new RemoteClient(state.binding.workspace, await store.read()).probe();
          ctx.ui.notify(`连接成功：${probe.hostname} · ${probe.root}`, "info");
        } else if (choice === actions[4]) { ensureIdle(ctx); state = { mode: "local" }; persist(ctx); }
      } catch (error) { ctx.ui.notify((error as Error).message, "error"); }
    },
  });
}
