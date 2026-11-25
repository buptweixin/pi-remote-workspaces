"use strict";
const $ = id => document.getElementById(id);
const Core = window.PiRemoteWorkbenchCore;
const fragment = new URLSearchParams(location.hash.slice(1));
const initialWorkspaceId = fragment.get("workspace") || "";
if (fragment.has("token")) sessionStorage.setItem("pi-remote-token", fragment.get("token"));
if (location.hash) history.replaceState(null, "", location.pathname + location.search);
const token = sessionStorage.getItem("pi-remote-token") || "";

let state, selected, directory = ".", file, currentViewPath = "", editingId, activeGitAction = "status", commandController, toastTimer, fileReadSequence = 0;

const dirty = () => Boolean(file && $("file-content").value !== file.saved);
function canLeave() { return !dirty() || confirm("文件有未保存的修改，确定放弃这些修改吗？"); }
function toast(message, error = false) {
  $("toast").textContent = message; $("toast").className = error ? "error" : ""; $("toast").hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true; }, error ? 9000 : 4000);
}
async function copyText(text) {
  await navigator.clipboard.writeText(text);
}
async function api(path, method = "GET", data, signal) {
  const response = await fetch(path, { method, signal, headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const raw = await response.text();
  let result = {};
  if (raw) {
    try { result = JSON.parse(raw); }
    catch { throw new Error(`HTTP ${response.status}: invalid server response`); }
  }
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
const perform = action => async event => { event?.preventDefault(); try { await action(event); } catch (error) { if (error?.name !== "AbortError") toast(error.message, true); } };
const endpoint = action => `/api/workspaces/${encodeURIComponent(selected.id)}/${action}`;
function node(tag, text, className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
function switchTab(tabName) {
  for (const other of document.querySelectorAll("[data-tab]")) {
    const active = other.dataset.tab === tabName;
    other.classList.toggle("active", active);
    $(`panel-${other.dataset.tab}`).hidden = !active;
  }
}
function syncActiveFileRow() {
  for (const row of $("file-list").querySelectorAll(".file-row")) {
    row.classList.toggle("active", Boolean(currentViewPath && row.dataset.path === currentViewPath));
  }
}
function clearFile() {
  fileReadSequence++; file = undefined; currentViewPath = "";
  $("file-name").textContent = "选择文件以查看或编辑";
  $("file-content").readOnly = false;
  $("file-content").hidden = true;
  $("editor-placeholder").hidden = false;
  $("save-file").disabled = true; $("reload-file").disabled = true;
  $("rename-file").disabled = true; $("delete-file").disabled = true;
  $("file-dirty").textContent = "";
  syncActiveFileRow();
}
function renderSessionBar() {
  if (!selected) return;
  $("copy-command").textContent = `/remote use ${selected.id}  ⧉`;
  $("agent-bar-label").textContent = "在 pi / pi-web / PI-Desktop 中绑定此工作区";
  $("session-dot").classList.remove("inactive");
}
async function refresh() {
  state = await api("/api/state");
  $("app-version").textContent = `/ v${state.version}`;
  $("config-location").textContent = state.configFile;
  $("host-count").textContent = state.inventory.hosts.length;
  $("config-warnings").textContent = state.inventory.warnings.join("\n");
  $("ssh-aliases").replaceChildren(...state.inventory.hosts.map(host => { const option = node("option"); option.value = host.alias; return option; }));
  $("hosts").replaceChildren(...state.inventory.hosts.map(host => { const row = node("div", undefined, "host-row"); const button = node("button", host.alias); button.title = `${host.source}:${host.line}`; button.onclick = () => openWorkspace(undefined, host.alias); row.append(button); return row; }));
  if (!state.inventory.hosts.length) $("hosts").append(node("p", "尚未发现主机，可手动添加。", "hint"));
  $("copy-shared-anchor").title = state.anchors?.root || "";
  if (selected) selected = state.config.workspaces.find(w => w.id === selected.id);
  renderWorkspaces();
}
function renderWorkspaces() {
  $("workspaces").replaceChildren(...state.config.workspaces.map(workspace => {
    const button = node("button", undefined, `workspace-card${selected?.id === workspace.id ? " active" : ""}`);
    const content = node("span"); content.append(node("strong", workspace.name), node("small", `${workspace.host} · ${workspace.path}`));
    button.append(node("span", "⌁", "workspace-icon"), content);
    button.onclick = perform(() => selectWorkspace(workspace)); return button;
  }));
  const active = !!selected;
  $("welcome").hidden = active; $("workbench").hidden = !active;
  $("test-connection").disabled = !active; $("edit-workspace").disabled = !active;
  $("workspace-title").textContent = selected?.name || "远程工作区";
  $("workspace-subtitle").textContent = selected ? `${selected.host} / ${selected.path}` : "从 SSH 配置开始，让 pi 在远程项目中工作。";
  if (selected) {
    $("copy-anchor").textContent = "复制 pi-web 锚点目录  ⧉";
    $("copy-anchor").title = state.anchors?.workspaces?.[selected.id] || "";
  }
  renderSessionBar();
}
async function selectWorkspace(workspace) {
  if (selected?.id === workspace.id) return;
  if (!canLeave()) return;
  commandController?.abort(); selected = workspace; directory = "."; clearFile();
  $("connection-state").className = "badge"; $("connection-state").textContent = "待测试";
  $("search-output").textContent = "搜索结果会显示在这里。";
  $("git-output").textContent = "选择上方按钮查看远程 Git 状态与差异。";
  $("command-output").textContent = "命令输出会显示在这里。";
  renderWorkspaces(); await listFiles();
}
async function listFiles() {
  const id = selected.id, path = directory;
  $("file-list").textContent = "正在读取远程目录…";
  const entries = await api(endpoint("list"), "POST", { path });
  if (selected?.id !== id || directory !== path) return;
  $("directory-path").textContent = path === "." ? "/" : path; $("directory-path").title = path;
  $("parent-directory").disabled = directory === ".";
  $("file-list").replaceChildren(...entries.map(entry => {
    const target = directory === "." ? entry.name : `${directory}/${entry.name}`;
    const button = node("button", undefined, `file-row${currentViewPath === target ? " active" : ""}${entry.escaped ? " escaped" : ""}`);
    button.dataset.path = target;
    button.append(
      node("span", entry.escaped ? "⚠" : entry.directory ? "▱" : entry.symlink ? "↗" : "·", "file-icon"),
      node("span", entry.escaped ? `${entry.name} (越界软链)` : entry.name),
    );
    button.onclick = perform(async () => {
      if (entry.escaped) { toast(`软链接 ${entry.name} 指向工作区外部，已被安全策略阻止`, true); return; }
      if (entry.directory) { directory = target; await listFiles(); }
      else await openFile(target);
    }); return button;
  }));
  if (!entries.length) $("file-list").append(node("p", "目录为空", "hint"));
}
async function jumpToFile(relPath, lineNumber = 0) {
  switchTab("files");
  const slash = relPath.lastIndexOf("/");
  directory = slash > 0 ? relPath.slice(0, slash) : ".";
  await listFiles();
  await openFile(relPath, false, lineNumber);
}
async function openFile(path, force = false, lineNumber = 0) {
  if (!force && !canLeave()) return;
  const id = selected.id, sequence = ++fileReadSequence, previousFile = file, previousContent = $("file-content").value;
  const result = await api(endpoint("read"), "POST", {
    path,
    maxEditableBytes: Core.MAX_INLINE_EDITOR_BYTES,
    previewBytes: Core.PREVIEW_HEAD_BYTES,
  });
  if (selected?.id !== id || sequence !== fileReadSequence) return;
  if (file === previousFile && $("file-content").value !== previousContent && !canLeave()) return;
  const decoded = Core.decodeRemoteDocument(path, result, Core.PREVIEW_HEAD_BYTES);
  const textarea = $("file-content");
  currentViewPath = path;
  $("rename-file").disabled = false;
  $("delete-file").disabled = false;
  if (decoded.kind === "preview") {
    textarea.value = decoded.text;
    textarea.readOnly = true;
    file = undefined;
    $("file-name").textContent = decoded.label; $("file-name").title = decoded.label;
    textarea.hidden = false; $("editor-placeholder").hidden = true;
    $("save-file").disabled = true; $("reload-file").disabled = false; $("file-dirty").textContent = "";
    syncActiveFileRow();
    return;
  }
  textarea.readOnly = false;
  textarea.value = decoded.text;
  file = { path, etag: decoded.etag, saved: textarea.value, crlf: decoded.crlf, hasBom: decoded.hasBom };
  $("file-name").textContent = path; $("file-name").title = path;
  textarea.hidden = false; $("editor-placeholder").hidden = true; $("reload-file").disabled = false;
  syncActiveFileRow();
  updateDirty();
  Core.scrollTextareaToLine(textarea, lineNumber, 19.8);
}

const gitClasses = {
  add: "diff-add",
  del: "diff-del",
  hunk: "diff-hunk",
  hint: "hint",
  statusBranch: "git-branch",
  statusRow: "git-row",
  statusMainBtn: "git-main-btn",
  statusCode: "git-code",
  statusPath: "git-path",
  miniBtn: "git-mini-btn",
  diffToolbar: "diff-toolbar",
  diffHeaderLabel: "diff-header-label",
  diffFileBtn: "diff-file-btn",
};

async function inspectSingleFileDiff(change) {
  if (!selected) return;
  const id = selected.id;
  $("git-output").textContent = `正在读取 ${change.path} 的变更…`;
  const [unstaged, staged] = await Promise.all([
    api(endpoint("git"), "POST", { action: "diff", path: change.path }),
    api(endpoint("git"), "POST", { action: "staged", path: change.path }),
  ]);
  if (selected?.id !== id) return;
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
    onBack: () => { void perform(() => loadGit("status"))(); },
    onOpenFile: rel => { void perform(() => jumpToFile(rel))(); },
  });
}

async function loadGit(action = activeGitAction) {
  if (!selected) return;
  activeGitAction = action;
  for (const btn of document.querySelectorAll("[data-git]")) {
    btn.classList.toggle("active", btn.dataset.git === action);
  }
  const id = selected.id;
  $("git-output").textContent = "正在读取 Git…";
  const result = await api(endpoint("git"), "POST", { action });
  if (selected?.id !== id) return;
  if (action === "status") {
    Core.renderGitStatusInteractive($("git-output"), {
      text: result.text || "",
      truncated: result.truncated,
      classes: gitClasses,
      onInspectFileDiff: item => { void perform(() => inspectSingleFileDiff(item))(); },
      onOpenFile: rel => { void perform(() => jumpToFile(rel))(); },
    });
    return;
  }
  const raw = (result.text || "") + (result.truncated ? "\n[输出已截断]" : "");
  Core.renderDiffLines($("git-output"), {
    text: raw,
    classes: gitClasses,
    emptyText: "没有改动",
    onOpenFile: rel => { void perform(() => jumpToFile(rel))(); },
  });
}
function updateDirty() { $("file-dirty").textContent = dirty() ? "未保存" : ""; $("save-file").disabled = !dirty(); }

const previewHost = Core.createHostPreviewer({
  resolveHost: (host, signal) => api("/api/resolve", "POST", { host }, signal),
  onPreview: text => { $("host-preview").textContent = text; },
  prefixLabel: "生效目标：",
  jumpLabel: "ProxyJump",
  delayMs: 220,
});

function openWorkspace(workspace, host = "") {
  editingId = workspace?.id; const form = $("workspace-form"); form.reset();
  for (const name of ["name", "host", "path", "id"]) form.elements.namedItem(name).value = workspace?.[name] || (name === "host" ? host : "");
  form.elements.namedItem("id").disabled = !!workspace;
  $("dialog-title").textContent = workspace ? "编辑远程工作区" : "添加远程工作区";
  $("workspace-error").textContent = ""; $("delete-workspace").hidden = !workspace;
  $("host-preview").textContent = "";
  previewHost(form.elements.namedItem("host").value);
  $("workspace-dialog").showModal();
}
$("workspace-form").elements.namedItem("host").addEventListener("input", event => previewHost(event.target.value));
for (const id of ["add-workspace", "add-empty", "welcome-add"]) $(id).onclick = () => openWorkspace();
$("edit-workspace").onclick = () => openWorkspace(selected);
for (const button of document.querySelectorAll("[data-close]")) button.onclick = () => $(button.dataset.close).close();
$("workspace-form").onsubmit = async event => {
  event.preventDefault(); $("workspace-error").textContent = "";
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const wasSelected = selected?.id === editingId;
  if (wasSelected && !canLeave()) return;
  try {
    const updated = await api(editingId ? `/api/workspaces/${encodeURIComponent(editingId)}` : "/api/workspaces", editingId ? "PUT" : "POST", data);
    $("workspace-dialog").close();
    if (wasSelected) { selected = undefined; clearFile(); }
    await refresh(); await selectWorkspace(updated); toast("工作区已保存。");
  } catch (error) { $("workspace-error").textContent = error.message; }
};
$("delete-workspace").onclick = perform(async () => {
  if (!confirm("删除此工作区配置？远程文件不受影响。")) return;
  if (selected?.id === editingId && !canLeave()) return;
  await api(`/api/workspaces/${encodeURIComponent(editingId)}`, "DELETE"); $("workspace-dialog").close();
  if (selected?.id === editingId) { selected = undefined; clearFile(); }
  await refresh(); toast("工作区已删除");
});
$("refresh-hosts").onclick = perform(async () => { await refresh(); toast(`已重新读取 ${state.inventory.files.length} 份 SSH 配置`); });
$("open-settings").onclick = () => {
  for (const name of ["sshConfigPath", "anchorRoot", "connectTimeoutSeconds", "commandTimeoutSeconds"]) $("settings-form").elements.namedItem(name).value = state.config[name] ?? "";
  $("settings-error").textContent = ""; $("settings-dialog").showModal();
};
$("settings-form").onsubmit = async event => {
  event.preventDefault(); const data = Object.fromEntries(new FormData(event.currentTarget));
  data.connectTimeoutSeconds = Number(data.connectTimeoutSeconds); data.commandTimeoutSeconds = Number(data.commandTimeoutSeconds);
  try { await api("/api/config", "PUT", data); await refresh(); $("settings-dialog").close(); toast("连接设置已保存"); }
  catch (error) { $("settings-error").textContent = error.message; }
};
$("test-connection").onclick = perform(async () => {
  const id = selected.id; $("connection-state").textContent = "连接中…";
  try {
    const result = await api(endpoint("probe"), "POST", {}); if (selected?.id !== id) return;
    $("connection-state").textContent = `已连接 · ${result.hostname}`; $("connection-state").className = "badge connected";
    toast(`Python ${result.python} · Git ${result.git ? "可用" : "未安装"} · ripgrep ${result.ripgrep ? "可用" : "未安装（已启用降级搜索）"}`);
  } catch (error) { if (selected?.id === id) { $("connection-state").textContent = "连接失败"; $("connection-state").className = "badge"; } throw error; }
});
$("copy-command").onclick = perform(async () => { await copyText(`/remote use ${selected.id}`); toast("绑定命令已复制"); });
$("copy-anchor").onclick = perform(async () => {
  const dir = state.anchors?.workspaces?.[selected.id];
  if (!dir) throw new Error("未找到工作区锚点目录");
  await copyText(dir);
  toast("pi-web 锚点目录已复制，在 pi-web 打开该目录即可自动绑定");
});
$("copy-shared-anchor").onclick = perform(async () => {
  const dir = state.anchors?.root;
  if (!dir) throw new Error("未找到共享选服目录");
  await copyText(dir);
  toast("pi-web 共享选服目录已复制");
});
for (const button of document.querySelectorAll("[data-tab]")) button.onclick = () => {
  switchTab(button.dataset.tab);
  if (button.dataset.tab === "git" && $("git-output").textContent.startsWith("选择上方")) {
    void perform(() => loadGit("status"))();
  }
};
$("parent-directory").onclick = perform(async () => { directory = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "."; await listFiles(); });
$("new-folder").onclick = perform(async () => {
  const raw = prompt(`在 ${directory === "." ? "/" : directory} 下新建远程文件夹：`, "");
  const rel = (raw || "").trim().replace(/^\/+/, "");
  if (!rel) return;
  const target = directory === "." ? rel : `${directory}/${rel}`;
  await api(endpoint("mkdir"), "POST", { path: target });
  directory = target;
  await listFiles();
  toast(`已创建文件夹 ${target}`);
});
$("new-file").onclick = () => {
  if (!canLeave()) return;
  $("new-file-form").reset();
  $("new-file-error").textContent = "";
  $("new-file-directory").textContent = `目标目录：${directory === "." ? "工作区根目录 (/)" : directory}`;
  $("new-file-dialog").showModal();
  $("new-file-form").elements.namedItem("relativePath").focus();
};
$("new-file-form").onsubmit = async event => {
  event.preventDefault();
  $("new-file-error").textContent = "";
  const rel = String(new FormData(event.currentTarget).get("relativePath") || "").trim().replace(/^\/+/, "");
  if (!rel) return;
  const target = directory === "." ? rel : `${directory}/${rel}`;
  try {
    await api(endpoint("write"), "POST", { path: target, etag: null, content: "" });
    $("new-file-dialog").close();
    await listFiles();
    await openFile(target, true);
    $("file-content").focus();
    toast(`已创建 ${target}`);
  } catch (error) {
    $("new-file-error").textContent = error.message;
  }
};
$("rename-file").onclick = perform(async () => {
  if (!currentViewPath || !canLeave()) return;
  const nextRaw = prompt("输入新的远程工作区相对路径：", currentViewPath);
  const nextPath = (nextRaw || "").trim().replace(/^\/+/, "");
  if (!nextPath || nextPath === currentViewPath) return;
  await api(endpoint("rename"), "POST", { path: currentViewPath, newPath: nextPath });
  const slash = nextPath.lastIndexOf("/");
  directory = slash > 0 ? nextPath.slice(0, slash) : ".";
  await listFiles();
  await openFile(nextPath, true);
  toast(`已重命名为 ${nextPath}`);
});
$("delete-file").onclick = perform(async () => {
  if (!currentViewPath) return;
  if (!confirm(`确定永久删除远程文件「${currentViewPath}」吗？此操作不可撤销。`)) return;
  const deleted = currentViewPath;
  await api(endpoint("delete"), "POST", { path: deleted });
  clearFile();
  await listFiles();
  toast(`已删除 ${deleted}`);
});
$("refresh-files").onclick = perform(listFiles);
$("file-content").oninput = updateDirty;
$("file-content").addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (!$("save-file").disabled) $("save-file").click();
  }
});
$("reload-file").onclick = perform(async () => { if (currentViewPath && canLeave()) await openFile(currentViewPath, true); });
$("save-file").onclick = perform(async () => {
  if (!file || !selected) return;
  const currentFile = file, id = selected.id, snapshot = $("file-content").value;
  $("save-file").disabled = true;
  try {
    const content = Core.encodeRemoteSave(currentFile, snapshot);
    const outcome = await Core.saveWithConflictConfirm(
      useEtag => api(endpoint("write"), "POST", { path: currentFile.path, ...(useEtag ? { etag: currentFile.etag } : {}), content }),
      `远程文件 ${currentFile.path} 在编辑期间已被修改，是否强制覆盖保存？`,
    );
    if (outcome.saved && selected?.id === id && file === currentFile) {
      file.etag = outcome.result.etag;
      file.saved = snapshot;
      toast(outcome.forced ? "已强制覆盖保存到远程主机" : "文件已保存到远程主机");
    }
  } finally { updateDirty(); }
});
function syncSearchOptions() {
  const isFind = $("search-mode").value === "find";
  $("search-literal").disabled = isFind;
  $("search-ignore-case").disabled = isFind;
  $("search-glob").disabled = isFind;
}
$("search-mode").onchange = syncSearchOptions;
syncSearchOptions();
$("search-form").onsubmit = perform(async () => {
  const id = selected.id, mode = $("search-mode").value;
  $("search-output").textContent = "正在搜索…";
  const glob = $("search-glob").value.trim();
  const result = await api(endpoint("search"), "POST", {
    pattern: $("search-pattern").value,
    mode,
    ...(mode === "grep" && glob ? { glob } : {}),
    literal: $("search-literal").checked,
    ignoreCase: $("search-ignore-case").checked,
    limit: 200,
  });
  if (selected?.id === id) {
    Core.renderSearchHits($("search-output"), {
      text: result.text,
      mode,
      truncated: result.truncated,
      classes: { hit: "search-hit", hitPath: "search-hit-path", hint: "hint" },
      emptyText: "没有匹配结果",
      onOpenHit: (relPath, lineNo) => { void perform(() => jumpToFile(relPath, lineNo))(); },
    });
  }
});
for (const button of document.querySelectorAll("[data-git]")) button.onclick = perform(() => loadGit(button.dataset.git));
$("refresh-git").onclick = perform(() => loadGit(activeGitAction));
$("command-input").addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    if (!$("run-command").disabled) $("command-form").requestSubmit();
  }
});
$("command-form").onsubmit = perform(async () => {
  if (commandController) return;
  const controller = new AbortController(), id = selected.id; commandController = controller;
  $("run-command").disabled = true; $("cancel-command").hidden = false; $("command-output").textContent = "正在远程执行…";
  try {
    const result = await api(endpoint("exec"), "POST", { command: $("command-input").value }, controller.signal);
    if (selected?.id === id) $("command-output").textContent = `${result.text}\n\n[exit ${result.exitCode}]`;
  } catch (error) {
    if (selected?.id === id) $("command-output").textContent = error.name === "AbortError" ? "已停止等待并关闭 SSH 连接。" : error.message;
  } finally { commandController = undefined; $("run-command").disabled = false; $("cancel-command").hidden = true; }
});
$("cancel-command").onclick = () => commandController?.abort();
window.addEventListener("beforeunload", event => { if (dirty()) { event.preventDefault(); event.returnValue = ""; } });

perform(async () => {
  await refresh();
  const initial = (initialWorkspaceId && state.config.workspaces.find(w => w.id === initialWorkspaceId)) || state.config.workspaces[0];
  if (initial) await selectWorkspace(initial);
})();
