import { createElement as h, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

let hostApi = null;

async function callPlugin(method, args = {}) {
  if (!hostApi) return { ok: false, error: "Renderer host unavailable" };
  return hostApi.dispatch("plugin.call", { method, args });
}

function leafFolder(path) {
  if (typeof path !== "string" || !path) return "";
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed || trimmed === "/" || trimmed === "~") return trimmed || "/";
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function ServerIcon({ size = 13.5 }) {
  return h(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.8",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      style: { flexShrink: 0 },
    },
    h("rect", { x: "2", y: "3", width: "20", height: "7", rx: "2" }),
    h("rect", { x: "2", y: "14", width: "20", height: "7", rx: "2" }),
    h("circle", { cx: "6.5", cy: "6.5", r: "1", fill: "currentColor", stroke: "none" }),
    h("circle", { cx: "6.5", cy: "17.5", r: "1", fill: "currentColor", stroke: "none" }),
  );
}

function FolderOpenIcon({ size = 13 }) {
  return h(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "1.8",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
    },
    h("path", { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" }),
  );
}

function useLayerElement(active) {
  const [element, setElement] = useState(null);
  useEffect(() => {
    if (!active || !hostApi) return undefined;
    const layer = hostApi.ui.openLayer();
    setElement(layer.element);
    return () => {
      setElement(null);
      layer.close();
    };
  }, [active]);
  return element;
}

function WorkspaceDialog({ snapshot, onRefresh, onStartJob, busyWorkspaceId, bannerError, setBannerError, onClose }) {
  const element = useLayerElement(true);
  const [formOpen, setFormOpen] = useState(() => (snapshot.workspaces?.length ?? 0) === 0);
  const [editingId, setEditingId] = useState("");
  const [host, setHost] = useState("");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [probeInfo, setProbeInfo] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState("");
  const dialogMountedRef = useRef(true);

  useEffect(() => {
    dialogMountedRef.current = true;
    const onKeyDown = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      dialogMountedRef.current = false;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    if (!confirmDeleteId) return undefined;
    const timer = window.setTimeout(() => setConfirmDeleteId(""), 3500);
    return () => window.clearTimeout(timer);
  }, [confirmDeleteId]);

  const boundWorkspace = snapshot.state?.mode === "remote" ? snapshot.state.binding?.workspace : null;
  const boundProbe = snapshot.state?.mode === "remote" ? snapshot.state.binding?.probe : null;
  const blockedError = snapshot.state?.mode === "blocked" ? (snapshot.state.error || "远程工作区不可用") : "";

  const openAddForm = (presetHost = "") => {
    setConfirmDeleteId("");
    setEditingId("");
    setHost(presetHost);
    setPath("");
    setName("");
    setBannerError("");
    setFormOpen(true);
  };

  const openEditForm = (ws) => {
    setConfirmDeleteId("");
    setEditingId(ws.id);
    setHost(ws.host);
    setPath(ws.path);
    setName(ws.name);
    setBannerError("");
    setFormOpen(true);
  };

  const handleBind = async (workspaceId) => {
    setConfirmDeleteId("");
    setBannerError("");
    setProbeInfo(null);
    const res = await callPlugin("remote.bind", { workspaceId });
    if (!res?.ok) {
      setBannerError(res?.error || "绑定失败");
      return;
    }
    onStartJob(res.job);
  };

  const handleUnbind = async () => {
    setConfirmDeleteId("");
    setBannerError("");
    const res = await callPlugin("remote.unbind", {});
    if (!res?.ok) {
      setBannerError(res?.error || "取消绑定失败");
      return;
    }
    await onRefresh();
  };

  const handleProbe = async (workspaceId) => {
    setConfirmDeleteId("");
    setBannerError("");
    setProbeInfo({ workspaceId, text: "正在测试 SSH 连接…" });
    const res = await callPlugin("remote.probe", { workspaceId });
    if (!res?.ok || !res.job) {
      if (!dialogMountedRef.current) return;
      setProbeInfo(null);
      setBannerError(res?.error || "测试连接失败");
      return;
    }
    const jobId = res.job.id;
    for (let i = 0; i < 360; i++) {
      await new Promise((r) => setTimeout(r, 350));
      if (!dialogMountedRef.current) return;
      const polled = await callPlugin("remote.job", { jobId });
      if (!dialogMountedRef.current) return;
      const job = polled?.job;
      if (!job) {
        setProbeInfo(null);
        setBannerError("连接测试任务已失效");
        return;
      }
      if (job.status === "connecting") continue;
      if (job.status === "ready" && job.probe) {
        setProbeInfo({
          workspaceId,
          text: `已连接 ${job.probe.hostname} · Python ${job.probe.python} · git ${job.probe.git ? "✓" : "×"} · rg ${job.probe.ripgrep ? "✓" : "×"}`,
        });
      } else {
        setProbeInfo(null);
        setBannerError(job.error || "连接失败");
      }
      return;
    }
    if (dialogMountedRef.current) {
      setProbeInfo(null);
      setBannerError("连接测试超时，请检查主机网络或超时配置");
    }
  };

  const handleDelete = async (ws) => {
    if (confirmDeleteId !== ws.id) {
      setConfirmDeleteId(ws.id);
      return;
    }
    setConfirmDeleteId("");
    setBannerError("");
    const res = await callPlugin("remote.deleteWorkspace", { workspaceId: ws.id });
    if (!res?.ok) {
      setBannerError(res?.error || "删除失败");
      return;
    }
    await onRefresh();
  };

  const handleSave = async (event) => {
    event.preventDefault();
    if (!host.trim() || !path.trim()) return;
    setSaving(true);
    setBannerError("");
    try {
      const res = await callPlugin("remote.saveWorkspace", {
        editingId: editingId || undefined,
        host: host.trim(),
        path: path.trim(),
        name: name.trim() || `${host.trim()}:${path.trim()}`,
        bindNow: !editingId && Boolean(snapshot.activeSessionId),
      });
      if (!res?.ok) {
        setBannerError(res?.error || "保存工作区失败");
        return;
      }
      setFormOpen(false);
      if (res.job) onStartJob(res.job);
      else await onRefresh();
    } finally {
      setSaving(false);
    }
  };

  const handleOpenFiles = async () => {
    await callPlugin("remote.openView", {});
    onClose();
  };

  if (!element) return null;

  return createPortal(
    h(
      "div",
      {
        className: "pir-backdrop",
        onMouseDown: (e) => {
          if (e.target === e.currentTarget) onClose();
        },
      },
      h(
        "div",
        { className: "pir-dialog", role: "dialog", "aria-modal": "true", "aria-label": "SSH 远程工作区" },
        h(
          "div",
          { className: "pir-head" },
          h(
            "div",
            { className: "pir-head-title" },
            h(ServerIcon, { size: 15 }),
            h("span", null, "SSH 远程工作区"),
          ),
          h(
            "div",
            { className: "pir-head-actions" },
            h(
              "button",
              { type: "button", className: "pir-ghost-btn", onClick: handleOpenFiles, title: "在右侧工作面板打开远程文件与 Git 视图" },
              h(FolderOpenIcon, { size: 13 }),
              h("span", null, "右侧文件面板"),
            ),
            h(
              "button",
              { type: "button", className: "pir-close-btn", onClick: onClose, "aria-label": "关闭" },
              "✕",
            ),
          ),
        ),
        h(
          "div",
          { className: "pir-body" },
          boundWorkspace
            ? h(
                "div",
                { className: "pir-active-banner" },
                h("span", { className: "pir-dot pir-dot-ok" }),
                h(
                  "div",
                  { className: "pir-active-copy" },
                  h("strong", null, boundWorkspace.name),
                  h("span", null, `${boundWorkspace.host}:${boundProbe?.root || boundWorkspace.path}`),
                ),
                h(
                  "button",
                  { type: "button", className: "pir-ghost-btn", onClick: handleUnbind },
                  "切回本地",
                ),
              )
            : blockedError
              ? h(
                  "div",
                  { className: "pir-active-banner" },
                  h("span", { className: "pir-dot pir-dot-err" }),
                  h(
                    "div",
                    { className: "pir-active-copy" },
                    h("strong", null, "SSH 远程工作区不可用"),
                    h("span", null, blockedError),
                  ),
                  h(
                    "button",
                    { type: "button", className: "pir-ghost-btn", onClick: handleUnbind },
                    "切回本地",
                  ),
                )
              : h(
                  "div",
                  { className: "pir-subbar" },
                  h(
                    "span",
                    null,
                    snapshot.activeSessionId
                      ? "选择下方工作区即可绑定当前会话（remote_* 与本地工具共存）"
                      : "当前未打开会话，可先管理工作区或打开右侧面板",
                  ),
                ),
          bannerError ? h("div", { className: "pir-alert pir-alert-err" }, bannerError) : null,
          probeInfo ? h("div", { className: "pir-alert pir-alert-ok" }, probeInfo.text) : null,
          (snapshot.workspaces?.length ?? 0) > 0
            ? h(
                "div",
                { className: "pir-list" },
                snapshot.workspaces.map((ws) => {
                  const isBound = boundWorkspace?.id === ws.id;
                  const isBusy = busyWorkspaceId === ws.id;
                  return h(
                    "div",
                    {
                      key: ws.id,
                      className: `pir-item${isBound ? " is-bound" : ""}`,
                    },
                    h(
                      "button",
                      {
                        type: "button",
                        className: "pir-item-main",
                        disabled: Boolean(busyWorkspaceId) || !snapshot.activeSessionId,
                        onClick: () => handleBind(ws.id),
                        title: snapshot.activeSessionId ? "点击绑定到当前会话" : "请先选择聊天会话",
                      },
                      h("span", { className: `pir-dot${isBound ? " pir-dot-ok" : ""}` }),
                      h(
                        "span",
                        { className: "pir-item-text" },
                        h("strong", null, ws.name),
                        h("small", null, `${ws.host} · ${ws.path}`),
                      ),
                      isBusy
                        ? h("span", { className: "pir-badge" }, "连接中…")
                        : isBound
                          ? h("span", { className: "pir-badge pir-badge-ok" }, "当前绑定")
                          : snapshot.activeSessionId
                            ? h("span", { className: "pir-badge pir-badge-hover" }, "绑定")
                            : null,
                    ),
                    h(
                      "div",
                      { className: "pir-item-ops" },
                      h(
                        "button",
                        { type: "button", className: "pir-mini-btn", onClick: () => handleProbe(ws.id), title: "测试连接" },
                        "测试",
                      ),
                      h(
                        "button",
                        { type: "button", className: "pir-mini-btn", onClick: () => openEditForm(ws), title: "编辑" },
                        "编辑",
                      ),
                      h(
                        "button",
                        {
                          type: "button",
                          className: `pir-mini-btn pir-mini-danger${confirmDeleteId === ws.id ? " is-confirming" : ""}`,
                          onClick: () => handleDelete(ws),
                          title: confirmDeleteId === ws.id ? "再次点击确认删除工作区配置" : "删除配置",
                        },
                        confirmDeleteId === ws.id ? "确认?" : "删除",
                      ),
                    ),
                  );
                }),
              )
            : !formOpen
              ? h("div", { className: "pir-empty" }, "暂未保存 SSH 工作区")
              : null,
          formOpen
            ? h(
                "form",
                { className: "pir-form", onSubmit: handleSave },
                h(
                  "div",
                  { className: "pir-form-head" },
                  h("strong", null, editingId ? "编辑远程工作区" : "添加 SSH 工作区"),
                  h(
                    "button",
                    {
                      type: "button",
                      className: "pir-mini-btn",
                      onClick: () => onRefresh(true),
                      title: "重新读取 ~/.ssh/config",
                    },
                    "↻ 刷新 SSH 配置",
                  ),
                ),
                (snapshot.hosts?.length ?? 0) > 0
                  ? h(
                      "div",
                      { className: "pir-chips" },
                      snapshot.hosts.slice(0, 24).map((alias) =>
                        h(
                          "button",
                          {
                            key: alias,
                            type: "button",
                            className: `pir-chip${host === alias ? " is-selected" : ""}`,
                            onClick: () => setHost(alias),
                          },
                          alias,
                        ),
                      ),
                    )
                  : null,
                h(
                  "div",
                  { className: "pir-fields" },
                  h("input", {
                    className: "pir-input",
                    placeholder: "SSH 主机（config 别名或 user@host）",
                    value: host,
                    onChange: (e) => setHost(e.target.value),
                    required: true,
                  }),
                  h("input", {
                    className: "pir-input",
                    placeholder: "远程项目路径，如 ~/projects/my-app",
                    value: path,
                    onChange: (e) => setPath(e.target.value),
                    required: true,
                  }),
                  h("input", {
                    className: "pir-input",
                    placeholder: "显示名称（可选）",
                    value: name,
                    onChange: (e) => setName(e.target.value),
                  }),
                ),
                h(
                  "div",
                  { className: "pir-form-actions" },
                  (snapshot.workspaces?.length ?? 0) > 0
                    ? h(
                        "button",
                        { type: "button", className: "pir-ghost-btn", onClick: () => setFormOpen(false) },
                        "取消",
                      )
                    : null,
                  h(
                    "button",
                    { type: "submit", className: "pir-primary-btn", disabled: saving || !host.trim() || !path.trim() },
                    saving ? "保存中…" : editingId ? "保存修改" : snapshot.activeSessionId ? "保存并绑定" : "保存工作区",
                  ),
                ),
              )
            : null,
        ),
        !formOpen
          ? h(
              "div",
              { className: "pir-foot" },
              h(
                "button",
                { type: "button", className: "pir-ghost-btn", onClick: () => openAddForm("") },
                "＋ 添加 SSH 工作区",
              ),
              h("span", { className: "pir-foot-hint" }, "沿用系统 ~/.ssh/config 与 ssh-agent"),
            )
          : null,
      ),
    ),
    element,
  );
}

function SshComposerPill() {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState({
    workspaces: [],
    hosts: [],
    warnings: [],
    activeSessionId: "",
    state: { mode: "local" },
    activeJob: null,
  });
  const [activeJob, setActiveJob] = useState(null);
  const [bannerError, setBannerError] = useState("");
  const mountedRef = useRef(true);

  const refresh = useCallback(async (refreshHosts = false) => {
    try {
      const res = await callPlugin("remote.state", { refreshHosts });
      if (!mountedRef.current || !res?.ok) return;
      setSnapshot(res);
      if (res.activeJob) setActiveJob(res.activeJob);
    } catch { /* Ignore transient bridge reload. */ }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh(false);
    const onFocus = () => void refresh(false);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh(false);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void refresh(false);
    }, 8000);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!activeJob?.id) return undefined;
    let cancelled = false;
    const poll = async () => {
      while (!cancelled && mountedRef.current) {
        await new Promise((r) => setTimeout(r, 350));
        const res = await callPlugin("remote.job", { jobId: activeJob.id });
        const job = res?.job;
        if (!job || job.status !== "connecting") {
          if (!cancelled && mountedRef.current) {
            if (job?.status === "error") setBannerError(job.error || "SSH 连接失败");
            setActiveJob(null);
            await refresh(false);
          }
          return;
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [activeJob?.id, refresh]);

  const bound = snapshot.state?.mode === "remote" ? snapshot.state.binding : null;
  const blocked = snapshot.state?.mode === "blocked" ? (snapshot.state.error || "远程工作区不可用") : "";
  const isConnecting = Boolean(activeJob && activeJob.status === "connecting");
  const label = isConnecting
    ? "SSH 连接中…"
    : bound
      ? `${bound.workspace.host}:${leafFolder(bound.probe?.root || bound.workspace.path)}`
      : blocked
        ? "SSH 不可用"
        : "SSH";
  const tooltip = bound
    ? `当前会话已绑定 SSH 工作区：${bound.workspace.host}:${bound.probe?.root || bound.workspace.path}（点击切换或打开文件面板）`
    : blocked
      ? `SSH 远程工作区不可用：${blocked}（点击重连或切回本地）`
      : "绑定或切换 SSH 远程工作区";

  return h(
    "span",
    { className: "pir-slot" },
    h(
      "button",
      {
        type: "button",
        className: "pir-pill",
        "data-bound": bound || blocked ? "true" : "false",
        "data-blocked": blocked ? "true" : "false",
        "data-connecting": isConnecting ? "true" : "false",
        title: tooltip,
        "aria-label": tooltip,
        "aria-haspopup": "dialog",
        "aria-expanded": open ? "true" : "false",
        onClick: () => {
          setBannerError("");
          void refresh(false);
          setOpen((v) => !v);
        },
      },
      isConnecting
        ? h("span", { className: "pir-spinner", "aria-hidden": "true" })
        : bound
          ? h("span", { className: "pir-dot pir-dot-ok", "aria-hidden": "true" })
          : blocked
            ? h("span", { className: "pir-dot pir-dot-err", "aria-hidden": "true" })
            : h(ServerIcon, { size: 13.5 }),
      h("span", { className: "pir-pill-label" }, label),
    ),
    open
      ? h(WorkspaceDialog, {
          snapshot,
          onRefresh: refresh,
          onStartJob: (job) => setActiveJob(job),
          busyWorkspaceId: isConnecting ? activeJob.workspaceId : "",
          bannerError,
          setBannerError,
          onClose: () => setOpen(false),
        })
      : null,
  );
}

const COMPOSER_CSS = `
.pir-slot {
  display: inline-flex;
  align-items: center;
}
.pir-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  max-width: 190px;
  padding: 0 9px;
  border: 0;
  border-radius: var(--radius-full, 9999px);
  background: transparent;
  color: var(--ds-text-secondary);
  font: inherit;
  font-size: var(--text-sm, 12px);
  font-weight: var(--font-weight-medium, 500);
  line-height: 1;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.pir-pill:hover {
  background: var(--ds-bg-hover);
  color: var(--ds-text-primary);
}
.pir-pill[data-bound="true"] {
  background: var(--ds-bg-active);
  color: var(--ds-text-primary);
}
.pir-pill-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pir-dot {
  width: 6.5px;
  height: 6.5px;
  border-radius: 50%;
  background: var(--ds-border-strong, #666);
  flex-shrink: 0;
}
.pir-dot-ok {
  background: var(--ds-success, #3fb950);
}
.pir-dot-err {
  background: var(--ds-error, #f85149);
}
.pir-spinner {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.6px solid var(--ds-border-strong, #666);
  border-top-color: var(--ds-text-primary);
  animation: pir-spin 0.75s linear infinite;
  flex-shrink: 0;
}
@keyframes pir-spin {
  to { transform: rotate(360deg); }
}
.pir-backdrop {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: var(--ds-scrim, rgba(0, 0, 0, 0.34));
  backdrop-filter: blur(2px);
}
.pir-dialog {
  width: min(468px, calc(100vw - 32px));
  max-height: min(74vh, 580px);
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-lg, 16px);
  border: 1px solid var(--ds-border-strong, var(--ds-border-default));
  background: var(--ds-bg-elevated-opaque, #212121);
  color: var(--ds-text-primary);
  box-shadow: var(--ds-shadow-dialog, 0 20px 48px rgba(0, 0, 0, 0.35));
  font-size: var(--text-sm, 12px);
  overflow: hidden;
}
.pir-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--ds-border-subtle);
}
.pir-head-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: var(--text-md, 13px);
  font-weight: var(--font-weight-semibold, 600);
}
.pir-head-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.pir-close-btn {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-2xs, 6px);
  background: transparent;
  color: var(--ds-text-secondary);
  cursor: pointer;
}
.pir-close-btn:hover {
  background: var(--ds-bg-hover);
  color: var(--ds-text-primary);
}
.pir-body {
  padding: 12px 14px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pir-active-banner {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 11px;
  border-radius: var(--radius-sm, 10px);
  background: var(--ds-tile, var(--ds-bg-hover));
  border: 1px solid var(--ds-border-default);
}
.pir-active-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pir-active-copy strong {
  font-weight: var(--font-weight-medium, 500);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pir-active-copy span {
  color: var(--ds-text-muted);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pir-subbar {
  color: var(--ds-text-muted);
  font-size: 11.5px;
  line-height: 1.45;
}
.pir-alert {
  padding: 8px 10px;
  border-radius: var(--radius-xs, 8px);
  font-size: 11.5px;
  line-height: 1.45;
  border: 1px solid var(--ds-border-default);
}
.pir-alert-err {
  color: var(--ds-error, #f85149);
  background: color-mix(in oklab, var(--ds-error, #f85149) 10%, transparent);
}
.pir-alert-ok {
  color: var(--ds-success, #3fb950);
  background: color-mix(in oklab, var(--ds-success, #3fb950) 10%, transparent);
}
.pir-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pir-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px;
  border-radius: var(--radius-sm, 10px);
  border: 1px solid transparent;
}
.pir-item:hover {
  background: var(--ds-bg-hover);
}
.pir-item.is-bound {
  background: var(--ds-tile, var(--ds-bg-active));
  border-color: var(--ds-border-default);
}
.pir-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 5px 6px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.pir-item-main:disabled {
  cursor: default;
}
.pir-item-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.pir-item-text strong {
  font-size: 12.5px;
  font-weight: var(--font-weight-medium, 500);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pir-item-text small {
  color: var(--ds-text-muted);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pir-badge {
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--ds-bg-chip, var(--ds-bg-hover));
  color: var(--ds-text-secondary);
  font-size: 10.5px;
  white-space: nowrap;
}
.pir-badge-ok {
  color: var(--ds-success, #3fb950);
}
.pir-badge-hover {
  opacity: 0;
  transition: opacity 0.12s ease;
}
.pir-item:hover .pir-badge-hover {
  opacity: 1;
}
.pir-item-ops {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.pir-mini-btn {
  padding: 3px 6px;
  border: 0;
  border-radius: var(--radius-3xs, 4px);
  background: transparent;
  color: var(--ds-text-muted);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.pir-mini-btn:hover {
  background: var(--ds-bg-active);
  color: var(--ds-text-primary);
}
.pir-mini-danger:hover,
.pir-mini-danger.is-confirming {
  color: var(--ds-error, #f85149);
  font-weight: var(--font-weight-medium, 500);
}
.pir-empty {
  padding: 18px 12px;
  text-align: center;
  color: var(--ds-text-muted);
}
.pir-form {
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 11px;
  border-radius: var(--radius-sm, 10px);
  border: 1px solid var(--ds-border-default);
  background: var(--ds-tile, transparent);
}
.pir-form-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.pir-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  max-height: 76px;
  overflow-y: auto;
}
.pir-chip {
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--ds-border-default);
  background: var(--ds-bg-chip, transparent);
  color: var(--ds-text-secondary);
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  cursor: pointer;
}
.pir-chip:hover, .pir-chip.is-selected {
  border-color: var(--ds-border-strong);
  background: var(--ds-bg-active);
  color: var(--ds-text-primary);
}
.pir-fields {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.pir-input {
  width: 100%;
  padding: 7px 10px;
  border-radius: var(--radius-xs, 8px);
  border: 1px solid var(--ds-border-default);
  background: var(--ds-field-inset-bg, var(--ds-bg-inset, transparent));
  color: var(--ds-text-primary);
  font: inherit;
  font-size: 12px;
  outline: none;
}
.pir-input:focus {
  border-color: var(--ds-border-strong);
  background: var(--ds-field-inset-focus-bg, transparent);
}
.pir-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 7px;
}
.pir-ghost-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: var(--radius-xs, 8px);
  border: 1px solid var(--ds-border-default);
  background: transparent;
  color: var(--ds-text-secondary);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.pir-ghost-btn:hover {
  background: var(--ds-bg-hover);
  color: var(--ds-text-primary);
}
.pir-primary-btn {
  padding: 5px 12px;
  border-radius: var(--radius-xs, 8px);
  border: 0;
  background: var(--ds-accent, #ededed);
  color: var(--ds-bg-primary, #181818);
  font: inherit;
  font-size: 11.5px;
  font-weight: var(--font-weight-medium, 500);
  cursor: pointer;
}
.pir-primary-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.pir-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px;
  border-top: 1px solid var(--ds-border-subtle);
}
.pir-foot-hint {
  color: var(--ds-text-muted);
  font-size: 11px;
}
`;

export function onLoad(pi) {
  hostApi = pi;
  pi.ui.injectStyle(COMPOSER_CSS);
  pi.slots.register({
    slot: "composerControl",
    positions: ["left"],
    component: SshComposerPill,
  });
}

export function onUnload() {
  hostApi = null;
}
