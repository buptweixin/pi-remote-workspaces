"use strict";

const $ = (id) => document.getElementById(id);
const bridge = window.pluginBridge;

let state = { config: { workspaces: [] }, inventory: { hosts: [], warnings: [] } };
let session = { active: null, sessionId: "", state: { mode: "local" } };
let selected = null;
let directory = ".";
let openDoc = null;
let editingId = "";
let activeGitAction = "status";
let execController = null;
let resolveTimer = null;
let resolveController = null;
let toastTimer = null;
let readSeq = 0;
let lastBoundWorkspaceId = "";

function invoke(channel, payload = {}) {
  if (!bridge?.invoke) throw new Error("请在 PI-Desktop 工作面板中打开此视图");
  return bridge.invoke(channel, payload);
}

async function api(path, method = "GET", data, signal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    invoke("pi-remote.api", { path, method, data }).then(
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
  window.setInterval(pull, 2500);
}

function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.className = isError ? "wb-toast is-err" : "wb-toast";
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3200);
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
  $("editor-path").textContent = "选择左侧文件查看或编辑";
  $("editor-input").hidden = true;
  $("editor-empty").hidden = false;
  $("save-file").disabled = true;
  $("reload-file").disabled = true;
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
    row.classList.toggle("active", Boolean(openDoc && row.dataset.path === openDoc.path));
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

async function syncSessionState(followBoundWorkspace = false) {
  try {
    session = await invoke("pi-remote.sessionStatus");
  } catch {
    session = { active: null, sessionId: "", state: { mode: "local" } };
  }
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

  const sorted = [...entries].filter((e) => !e.escaped).sort((a, b) => {
    if (a.directory !== b.directory) return a.directory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  $("file-list").replaceChildren(
    ...sorted.map((entry) => {
      const rel = targetDir === "." ? entry.name : `${targetDir}/${entry.name}`;
      const btn = el("button", undefined, `wb-entry${entry.directory ? " is-dir" : ""}${openDoc?.path === rel ? " active" : ""}`);
      btn.type = "button";
      btn.dataset.path = rel;
      btn.append(
        el("span", entry.directory ? "▸" : entry.symlink ? "↗" : "·", "wb-entry-icon"),
        el("span", entry.name, "wb-entry-name"),
      );
      btn.onclick = runSafe(async () => {
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

async function openFile(relPath, force = false, lineNumber = 0) {
  if (!selected) return;
  if (!force && !canDiscard()) return;
  const wsId = selected.id;
  const seq = ++readSeq;
  const result = await api(wsPath("read"), "POST", { path: relPath });
  if (selected?.id !== wsId || seq !== readSeq) return;
  const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0));
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.includes("\0")) throw new Error("二进制文件暂不支持文本编辑");
  const crlf = text.includes("\r\n") && !text.replaceAll("\r\n", "").includes("\n");

  const textarea = $("editor-input");
  textarea.value = text;
  openDoc = { path: relPath, etag: result.etag, saved: textarea.value, crlf };
  $("editor-path").textContent = relPath;
  $("editor-path").title = relPath;
  $("editor-empty").hidden = true;
  textarea.hidden = false;
  $("reload-file").disabled = false;
  syncActiveTreeRow();
  syncDirtyState();

  if (lineNumber > 1) {
    const lines = textarea.value.split("\n");
    let pos = 0;
    for (let i = 0; i < Math.min(lineNumber - 1, lines.length); i++) pos += lines[i].length + 1;
    textarea.focus();
    textarea.setSelectionRange(pos, pos);
    const approxLineHeight = 19.2;
    textarea.scrollTop = Math.max(0, (lineNumber - 4) * approxLineHeight);
  }
}

function renderGitDiff(text) {
  const container = $("git-output");
  if (!text) {
    container.textContent = "工作区干净，没有未提交改动。";
    return;
  }
  container.replaceChildren(
    ...text.split("\n").map((line) => {
      const cls = line.startsWith("+") && !line.startsWith("+++")
        ? "wb-diff-add"
        : line.startsWith("-") && !line.startsWith("---")
          ? "wb-diff-del"
          : line.startsWith("@@")
            ? "wb-diff-hunk"
            : "";
      return el("div", line || " ", cls);
    }),
  );
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
  const raw = (res.text || "") + (res.truncated ? "\n[输出已截断]" : "");
  renderGitDiff(raw);
}

function renderSearchResults(text, mode, truncated) {
  const container = $("search-output");
  if (!text) {
    container.textContent = "没有找到匹配项。";
    return;
  }
  const lines = text.split("\n").filter(Boolean);
  container.replaceChildren(
    ...lines.map((line) => {
      if (mode === "find") {
        const btn = el("button", line, "wb-hit");
        btn.type = "button";
        btn.onclick = runSafe(async () => {
          switchTab("files");
          const slash = line.lastIndexOf("/");
          directory = slash > 0 ? line.slice(0, slash) : ".";
          await loadDirectory();
          await openFile(line, false);
        });
        return btn;
      }
      const match = /^([^:\n]+):(\d+):(.*)$/.exec(line);
      if (!match) return el("div", line);
      const [, filePath, lineStr, snippet] = match;
      const btn = el("button", undefined, "wb-hit");
      btn.type = "button";
      btn.append(el("span", `${filePath}:${lineStr}`, "wb-hit-path"), el("span", snippet));
      btn.onclick = runSafe(async () => {
        switchTab("files");
        const slash = filePath.lastIndexOf("/");
        directory = slash > 0 ? filePath.slice(0, slash) : ".";
        await loadDirectory();
        await openFile(filePath, false, Number(lineStr));
      });
      return btn;
    }),
  );
  if (truncated) container.append(el("div", "[结果已截断，请缩小搜索范围]", "wb-hint"));
}

function previewSshHost(rawHost) {
  clearTimeout(resolveTimer);
  resolveController?.abort();
  const host = (rawHost || "").trim();
  if (!host) {
    $("host-preview").textContent = "";
    return;
  }
  resolveTimer = setTimeout(async () => {
    const controller = new AbortController();
    resolveController = controller;
    try {
      const resolved = await api("/api/resolve", "POST", { host }, controller.signal);
      if (controller.signal.aborted) return;
      const user = resolved.user?.[0];
      const hostname = resolved.hostname?.[0] || host;
      const port = resolved.port?.[0];
      const jump = resolved.proxyjump?.[0];
      $("host-preview").textContent = `目标：${user ? `${user}@` : ""}${hostname}${port && port !== "22" ? `:${port}` : ""}${jump && jump !== "none" ? ` · Jump ${jump}` : ""}`;
    } catch {
      if (!controller.signal.aborted) $("host-preview").textContent = "";
    }
  }, 200);
}

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

$("editor-input").oninput = syncDirtyState;
$("editor-input").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (!$("save-file").disabled) $("save-file").click();
  }
});
$("reload-file").onclick = runSafe(async () => {
  if (openDoc && canDiscard()) await openFile(openDoc.path, true);
});
$("save-file").onclick = runSafe(async () => {
  if (!openDoc || !selected) return;
  const doc = openDoc;
  const wsId = selected.id;
  const raw = $("editor-input").value;
  $("save-file").disabled = true;
  try {
    const payload = doc.crlf ? raw.replaceAll("\n", "\r\n") : raw;
    const res = await api(wsPath("write"), "POST", { path: doc.path, etag: doc.etag, content: payload });
    if (selected?.id === wsId && openDoc === doc) {
      openDoc.etag = res.etag;
      openDoc.saved = raw;
      toast("已保存到远程主机");
    }
  } finally {
    syncDirtyState();
  }
});

for (const btn of document.querySelectorAll("[data-git]")) {
  btn.onclick = runSafe(() => loadGit(btn.dataset.git));
}
$("refresh-git").onclick = runSafe(() => loadGit(activeGitAction));

$("search-mode").onchange = () => {
  const isFind = $("search-mode").value === "find";
  $("search-literal").disabled = isFind;
  $("search-icase").disabled = isFind;
};
$("search-form").onsubmit = runSafe(async () => {
  if (!selected) return;
  const wsId = selected.id;
  const mode = $("search-mode").value;
  $("search-output").textContent = "正在搜索…";
  const res = await api(wsPath("search"), "POST", {
    pattern: $("search-input").value,
    mode,
    literal: $("search-literal").checked,
    ignoreCase: $("search-icase").checked,
    limit: 200,
  });
  if (selected?.id === wsId) renderSearchResults(res.text, mode, res.truncated);
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

if (document.documentElement.dataset.piPluginPanelShape === "view") {
  $("popout-btn").hidden = false;
}
initAppearanceSync();
bridge?.on?.("session:activated", () => { void syncSessionState(true); });
window.addEventListener("focus", () => { void syncSessionState(true); });
window.setInterval(() => { void syncSessionState(true); }, 2500);

void runSafe(() => refreshAll(true))();
