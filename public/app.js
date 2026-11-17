"use strict";
const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
const initialWorkspaceId = fragment.get("workspace") || "";
if (fragment.has("token")) sessionStorage.setItem("pi-remote-token", fragment.get("token"));
if (location.hash) history.replaceState(null, "", location.pathname + location.search);
const token = sessionStorage.getItem("pi-remote-token") || "";
let state, selected, directory = ".", file, editingId, commandController, resolveController, resolveTimer, toastTimer, fileReadSequence = 0;
const dirty = () => file && $("file-content").value !== file.saved;
function canLeave() { return !dirty() || confirm("文件有未保存的修改，确定放弃这些修改吗？"); }
function toast(message, error = false) {
  $("toast").textContent = message; $("toast").className = error ? "error" : ""; $("toast").hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true; }, error ? 9000 : 4000);
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
const perform = action => async event => { event?.preventDefault(); try { await action(event); } catch (error) { toast(error.message, true); } };
const endpoint = action => `/api/workspaces/${encodeURIComponent(selected.id)}/${action}`;
function node(tag, text, className) { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; if (className) item.className = className; return item; }
function syncActiveFileRow() {
  for (const row of $("file-list").querySelectorAll(".file-row")) {
    row.classList.toggle("active", !!file && row.dataset.path === file.path);
  }
}
function clearFile() {
  fileReadSequence++; file = undefined;
  $("file-name").textContent = "选择文件以查看或编辑"; $("file-content").hidden = true; $("editor-placeholder").hidden = false;
  $("save-file").disabled = true; $("reload-file").disabled = true; $("file-dirty").textContent = "";
  syncActiveFileRow();
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
  if (selected) $("copy-command").textContent = `/remote use ${selected.id}  ⧉`;
}
async function selectWorkspace(workspace) {
  if (selected?.id === workspace.id) return;
  if (!canLeave()) return;
  commandController?.abort(); selected = workspace; directory = "."; clearFile();
  $("connection-state").className = "badge"; $("connection-state").textContent = "待测试";
  for (const id of ["search-output", "git-output", "command-output"]) $(id).textContent = "";
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
    const button = node("button", undefined, `file-row${file?.path === target ? " active" : ""}`);
    button.dataset.path = target;
    button.append(node("span", entry.directory ? "▱" : entry.symlink ? "↗" : "·", "file-icon"), node("span", entry.name));
    button.onclick = perform(async () => {
      if (entry.directory) { directory = target; await listFiles(); }
      else await openFile(target);
    }); return button;
  }));
  if (!entries.length) $("file-list").append(node("p", "目录为空", "hint"));
}
async function openFile(path, force = false) {
  if (!force && !canLeave()) return;
  const id = selected.id, sequence = ++fileReadSequence, previousFile = file, previousContent = $("file-content").value;
  const result = await api(endpoint("read"), "POST", { path });
  if (selected?.id !== id || sequence !== fileReadSequence) return;
  if (file === previousFile && $("file-content").value !== previousContent && !canLeave()) return;
  const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.includes("\0")) throw new Error("此文件是二进制文件，请通过 pi 的 read 工具查看。");
  // Preserve CRLF only when all line endings in the original file consistently use CRLF.
  const crlf = text.includes("\r\n") && !text.replaceAll("\r\n", "").includes("\n");
  $("file-content").value = text;
  file = { path, etag: result.etag, saved: $("file-content").value, crlf };
  $("file-name").textContent = path; $("file-name").title = path;
  $("file-content").hidden = false; $("editor-placeholder").hidden = true; $("reload-file").disabled = false;
  syncActiveFileRow();
  updateDirty();
}
function updateDirty() { $("file-dirty").textContent = dirty() ? "未保存" : ""; $("save-file").disabled = !dirty(); }
function previewHost(rawHost) {
  clearTimeout(resolveTimer);
  resolveController?.abort();
  const host = (rawHost || "").trim();
  if (!host) { $("host-preview").textContent = ""; return; }
  resolveTimer = setTimeout(async () => {
    const controller = new AbortController();
    resolveController = controller;
    try {
      const resolved = await api("/api/resolve", "POST", { host }, controller.signal);
      if (controller.signal.aborted) return;
      const user = resolved.user?.[0], hostname = resolved.hostname?.[0], port = resolved.port?.[0], jump = resolved.proxyjump?.[0];
      const target = `${user ? `${user}@` : ""}${hostname || host}${port && port !== "22" ? `:${port}` : ""}`;
      $("host-preview").textContent = `生效目标：${target}${jump && jump !== "none" ? ` · ProxyJump ${jump}` : ""}`;
    } catch {
      if (!controller.signal.aborted) $("host-preview").textContent = "";
    }
  }, 220);
}
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
    const updated = await api(editingId ? `/api/workspaces/${editingId}` : "/api/workspaces", editingId ? "PUT" : "POST", data);
    $("workspace-dialog").close();
    if (wasSelected) { selected = undefined; clearFile(); }
    await refresh(); await selectWorkspace(updated); toast("工作区已保存，可在 pi 中运行对应 /remote use 命令。");
  } catch (error) { $("workspace-error").textContent = error.message; }
};
$("delete-workspace").onclick = perform(async () => {
  if (!confirm("删除此工作区配置？远程文件不受影响。")) return;
  if (selected?.id === editingId && !canLeave()) return;
  await api(`/api/workspaces/${editingId}`, "DELETE"); $("workspace-dialog").close();
  if (selected?.id === editingId) { selected = undefined; clearFile(); }
  await refresh(); toast("工作区已删除");
});
$("refresh-hosts").onclick = perform(async () => { await refresh(); toast(`已重新读取 ${state.inventory.files.length} 份 SSH 配置`); });
$("open-settings").onclick = () => {
  for (const name of ["sshConfigPath", "connectTimeoutSeconds", "commandTimeoutSeconds"]) $("settings-form").elements.namedItem(name).value = state.config[name] ?? "";
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
    toast(`Python ${result.python} · Git ${result.git ? "可用" : "未安装"} · ripgrep ${result.ripgrep ? "可用" : "未安装"}`);
  } catch (error) { if (selected?.id === id) { $("connection-state").textContent = "连接失败"; $("connection-state").className = "badge"; } throw error; }
});
$("copy-command").onclick = perform(async () => { await navigator.clipboard.writeText(`/remote use ${selected.id}`); toast("绑定命令已复制"); });
for (const button of document.querySelectorAll("[data-tab]")) button.onclick = () => {
  for (const other of document.querySelectorAll("[data-tab]")) { other.classList.toggle("active", other === button); $(`panel-${other.dataset.tab}`).hidden = other !== button; }
};
$("parent-directory").onclick = perform(async () => { directory = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "."; await listFiles(); });
$("new-file").onclick = perform(async () => {
  if (!canLeave()) return;
  const input = prompt(`在 ${directory === "." ? "工作区根目录" : directory} 下新建文件路径：`);
  const rel = (input || "").trim().replace(/^\/+/, "");
  if (!rel) return;
  const target = directory === "." ? rel : `${directory}/${rel}`;
  await api(endpoint("write"), "POST", { path: target, etag: null, content: "" });
  await listFiles();
  await openFile(target, true);
  $("file-content").focus();
  toast(`已创建 ${target}`);
});
$("refresh-files").onclick = perform(listFiles);
$("file-content").oninput = updateDirty;
$("file-content").addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (!$("save-file").disabled) $("save-file").click();
  }
});
$("reload-file").onclick = perform(async () => { if (canLeave()) await openFile(file.path, true); });
$("save-file").onclick = perform(async () => {
  const currentFile = file, id = selected.id, snapshot = $("file-content").value;
  $("save-file").disabled = true;
  try {
    const content = currentFile.crlf ? snapshot.replaceAll("\n", "\r\n") : snapshot;
    const result = await api(endpoint("write"), "POST", { path: currentFile.path, etag: currentFile.etag, content });
    if (selected?.id === id && file === currentFile) { file.etag = result.etag; file.saved = snapshot; toast("文件已保存到远程主机"); }
  } finally { updateDirty(); }
});
function syncSearchOptions() {
  const isFind = $("search-mode").value === "find";
  $("search-literal").disabled = isFind;
  $("search-ignore-case").disabled = isFind;
}
$("search-mode").onchange = syncSearchOptions;
syncSearchOptions();
$("search-form").onsubmit = perform(async () => {
  const id = selected.id; $("search-output").textContent = "正在搜索…";
  const result = await api(endpoint("search"), "POST", {
    pattern: $("search-pattern").value,
    mode: $("search-mode").value,
    literal: $("search-literal").checked,
    ignoreCase: $("search-ignore-case").checked,
    limit: 200,
  });
  if (selected?.id === id) $("search-output").textContent = (result.text || "没有匹配结果") + (result.truncated ? "\n[结果已截断，请缩小搜索范围]" : "");
});
for (const button of document.querySelectorAll("[data-git]")) button.onclick = perform(async () => {
  const id = selected.id; $("git-output").textContent = "正在读取 Git…";
  const result = await api(endpoint("git"), "POST", { action: button.dataset.git });
  if (selected?.id === id) $("git-output").textContent = (result.text || "没有改动") + (result.truncated ? "\n[输出已截断]" : "");
});
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
