"use strict";

const $ = (id) => document.getElementById(id);
const bridge = window.pluginBridge;
const Core = window.PiRemoteWorkbenchCore;

let state = { config: { workspaces: [] }, inventory: { hosts: [], warnings: [] } };
let session = { active: null, sessionId: "", state: { mode: "local" } };
let selected = null;
let directory = ".";
let openDoc = null;
let currentViewPath = "";
let editingId = "";
let activeGitAction = "status";
let execController = null;
let toastTimer = null;
let readSeq = 0;
let nextReqId = 0;
let lastBoundWorkspaceId = "";
let prevActiveTurnId = "";

function invoke(channel, payload = {}) {
  if (!bridge?.invoke) throw new Error("请在 PI-Desktop 工作面板中打开此视图");
  return bridge.invoke(channel, payload);
}

async function api(path, method = "GET", data, signal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const requestId = signal ? `wb-${++nextReqId}-${Date.now()}` : undefined;
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      if (requestId) void invoke("pi-remote.cancel", { requestId }).catch(() => {});
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    invoke("pi-remote.api", { path, method, data, ...(requestId ? { requestId } : {}) }).then(
      (res) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(res);
      },
      (err) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function applyAppearance(appearance) {
  const base = appearance?.base === "light" || appearance?.base === "dark"
    ? appearance.base
    : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.base = base;
  document.documentElement.style.colorScheme = base;
}

function initAppearanceSync() {
  const pull = () => invoke("app.getAppearance").then(applyAppearance).catch(() => applyAppearance(null));
  void pull();
  bridge?.on?.("appearance:changed", applyAppearance);
  window.setInterval(() => {
    if (document.visibilityState !== "hidden") void pull();
  }, 10000);
}

function toast(msg, isError = false) {
  const elNode = $("toast");
  elNode.textContent = msg;
  elNode.className = isError ? "wb-toast is-err" : "wb-toast";
  elNode.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { elNode.hidden = true; }, isError ? 6000 : 3200);
}

const runSafe = (fn) => async (event) => {
  event?.preventDefault();
  try {
    await fn(event);
  } catch (err) {
    if (err?.name !== "AbortError") toast(err.message || String(err), true);
  }
};

const isDirty = () => Boolean(openDoc && $("editor-input").value !== openDoc.saved);
const canDiscard = () => !isDirty() || confirm("当前文件有未保存的改动，确定放弃吗？");
const wsPath = (action) => `/api/workspaces/${encodeURIComponent(selected.id)}/${action}`;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function clearEditor() {
  readSeq += 1;
  openDoc = null;
  currentViewPath = "";
  $("editor-path").textContent = "选择左侧文件查看或编辑";
  $("editor-input").readOnly = false;
  $("editor-input").hidden = true;
  $("editor-empty").hidden = false;
  $("save-file").disabled = true;
  $("reload-file").disabled = true;
  $("rename-file").disabled = true;
  $("delete-file").disabled = true;
  $("editor-dirty").hidden = true;
  syncActiveTreeRow();
}

function syncDirtyState() {
  const dirty = isDirty();
  $("editor-dirty").hidden = !dirty;
  $("save-file").disabled = !dirty;
}

function syncActiveTreeRow() {
  for (const row of $("file-list").querySelectorAll(".wb-entry")) {
    row.classList.toggle("active", Boolean(currentViewPath && row.dataset.path === currentViewPath));
  }
}

function switchTab(tabName) {
  for (const btn of document.querySelectorAll("[data-tab]")) {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle("active", active);
    $(`tab-${btn.dataset.tab}`).hidden = !active;
  }
}

function renderHostPills(container, onPick) {
  const hosts = state.inventory?.hosts ?? [];
  container.replaceChildren(
    ...hosts.slice(0, 20).map((h) => {
      const btn = el("button", h.alias, "wb-host-pill");
      btn.type = "button";
      btn.title = `${h.source}:${h.line}`;
      btn.onclick = () => onPick(h.alias);
      return btn;
    }),
  );
}

function renderSessionChip() {
  const chip = $("session-chip");
  if (!selected || !session.sessionId) {
    chip.hidden = true;
    return;
  }
  chip.hidden = false;
  const boundId = session.state?.mode === "remote" ? session.state.binding?.workspace?.id : "";
  if (boundId === selected.id) {
    chip.textContent = "● 已绑定会话";
    chip.className = "wb-chip is-bound";
    chip.title = "当前聊天会话已绑定此 SSH 工作区（点击取消绑定）";
  } else {
    chip.textContent = "绑定当前会话";
    chip.className = "wb-chip";
    chip.title = "将此 SSH 工作区绑定到当前聊天会话";
  }
}

function renderWorkspaceChrome() {
  const workspaces = state.config.workspaces;
  const select = $("ws-select");
  select.replaceChildren(
    ...workspaces.map((ws) => {
      const opt = el("option", `${ws.name} (${ws.host})`);
      opt.value = ws.id;
      return opt;
    }),
  );
  if (!workspaces.length) {
    const emptyOpt = el("option", "未配置工作区");
    emptyOpt.value = "";
    select.append(emptyOpt);
  }
  select.disabled = workspaces.length === 0;
  if (selected) select.value = selected.id;

  const hasSelected = Boolean(selected);
  $("empty-view").hidden = hasSelected;
  $("main-view").hidden = !hasSelected;
  $("ws-edit").disabled = !hasSelected;
  $("probe-btn").disabled = !hasSelected;

  if (!hasSelected) {
    renderHostPills($("empty-hosts"), (alias) => openWorkspaceDialog(null, alias));
  }
  renderSessionChip();
}

async function selectWorkspace(ws) {
  if (!ws || selected?.id === ws.id) return;
  if (!canDiscard()) {
    if (selected) $("ws-select").value = selected.id;
    return;
  }
  execController?.abort();
  selected = ws;
  directory = ".";
  clearEditor();
  $("conn-badge").textContent = `${ws.host}:${ws.path}`;
  $("conn-badge").className = "wb-meta";
  $("git-output").textContent = "点击上方按钮读取远程 Git 状态或差异。";
  $("search-output").textContent = "输入关键词搜索远程工作区，点击结果可直接打开对应文件。";
  $("exec-output").textContent = "远程命令输出显示在这里（上限 1 MiB）。";
  renderWorkspaceChrome();
  await loadDirectory();
}

async function refreshBoundAfterTurn() {
  if (!selected) return;
  await loadDirectory().catch(() => {});
  if (currentViewPath && !isDirty()) {
    await openFile(currentViewPath, true).catch(() => {});
  }
  if (!$("tab-git").hidden) {
    await loadGit(activeGitAction).catch(() => {});
  }
}

async function syncSessionState(followBoundWorkspace = false) {
  try {
    session = await invoke("pi-remote.sessionStatus");
  } catch {
    session = { active: null, sessionId: "", state: { mode: "local" } };
  }
  const nextTurnId = session.active?.activeTurn?.turnId || "";
  const turnJustCompleted = Boolean(prevActiveTurnId && !nextTurnId);
  prevActiveTurnId = nextTurnId;

  const boundId = session.state?.mode === "remote" ? session.state.binding?.workspace?.id : "";
  if (boundId && boundId !== lastBoundWorkspaceId) {
    lastBoundWorkspaceId = boundId;
    if (followBoundWorkspace && !isDirty()) {
      const target = state.config.workspaces.find((w) => w.id === boundId);
      if (target && target.id !== selected?.id) {
        await selectWorkspace(target);
        return;
      }
    }
  } else if (!boundId) {
    lastBoundWorkspaceId = "";
  }
  renderSessionChip();
  if (turnJustCompleted && selected && boundId === selected.id) {
    await refreshBoundAfterTurn();
  }
}

async function refreshAll(followSession = false) {
  state = await api("/api/state");
  if (selected) {
    selected = state.config.workspaces.find((w) => w.id === selected.id) || null;
  }
  await syncSessionState(followSession);
  if (!selected && state.config.workspaces.length > 0) {
    const boundId = session.state?.mode === "remote" ? session.state.binding?.workspace?.id : "";
    const initial = (boundId && state.config.workspaces.find((w) => w.id === boundId)) || state.config.workspaces[0];
    await selectWorkspace(initial);
    return;
  }
  renderWorkspaceChrome();
}

async function loadDirectory() {
  if (!selected) return;
  const wsId = selected.id;
  const targetDir = directory;
  $("file-list").textContent = "读取中…";
  const entries = await api(wsPath("list"), "POST", { path: targetDir });
  if (selected?.id !== wsId || directory !== targetDir) return;
  $("dir-label").textContent = targetDir === "." ? "/" : `/${targetDir}`;
  $("dir-label").title = targetDir;
  $("up-dir").disabled = targetDir === ".";

  const sorted = [...entries].sort((a, b) => {
    if (Boolean(a.escaped) !== Boolean(b.escaped)) return a.escaped ? 1 : -1;
    if (a.directory !== b.directory) return a.directory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  $("file-list").replaceChildren(
    ...sorted.map((entry) => {
      const rel = targetDir === "." ? entry.name : `${targetDir}/${entry.name}`;
      const btn = el(
        "button",
        undefined,
        `wb-entry${entry.directory ? " is-dir" : ""}${entry.escaped ? " is-escaped" : ""}${currentViewPath === rel ? " active" : ""}`,
      );
      btn.type = "button";
      btn.dataset.path = rel;
      btn.append(
        el("span", entry.escaped ? "⚠" : entry.directory ? "▸" : entry.symlink ? "↗" : "·", "wb-entry-icon"),
        el("span", entry.escaped ? `${entry.name} (越界软链)` : entry.name, "wb-entry-name"),
      );
      btn.onclick = runSafe(async () => {
        if (entry.escaped) {
          toast(`软链接 ${entry.name} 指向工作区外部，已被安全策略阻止`, true);
          return;
        }
        if (entry.directory) {
          directory = rel;
          await loadDirectory();
        } else {
          await openFile(rel);
        }
      });
      return btn;
    }),
  );
  if (!sorted.length) {
    $("file-list").append(el("div", "空目录", "wb-hint"));
  }
}

async function jumpToFile(relPath, lineNumber = 0) {
  switchTab("files");
  const slash = relPath.lastIndexOf("/");
  directory = slash > 0 ? relPath.slice(0, slash) : ".";
  await loadDirectory();
  await openFile(relPath, false, lineNumber);
}

async function openFile(relPath, force = false, lineNumber = 0) {
  if (!selected) return;
  if (!force && !canDiscard()) return;
  const wsId = selected.id;
  const seq = ++readSeq;
  const result = await api(wsPath("read"), "POST", {
    path: relPath,
    maxEditableBytes: Core.MAX_INLINE_EDITOR_BYTES,
    previewBytes: Core.PREVIEW_HEAD_BYTES,
  });
  if (selected?.id !== wsId || seq !== readSeq) return;
  const decoded = Core.decodeRemoteDocument(relPath, result, Core.PREVIEW_HEAD_BYTES);
  const textarea = $("editor-input");
  currentViewPath = relPath;
  $("rename-file").disabled = false;
  $("delete-file").disabled = false;

  if (decoded.kind === "preview") {
    textarea.value = decoded.text;
    textarea.readOnly = true;
    openDoc = null;
    $("editor-path").textContent = decoded.label;
    $("editor-path").title = decoded.label;
    $("editor-empty").hidden = true;
    textarea.hidden = false;
    $("save-file").disabled = true;
    $("reload-file").disabled = false;
    $("editor-dirty").hidden = true;
    syncActiveTreeRow();
    return;
  }

  textarea.readOnly = false;
  textarea.value = decoded.text;
  openDoc = { path: relPath, etag: decoded.etag, saved: textarea.value, crlf: decoded.crlf, hasBom: decoded.hasBom };
  $("editor-path").textContent = relPath;
  $("editor-path").title = relPath;
  $("editor-empty").hidden = true;
  textarea.hidden = false;
  $("reload-file").disabled = false;
  syncActiveTreeRow();
  syncDirtyState();
  Core.scrollTextareaToLine(textarea, lineNumber, 19.2);
}

const gitClasses = {
  add: "wb-diff-add",
  del: "wb-diff-del",
  hunk: "wb-diff-hunk",
  hint: "wb-hint",
  statusBranch: "wb-git-branch",
  statusRow: "wb-git-row",
  statusMainBtn: "wb-git-main",
  statusCode: "wb-git-code",
  statusPath: "wb-git-path",
  miniBtn: "wb-btn",
  diffToolbar: "wb-diff-toolbar",
  diffHeaderLabel: "wb-diff-title",
  diffFileBtn: "wb-diff-file",
};

async function inspectSingleFileDiff(change) {
  if (!selected) return;
  const wsId = selected.id;
  $("git-output").textContent = `正在读取 ${change.path} 的变更…`;
  const [unstaged, staged] = await Promise.all([
    api(wsPath("git"), "POST", { action: "diff", path: change.path }),
    api(wsPath("git"), "POST", { action: "staged", path: change.path }),
  ]);
  if (selected?.id !== wsId) return;
  const combined = [
    unstaged.text?.trim() ? `# 工作区未暂存变更 (${change.path})\n${unstaged.text.trim()}` : "",
    staged.text?.trim() ? `# 暂存区变更 (${change.path})\n${staged.text.trim()}` : "",
  ].filter(Boolean).join("\n\n");
  if (!combined && change.code === "??") {
    await jumpToFile(change.path);
    return;
  }
  Core.renderDiffLines($("git-output"), {
    text: combined,
    classes: gitClasses,
    emptyText: `${change.path} 暂无文本 Diff`,
    headerTitle: `[${change.code}] ${change.path}`,
    onBack: () => { void runSafe(() => loadGit("status"))(); },
    onOpenFile: (rel) => { void runSafe(() => jumpToFile(rel))(); },
  });
}

async function loadGit(action = activeGitAction) {
  if (!selected) return;
  activeGitAction = action;
  for (const btn of document.querySelectorAll("[data-git]")) {
    btn.classList.toggle("active", btn.dataset.git === action);
  }
  const wsId = selected.id;
  $("git-output").textContent = "正在读取远程 Git…";
  const res = await api(wsPath("git"), "POST", { action });
  if (selected?.id !== wsId) return;
  if (action === "status") {
    Core.renderGitStatusInteractive($("git-output"), {
      text: res.text || "",
      truncated: res.truncated,
      classes: gitClasses,
      onInspectFileDiff: (item) => { void runSafe(() => inspectSingleFileDiff(item))(); },
      onOpenFile: (rel) => { void runSafe(() => jumpToFile(rel))(); },
    });
    return;
  }
  const raw = (res.text || "") + (res.truncated ? "\n[输出已截断]" : "");
  Core.renderDiffLines($("git-output"), {
    text: raw,
    classes: gitClasses,
    emptyText: "工作区干净，没有未提交改动。",
    onOpenFile: (rel) => { void runSafe(() => jumpToFile(rel))(); },
  });
}

const previewSshHost = Core.createHostPreviewer({
  resolveHost: (host, signal) => api("/api/resolve", "POST", { host }, signal),
  onPreview: (text) => { $("host-preview").textContent = text; },
  prefixLabel: "目标：",
  jumpLabel: "Jump",
  delayMs: 200,
});

function openWorkspaceDialog(ws = null, presetHost = "") {
  editingId = ws?.id || "";
  const form = $("ws-form");
  form.reset();
  form.elements.namedItem("host").value = ws?.host || presetHost;
  form.elements.namedItem("path").value = ws?.path || "";
  form.elements.namedItem("name").value = ws?.name || "";
  form.elements.namedItem("id").value = ws?.id || "";
  $("ws-dialog-title").textContent = ws ? "编辑远程工作区" : "添加 SSH 工作区";
  $("ws-delete").hidden = !ws;
  $("ws-error").textContent = "";
  $("host-preview").textContent = "";
  renderHostPills($("dialog-hosts"), (alias) => {
    form.elements.namedItem("host").value = alias;
    previewSshHost(alias);
  });
  previewSshHost(form.elements.namedItem("host").value);
  $("ws-dialog").showModal();
}

// Event bindings
$("toggle-tree").onclick = () => $("file-sidebar").classList.toggle("is-collapsed");
$("ws-select").onchange = runSafe(async (e) => {
  const target = state.config.workspaces.find((w) => w.id === e.target.value);
  if (target) await selectWorkspace(target);
});
$("ws-add").onclick = () => openWorkspaceDialog(null);
$("empty-add").onclick = () => openWorkspaceDialog(null);
$("ws-edit").onclick = () => { if (selected) openWorkspaceDialog(selected); };
$("ws-form").elements.namedItem("host").addEventListener("input", (e) => previewSshHost(e.target.value));

for (const btn of document.querySelectorAll("[data-close]")) {
  btn.onclick = () => $(btn.dataset.close).close();
}

$("ws-form").onsubmit = async (e) => {
  e.preventDefault();
  $("ws-error").textContent = "";
  const data = Object.fromEntries(new FormData(e.currentTarget));
  if (!data.name?.trim()) data.name = `${data.host.trim()}:${data.path.trim()}`;
  try {
    const saved = await api(editingId ? `/api/workspaces/${encodeURIComponent(editingId)}` : "/api/workspaces", editingId ? "PUT" : "POST", data);
    $("ws-dialog").close();
    if (selected?.id === editingId) {
      selected = null;
      clearEditor();
    }
    await refreshAll(false);
    const next = state.config.workspaces.find((w) => w.id === saved.id);
    if (next) await selectWorkspace(next);
    toast("工作区已保存");
  } catch (err) {
    $("ws-error").textContent = err.message;
  }
};

$("ws-delete").onclick = runSafe(async () => {
  if (!editingId || !confirm("确定删除此工作区配置吗？（不影响远程文件）")) return;
  await api(`/api/workspaces/${encodeURIComponent(editingId)}`, "DELETE");
  $("ws-dialog").close();
  if (selected?.id === editingId) {
    selected = null;
    clearEditor();
  }
  await refreshAll(false);
  toast("工作区已删除");
});

$("open-settings").onclick = () => {
  const form = $("settings-form");
  form.elements.namedItem("sshConfigPath").value = state.config.sshConfigPath || "";
  form.elements.namedItem("anchorRoot").value = state.config.anchorRoot || "";
  form.elements.namedItem("connectTimeoutSeconds").value = state.config.connectTimeoutSeconds;
  form.elements.namedItem("commandTimeoutSeconds").value = state.config.commandTimeoutSeconds;
  $("settings-error").textContent = "";
  $("settings-dialog").showModal();
};

$("settings-form").onsubmit = async (e) => {
  e.preventDefault();
  $("settings-error").textContent = "";
  const data = Object.fromEntries(new FormData(e.currentTarget));
  data.connectTimeoutSeconds = Number(data.connectTimeoutSeconds);
  data.commandTimeoutSeconds = Number(data.commandTimeoutSeconds);
  try {
    await api("/api/config", "PUT", data);
    $("settings-dialog").close();
    await refreshAll(false);
    toast("连接设置已更新");
  } catch (err) {
    $("settings-error").textContent = err.message;
  }
};

$("session-chip").onclick = runSafe(async () => {
  if (!selected || !session.sessionId) return;
  const boundId = session.state?.mode === "remote" ? session.state.binding?.workspace?.id : "";
  if (boundId === selected.id) {
    await invoke("pi-remote.unbindSession", {});
    await syncSessionState(false);
    toast("已取消当前会话绑定");
  } else {
    $("session-chip").disabled = true;
    try {
      const res = await invoke("pi-remote.bindSession", { workspaceId: selected.id });
      $("conn-badge").textContent = `● ${res.probe.hostname}`;
      $("conn-badge").className = "wb-meta is-ok";
      await syncSessionState(false);
      toast(`已绑定到当前会话：${selected.host}:${res.probe.root}`);
    } finally {
      $("session-chip").disabled = false;
    }
  }
});

$("probe-btn").onclick = runSafe(async () => {
  if (!selected) return;
  const id = selected.id;
  $("conn-badge").textContent = "连接测试中…";
  const probe = await api(wsPath("probe"), "POST", {});
  if (selected?.id !== id) return;
  $("conn-badge").textContent = `● ${probe.hostname} · py${probe.python}`;
  $("conn-badge").className = "wb-meta is-ok";
  toast(`连接正常：${probe.hostname} (${probe.root})`);
});

$("popout-btn").onclick = runSafe(async () => {
  await invoke("pi-remote.openWindow", {});
});

for (const btn of document.querySelectorAll("[data-tab]")) {
  btn.onclick = () => {
    switchTab(btn.dataset.tab);
    if (btn.dataset.tab === "git" && $("git-output").textContent.startsWith("点击上方")) {
      void runSafe(() => loadGit("status"))();
    }
  };
}

$("up-dir").onclick = runSafe(async () => {
  directory = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : ".";
  await loadDirectory();
});
$("refresh-dir").onclick = runSafe(loadDirectory);

$("new-folder").onclick = runSafe(async () => {
  const raw = prompt(`在 ${directory === "." ? "/" : `/${directory}`} 下新建文件夹：`, "");
  const rel = (raw || "").trim().replace(/^\/+/, "");
  if (!rel) return;
  const target = directory === "." ? rel : `${directory}/${rel}`;
  await api(wsPath("mkdir"), "POST", { path: target });
  directory = target;
  await loadDirectory();
  toast(`已创建文件夹 ${target}`);
});

$("new-file").onclick = () => {
  if (!canDiscard()) return;
  $("newfile-form").reset();
  $("newfile-error").textContent = "";
  $("newfile-dir").textContent = `新建文件（当前目录：${directory === "." ? "/" : `/${directory}`}）`;
  $("newfile-dialog").showModal();
  $("newfile-form").elements.namedItem("relPath").focus();
};

$("newfile-form").onsubmit = async (e) => {
  e.preventDefault();
  $("newfile-error").textContent = "";
  const rel = String(new FormData(e.currentTarget).get("relPath") || "").trim().replace(/^\/+/, "");
  if (!rel) return;
  const target = directory === "." ? rel : `${directory}/${rel}`;
  try {
    await api(wsPath("write"), "POST", { path: target, etag: null, content: "" });
    $("newfile-dialog").close();
    await loadDirectory();
    await openFile(target, true);
    $("editor-input").focus();
    toast(`已创建 ${target}`);
  } catch (err) {
    $("newfile-error").textContent = err.message;
  }
};

$("rename-file").onclick = runSafe(async () => {
  if (!currentViewPath || !canDiscard()) return;
  const nextRaw = prompt("输入新的远程相对路径：", currentViewPath);
  const nextPath = (nextRaw || "").trim().replace(/^\/+/, "");
  if (!nextPath || nextPath === currentViewPath) return;
  await api(wsPath("rename"), "POST", { path: currentViewPath, newPath: nextPath });
  const slash = nextPath.lastIndexOf("/");
  directory = slash > 0 ? nextPath.slice(0, slash) : ".";
  await loadDirectory();
  await openFile(nextPath, true);
  toast(`已重命名为 ${nextPath}`);
});

$("delete-file").onclick = runSafe(async () => {
  if (!currentViewPath) return;
  if (!confirm(`确定永久删除远程文件「${currentViewPath}」吗？此操作不可撤销。`)) return;
  const deleted = currentViewPath;
  await api(wsPath("delete"), "POST", { path: deleted });
  clearEditor();
  await loadDirectory();
  toast(`已删除 ${deleted}`);
});

$("editor-input").oninput = syncDirtyState;
$("editor-input").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (!$("save-file").disabled) $("save-file").click();
  }
});
$("reload-file").onclick = runSafe(async () => {
  if (currentViewPath && canDiscard()) await openFile(currentViewPath, true);
});
$("save-file").onclick = runSafe(async () => {
  if (!openDoc || !selected) return;
  const doc = openDoc;
  const wsId = selected.id;
  const raw = $("editor-input").value;
  $("save-file").disabled = true;
  try {
    const payload = Core.encodeRemoteSave(doc, raw);
    const outcome = await Core.saveWithConflictConfirm(
      (useEtag) => api(wsPath("write"), "POST", { path: doc.path, ...(useEtag ? { etag: doc.etag } : {}), content: payload }),
      `远程文件 ${doc.path} 在编辑期间已被修改（如 Agent 刚刚更新），是否强制覆盖保存？`,
    );
    if (outcome.saved && selected?.id === wsId && openDoc === doc) {
      openDoc.etag = outcome.result.etag;
      openDoc.saved = raw;
      toast(outcome.forced ? "已强制覆盖保存到远程主机" : "已保存到远程主机");
    }
  } finally {
    syncDirtyState();
  }
});

for (const btn of document.querySelectorAll("[data-git]")) {
  btn.onclick = runSafe(() => loadGit(btn.dataset.git));
}
$("refresh-git").onclick = runSafe(() => loadGit(activeGitAction));

const syncSearchMode = () => {
  const isFind = $("search-mode").value === "find";
  $("search-literal").disabled = isFind;
  $("search-icase").disabled = isFind;
  $("search-glob").disabled = isFind;
};
$("search-mode").onchange = syncSearchMode;
syncSearchMode();

$("search-form").onsubmit = runSafe(async () => {
  if (!selected) return;
  const wsId = selected.id;
  const mode = $("search-mode").value;
  const glob = $("search-glob").value.trim();
  $("search-output").textContent = "正在搜索…";
  const res = await api(wsPath("search"), "POST", {
    pattern: $("search-input").value,
    mode,
    ...(mode === "grep" && glob ? { glob } : {}),
    literal: $("search-literal").checked,
    ignoreCase: $("search-icase").checked,
    limit: 200,
  });
  if (selected?.id === wsId) {
    Core.renderSearchHits($("search-output"), {
      text: res.text,
      mode,
      truncated: res.truncated,
      classes: { hit: "wb-hit", hitPath: "wb-hit-path", hint: "wb-hint" },
      emptyText: "没有找到匹配项。",
      onOpenHit: (relPath, lineNo) => { void runSafe(() => jumpToFile(relPath, lineNo))(); },
    });
  }
});

$("exec-form").onsubmit = runSafe(async () => {
  if (!selected || execController) return;
  const controller = new AbortController();
  const wsId = selected.id;
  execController = controller;
  $("exec-run").disabled = true;
  $("exec-cancel").hidden = false;
  $("exec-output").textContent = "执行中…";
  try {
    const res = await api(wsPath("exec"), "POST", { command: $("exec-input").value }, controller.signal);
    if (selected?.id === wsId) $("exec-output").textContent = `${res.text || "(无输出)"}\n\n[exit ${res.exitCode}]`;
  } catch (err) {
    if (selected?.id === wsId) $("exec-output").textContent = err?.name === "AbortError" ? "已取消执行" : err.message;
  } finally {
    execController = null;
    $("exec-run").disabled = false;
    $("exec-cancel").hidden = true;
  }
});
$("exec-cancel").onclick = () => execController?.abort();

window.addEventListener("beforeunload", (event) => {
  if (isDirty()) {
    event.preventDefault();
    event.returnValue = "";
  }
});

if (document.documentElement.dataset.piPluginPanelShape === "view") {
  $("popout-btn").hidden = false;
}
initAppearanceSync();
bridge?.on?.("session:activated", () => { void syncSessionState(true); });
window.addEventListener("focus", () => { void syncSessionState(true); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void syncSessionState(true);
});
window.setInterval(() => {
  if (document.visibilityState !== "hidden") void syncSessionState(true);
}, 4000);

void runSafe(() => refreshAll(true))();
