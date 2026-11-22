import { randomUUID } from "node:crypto";
import { DashboardController, type ControllerOptions } from "./dashboard-api.js";
import { discoverHosts, sshConfigSignature, type HostInventory } from "./ssh-config.js";
import { RemoteClient, type Probe } from "./remote.js";
import type { PersistedSessionState, RemoteConfig } from "./config.js";

interface PiDesktopHostApi {
  commands: {
    register(spec: { id: string; title: string; keywords?: string[]; run: () => Promise<void> | void }): Promise<void>;
    unregister(id: string): Promise<void>;
  };
  ui: {
    openPanel(options?: { title?: string }): Promise<void>;
    closePanel(): Promise<void>;
    revealView?(viewId: string): Promise<void>;
    showToast(message: string): Promise<void>;
  };
  session: {
    getActive(): Promise<{ sessionId: string; projectPath?: string; activeTurn?: { turnId: string; startedAt: string } | null } | null>;
  };
  clipboard: {
    writeText(text: string): Promise<void>;
  };
}

declare const pi: PiDesktopHostApi;

const COMMAND_OPEN_VIEW = "pi-remote.openView";
const COMMAND_OPEN_PANEL = "pi-remote.openPanel";
const COMMAND_UNBIND_SESSION = "pi-remote.unbindSession";

export interface AsyncRemoteJob {
  id: string;
  kind: "bind" | "probe";
  workspaceId: string;
  sessionId?: string;
  status: "connecting" | "ready" | "error";
  probe?: Probe;
  state?: PersistedSessionState;
  error?: string;
  updatedAt: number;
}

const ACTIVE_TURN_MESSAGE = "请等待当前对话回合结束后再切换远程工作区";

export function createPiDesktopPlugin(options?: ControllerOptions) {
  let controller: DashboardController | undefined;
  let hostCache: { at: number; configKey: string; signature: string; files: string[]; inventory: HostInventory } | undefined;
  const jobs = new Map<string, AsyncRemoteJob>();
  const inflightPanelRequests = new Map<string, AbortController>();
  const sessionBindControllers = new Map<string, AbortController>();
  const sessionBindSeq = new Map<string, number>();

  const ensureController = (): DashboardController => {
    controller ??= new DashboardController(options);
    return controller;
  };

  const pruneJobs = () => {
    if (jobs.size <= 32) return;
    const sorted = [...jobs.entries()].sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
    for (const [id] of sorted.slice(32)) jobs.delete(id);
  };

  const getCachedInventory = async (config: RemoteConfig, force = false): Promise<HostInventory> => {
    const now = Date.now();
    const configKey = config.sshConfigPath ?? "";
    if (!force && hostCache && hostCache.configKey === configKey) {
      if (now - hostCache.at < 2000) return hostCache.inventory;
      const check = await sshConfigSignature(config, hostCache.files);
      if (check.signature === hostCache.signature) {
        hostCache.at = now;
        return hostCache.inventory;
      }
    }
    const inventory = await discoverHosts(config);
    const sig = await sshConfigSignature(config, inventory.files);
    hostCache = { at: now, configKey, signature: sig.signature, files: sig.files, inventory };
    return inventory;
  };

  const cancelPendingBindForSession = (sessionId: string): number => {
    const nextSeq = (sessionBindSeq.get(sessionId) ?? 0) + 1;
    sessionBindSeq.set(sessionId, nextSeq);
    const prev = sessionBindControllers.get(sessionId);
    if (prev) {
      prev.abort();
      sessionBindControllers.delete(sessionId);
    }
    return nextSeq;
  };

  const startBindJob = (sessionId: string, workspaceId: string): AsyncRemoteJob => {
    const activeController = ensureController();
    const seq = cancelPendingBindForSession(sessionId);
    const abortController = new AbortController();
    sessionBindControllers.set(sessionId, abortController);
    const job: AsyncRemoteJob = {
      id: randomUUID(),
      kind: "bind",
      workspaceId,
      sessionId,
      status: "connecting",
      updatedAt: Date.now(),
    };
    jobs.set(job.id, job);
    pruneJobs();

    void activeController.bindSession(sessionId, workspaceId, abortController.signal).then(
      result => {
        if (sessionBindControllers.get(sessionId) === abortController) sessionBindControllers.delete(sessionId);
        if (sessionBindSeq.get(sessionId) !== seq) return;
        job.status = "ready";
        job.probe = result.probe;
        job.state = result.state;
        job.updatedAt = Date.now();
        void pi.ui.showToast(`已绑定 SSH 工作区：${result.probe.hostname}:${result.probe.root}`).catch(() => {});
      },
      error => {
        if (sessionBindControllers.get(sessionId) === abortController) sessionBindControllers.delete(sessionId);
        job.status = "error";
        job.error = abortController.signal.aborted ? "绑定请求已被更新的操作替代" : (error as Error).message;
        job.updatedAt = Date.now();
      },
    );
    return job;
  };

  const startProbeJob = (workspaceId: string): AsyncRemoteJob => {
    const activeController = ensureController();
    const job: AsyncRemoteJob = {
      id: randomUUID(),
      kind: "probe",
      workspaceId,
      status: "connecting",
      updatedAt: Date.now(),
    };
    jobs.set(job.id, job);
    pruneJobs();

    void (async () => {
      const config = await activeController.store.read();
      const workspace = config.workspaces.find(w => w.id === workspaceId);
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
      const client = options?.client?.(workspace, config) ?? new RemoteClient(workspace, config, undefined, activeController.pool);
      return client.probe();
    })().then(
      probe => {
        job.status = "ready";
        job.probe = probe;
        job.updatedAt = Date.now();
      },
      error => {
        job.status = "error";
        job.error = (error as Error).message;
        job.updatedAt = Date.now();
      },
    );
    return job;
  };

  const revealWorkbench = async () => {
    try {
      if (typeof pi.ui.revealView === "function") {
        await pi.ui.revealView("workbench");
        return;
      }
    } catch { /* Fall back to standalone panel when no session work panel is visible. */ }
    await pi.ui.openPanel({ title: "Pi Remote · SSH 远程工作区" });
  };

  return {
    async onLoad(): Promise<void> {
      ensureController();
      await pi.commands.register({
        id: COMMAND_OPEN_VIEW,
        title: "Pi Remote: 打开右侧 SSH 远程工作区视图",
        keywords: ["ssh", "remote", "workspace", "view", "远程"],
        run: revealWorkbench,
      });
      await pi.commands.register({
        id: COMMAND_OPEN_PANEL,
        title: "Pi Remote: 打开独立远程工作台窗口",
        keywords: ["ssh", "remote", "panel", "远程", "窗口"],
        run: async () => {
          await pi.ui.openPanel({ title: "Pi Remote · SSH 远程工作区" });
        },
      });
      await pi.commands.register({
        id: COMMAND_UNBIND_SESSION,
        title: "Pi Remote: 取消当前会话的 SSH 远程绑定",
        keywords: ["ssh", "remote", "unbind", "local", "解绑"],
        run: async () => {
          const active = await pi.session.getActive();
          if (!active?.sessionId) {
            await pi.ui.showToast("当前没有活动的聊天会话");
            return;
          }
          if (active.activeTurn) {
            await pi.ui.showToast(ACTIVE_TURN_MESSAGE);
            return;
          }
          cancelPendingBindForSession(active.sessionId);
          await ensureController().unbindSession(active.sessionId);
          await pi.ui.showToast("已取消当前会话的 SSH 远程工作区绑定");
        },
      });
    },

    async onUnload(): Promise<void> {
      const running = controller;
      controller = undefined;
      for (const reqAbort of inflightPanelRequests.values()) reqAbort.abort();
      inflightPanelRequests.clear();
      for (const bindAbort of sessionBindControllers.values()) bindAbort.abort();
      sessionBindControllers.clear();
      sessionBindSeq.clear();
      jobs.clear();
      hostCache = undefined;
      await Promise.allSettled([
        pi.commands.unregister(COMMAND_OPEN_VIEW),
        pi.commands.unregister(COMMAND_OPEN_PANEL),
        pi.commands.unregister(COMMAND_UNBIND_SESSION),
        running?.close(),
      ]);
    },

    /**
     * Renderer-slot RPC bridge (`plugin.call`, 2s / 64KB host budget).
     * SSH handshakes run as tracked async jobs so `plugin.call` always settles in milliseconds
     * and user-facing errors return `{ ok: false, error }` without tripping host circuit breakers.
     */
    async onRendererCall(method: string, rawArgs: unknown = {}): Promise<unknown> {
      const activeController = ensureController();
      const args = rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>) : {};
      try {
        switch (method) {
          case "remote.state": {
            const config = await activeController.store.read();
            const inventory = await getCachedInventory(config, args.refreshHosts === true);
            const active = await pi.session.getActive().catch(() => null);
            const sessionId = active?.sessionId ?? "";
            const binding = sessionId ? await activeController.getSessionBinding(sessionId) : { sessionId: "", state: { mode: "local" } as PersistedSessionState };
            const activeJob = sessionId
              ? [...jobs.values()].reverse().find(j => j.kind === "bind" && j.sessionId === sessionId && j.status === "connecting") ?? null
              : null;
            return {
              ok: true,
              workspaces: config.workspaces,
              hosts: inventory.hosts.slice(0, 120).map(h => h.alias),
              warnings: inventory.warnings.slice(0, 5),
              activeSessionId: sessionId,
              state: binding.state,
              activeJob,
            };
          }
          case "remote.bind": {
            const active = await pi.session.getActive().catch(() => null);
            const sessionId = typeof args.sessionId === "string" && args.sessionId ? args.sessionId : (active?.sessionId ?? "");
            const workspaceId = typeof args.workspaceId === "string" ? args.workspaceId.trim() : "";
            if (!sessionId) return { ok: false, error: "请先选择或新建一个聊天会话" };
            if (active?.sessionId === sessionId && active.activeTurn) return { ok: false, error: ACTIVE_TURN_MESSAGE };
            if (!workspaceId) return { ok: false, error: "请选择一个远程工作区" };
            const job = startBindJob(sessionId, workspaceId);
            return { ok: true, job };
          }
          case "remote.unbind": {
            const active = await pi.session.getActive().catch(() => null);
            const sessionId = typeof args.sessionId === "string" && args.sessionId ? args.sessionId : (active?.sessionId ?? "");
            if (!sessionId) return { ok: false, error: "当前没有活动的聊天会话" };
            if (active?.sessionId === sessionId && active.activeTurn) return { ok: false, error: ACTIVE_TURN_MESSAGE };
            cancelPendingBindForSession(sessionId);
            const result = await activeController.unbindSession(sessionId);
            void pi.ui.showToast("已切回本地模式").catch(() => {});
            return { ok: true, state: result.state };
          }
          case "remote.probe": {
            const workspaceId = typeof args.workspaceId === "string" ? args.workspaceId.trim() : "";
            if (!workspaceId) return { ok: false, error: "缺少工作区 ID" };
            return { ok: true, job: startProbeJob(workspaceId) };
          }
          case "remote.job": {
            const jobId = typeof args.jobId === "string" ? args.jobId : "";
            return { ok: true, job: jobs.get(jobId) ?? null };
          }
          case "remote.saveWorkspace": {
            const editingId = typeof args.editingId === "string" ? args.editingId.trim() : "";
            const active = await pi.session.getActive().catch(() => null);
            let shouldRebindEdited = false;
            if (editingId && active?.sessionId && !active.activeTurn) {
              const [prevCfg, prevBind] = await Promise.all([
                activeController.store.read().catch(() => undefined),
                activeController.getSessionBinding(active.sessionId),
              ]);
              const prevWs = prevCfg?.workspaces.find(w => w.id === editingId);
              if (prevBind.state.mode === "remote" && prevBind.state.binding.workspace.id === editingId && prevWs) {
                const nextHost = typeof args.host === "string" ? args.host.trim() : prevWs.host;
                const nextPath = typeof args.path === "string" ? args.path.trim() : prevWs.path;
                shouldRebindEdited = nextHost !== prevWs.host || nextPath !== prevWs.path;
              }
            }
            const outcome = await activeController.dispatch(
              editingId ? `/api/workspaces/${encodeURIComponent(editingId)}` : "/api/workspaces",
              editingId ? "PUT" : "POST",
              {
                id: args.id,
                name: args.name,
                host: args.host,
                path: args.path,
              },
            );
            if (outcome.status >= 400) {
              const errMsg = outcome.body && typeof outcome.body === "object" && "error" in outcome.body
                ? String((outcome.body as { error?: unknown }).error ?? "保存失败")
                : "保存失败";
              return { ok: false, error: errMsg };
            }
            const workspace = outcome.body as { id: string };
            let job: AsyncRemoteJob | null = null;
            if ((args.bindNow === true || shouldRebindEdited) && active?.sessionId && !active.activeTurn) {
              job = startBindJob(active.sessionId, workspace.id);
            }
            return { ok: true, workspace, job };
          }
          case "remote.deleteWorkspace": {
            const id = typeof args.workspaceId === "string" ? args.workspaceId.trim() : "";
            if (!id) return { ok: false, error: "缺少工作区 ID" };
            const outcome = await activeController.dispatch(`/api/workspaces/${encodeURIComponent(id)}`, "DELETE", {});
            if (outcome.status >= 400) {
              const errMsg = outcome.body && typeof outcome.body === "object" && "error" in outcome.body
                ? String((outcome.body as { error?: unknown }).error ?? "删除工作区失败")
                : "删除工作区失败";
              return { ok: false, error: errMsg };
            }
            return { ok: true };
          }
          case "remote.openView": {
            await revealWorkbench();
            return { ok: true };
          }
          default:
            return { ok: false, error: `Unknown renderer method: ${method}` };
        }
      } catch (error) {
        return { ok: false, error: (error as Error).message };
      }
    },

    async onPanelInvoke(channel: string, payload: Record<string, unknown> = {}): Promise<unknown> {
      const activeController = ensureController();
      switch (channel) {
        case "pi-remote.api": {
          const path = typeof payload.path === "string" ? payload.path : "/";
          const method = typeof payload.method === "string" ? payload.method : "GET";
          const data = payload.data && typeof payload.data === "object" ? (payload.data as Record<string, unknown>) : {};
          const requestId = typeof payload.requestId === "string" && payload.requestId ? payload.requestId : "";
          const reqAbort = requestId ? new AbortController() : undefined;
          if (requestId && reqAbort) inflightPanelRequests.set(requestId, reqAbort);
          try {
            const outcome = await activeController.dispatch(path, method, data, reqAbort?.signal);
            if (outcome.status >= 400) {
              const errMsg = outcome.body && typeof outcome.body === "object" && "error" in outcome.body
                ? String((outcome.body as { error?: unknown }).error ?? `Request failed (${outcome.status})`)
                : `Request failed (${outcome.status})`;
              throw new Error(errMsg);
            }
            return outcome.body;
          } finally {
            if (requestId && inflightPanelRequests.get(requestId) === reqAbort) {
              inflightPanelRequests.delete(requestId);
            }
          }
        }
        case "pi-remote.cancel": {
          const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
          if (requestId) {
            inflightPanelRequests.get(requestId)?.abort();
            inflightPanelRequests.delete(requestId);
          }
          return { ok: true };
        }
        case "pi-remote.sessionStatus": {
          const active = await pi.session.getActive().catch(() => null);
          if (!active?.sessionId) return { active: null, sessionId: "", state: { mode: "local" } };
          const binding = await activeController.getSessionBinding(active.sessionId);
          return { active, ...binding };
        }
        case "pi-remote.bindSession": {
          const active = await pi.session.getActive().catch(() => null);
          const sessionId = typeof payload.sessionId === "string" && payload.sessionId ? payload.sessionId : (active?.sessionId ?? "");
          if (active?.sessionId === sessionId && active?.activeTurn) throw new Error(ACTIVE_TURN_MESSAGE);
          const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId.trim() : "";
          const seq = cancelPendingBindForSession(sessionId);
          const abortController = new AbortController();
          sessionBindControllers.set(sessionId, abortController);
          try {
            const res = await activeController.bindSession(sessionId, workspaceId, abortController.signal);
            if (sessionBindSeq.get(sessionId) !== seq) throw new Error("绑定请求已被更新的操作替代");
            return res;
          } finally {
            if (sessionBindControllers.get(sessionId) === abortController) sessionBindControllers.delete(sessionId);
          }
        }
        case "pi-remote.unbindSession": {
          const active = await pi.session.getActive().catch(() => null);
          const sessionId = typeof payload.sessionId === "string" && payload.sessionId ? payload.sessionId : (active?.sessionId ?? "");
          if (active?.sessionId === sessionId && active?.activeTurn) throw new Error(ACTIVE_TURN_MESSAGE);
          if (sessionId) cancelPendingBindForSession(sessionId);
          return activeController.unbindSession(sessionId);
        }
        case "pi-remote.copyText": {
          await pi.clipboard.writeText(String(payload.text ?? ""));
          return { ok: true };
        }
        case "pi-remote.openWindow": {
          await pi.ui.openPanel({ title: "Pi Remote · SSH 远程工作区" });
          return { ok: true };
        }
        default: {
          const error = new Error(`Unsupported Pi Remote panel channel: ${channel}`) as Error & { code?: string };
          error.code = "UNSUPPORTED";
          throw error;
        }
      }
    },
  };
}

const defaultPlugin = createPiDesktopPlugin();
export const onLoad = defaultPlugin.onLoad;
export const onUnload = defaultPlugin.onUnload;
export const onRendererCall = defaultPlugin.onRendererCall;
export const onPanelInvoke = defaultPlugin.onPanelInvoke;
export default defaultPlugin;
