"use strict";

(() => {
  const MAX_INLINE_EDITOR_BYTES = 512 * 1024;
  const PREVIEW_HEAD_BYTES = 64 * 1024;

  function decodeBase64Bytes(b64) {
    if (typeof Uint8Array.fromBase64 === "function") {
      return Uint8Array.fromBase64(b64);
    }
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function decodeRemoteDocument(path, result, previewCapBytes = PREVIEW_HEAD_BYTES) {
    const bytes = decodeBase64Bytes(result.data || "");
    if (bytes.subarray(0, 8192).includes(0)) {
      throw new Error("此文件是二进制文件，暂不支持文本编辑");
    }
    if (result.preview || bytes.length > MAX_INLINE_EDITOR_BYTES) {
      const totalBytes = typeof result.totalBytes === "number" && result.totalBytes > 0 ? result.totalBytes : bytes.length;
      const preview = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, previewCapBytes));
      const kb = (previewCapBytes / 1024).toFixed(0);
      return {
        kind: "preview",
        text: preview,
        totalBytes,
        label: `${path}（${(totalBytes / 1024).toFixed(1)} KiB · 只读前 ${kb} KiB 预览）`,
      };
    }
    const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    let body;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(hasBom ? bytes.subarray(3) : bytes);
    } catch {
      throw new Error(`非 UTF-8 编码文件，无法安全进行文本编辑：${path}`);
    }
    const crlf = body.includes("\r\n") && !body.replaceAll("\r\n", "").includes("\n");
    const text = crlf ? body.replaceAll("\r\n", "\n") : body;
    return {
      kind: "editable",
      text,
      hasBom,
      crlf,
      etag: result.etag,
    };
  }

  function encodeRemoteSave(doc, rawTextareaValue) {
    const normalized = String(rawTextareaValue ?? "").replaceAll("\r\n", "\n");
    const withEol = doc.crlf ? normalized.replaceAll("\n", "\r\n") : normalized;
    return `${doc.hasBom ? "\uFEFF" : ""}${withEol}`;
  }

  async function saveWithConflictConfirm(writeWithEtag, confirmMessage) {
    try {
      const res = await writeWithEtag(true);
      return { saved: true, forced: false, result: res };
    } catch (err) {
      const msg = err?.message || String(err);
      if (/changed remotely|conflict/i.test(msg)) {
        if (window.confirm(confirmMessage || "远程文件在打开期间已被修改，是否强制覆盖保存？")) {
          const res = await writeWithEtag(false);
          return { saved: true, forced: true, result: res };
        }
        return { saved: false, cancelled: true };
      }
      throw err;
    }
  }

  function scrollTextareaToLine(textarea, lineNumber, approxLineHeight = 19.4) {
    if (!textarea || !(lineNumber > 1)) return;
    const lines = textarea.value.split("\n");
    let pos = 0;
    const targetIdx = Math.min(lineNumber - 1, lines.length);
    for (let i = 0; i < targetIdx; i++) pos += lines[i].length + 1;
    textarea.focus();
    textarea.setSelectionRange(pos, pos);
    textarea.scrollTop = Math.max(0, (lineNumber - 4) * approxLineHeight);
  }

  function parseGrepHit(line) {
    const match = /^(.+?):(\d+):(?:\s|$)(.*)$/.exec(line);
    if (!match) return null;
    return {
      path: match[1],
      lineNumber: Number(match[2]),
      snippet: match[3] || "",
    };
  }

  function parseGitShortStatus(text) {
    const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim().length > 0);
    let branch = "HEAD";
    const changes = [];
    for (const line of lines) {
      if (line.startsWith("## ")) {
        branch = line.slice(3).trim() || "HEAD";
        continue;
      }
      if (line.startsWith("[")) continue;
      const code = line.slice(0, 2).trim() || "?";
      const rest = line.slice(3);
      const arrowIdx = rest.indexOf(" -> ");
      const filePath = (arrowIdx >= 0 ? rest.slice(arrowIdx + 4) : rest).trim();
      if (filePath) changes.push({ code, path: filePath, raw: line });
    }
    return { branch, changes };
  }

  function makeEl(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function renderSearchHits(container, options) {
    const { text, mode, truncated, classes, emptyText, truncatedText, onOpenHit } = options;
    if (!text) {
      container.textContent = emptyText || "没有匹配结果";
      return;
    }
    const lines = text.split("\n").filter(Boolean);
    container.replaceChildren(
      ...lines.map((line) => {
        if (mode === "find") {
          const btn = makeEl("button", line, classes.hit);
          btn.type = "button";
          btn.onclick = () => onOpenHit(line, 0);
          return btn;
        }
        const parsed = parseGrepHit(line);
        if (!parsed) return makeEl("div", line);
        const btn = makeEl("button", undefined, classes.hit);
        btn.type = "button";
        btn.append(
          makeEl("span", `${parsed.path}:${parsed.lineNumber}`, classes.hitPath),
          makeEl("span", parsed.snippet ? ` ${parsed.snippet}` : ""),
        );
        btn.onclick = () => onOpenHit(parsed.path, parsed.lineNumber);
        return btn;
      }),
    );
    if (truncated) {
      container.append(makeEl("div", truncatedText || "[结果已截断，请缩小搜索范围]", classes.hint));
    }
  }

  function renderDiffLines(container, options) {
    const { text, classes, emptyText, headerTitle, onBack, onOpenFile } = options;
    const nodes = [];
    if (headerTitle) {
      const bar = makeEl("div", undefined, classes.diffToolbar);
      if (onBack) {
        const backBtn = makeEl("button", "← 返回状态列表", classes.miniBtn);
        backBtn.type = "button";
        backBtn.onclick = onBack;
        bar.append(backBtn);
      }
      bar.append(makeEl("span", headerTitle, classes.diffHeaderLabel));
      nodes.push(bar);
    }
    if (!text || !text.trim()) {
      nodes.push(makeEl("div", emptyText || "工作区干净，没有未提交改动。", classes.hint));
      container.replaceChildren(...nodes);
      return;
    }
    for (const line of text.split("\n")) {
      if (onOpenFile && line.startsWith("+++ b/")) {
        const filePath = line.slice(6).trim();
        if (filePath && filePath !== "/dev/null") {
          const btn = makeEl("button", `${line}  ↗ 打开文件`, classes.diffFileBtn);
          btn.type = "button";
          btn.onclick = () => onOpenFile(filePath);
          nodes.push(btn);
          continue;
        }
      }
      const cls = line.startsWith("+") && !line.startsWith("+++")
        ? classes.add
        : line.startsWith("-") && !line.startsWith("---")
          ? classes.del
          : line.startsWith("@@")
            ? classes.hunk
            : "";
      nodes.push(makeEl("div", line || " ", cls));
    }
    container.replaceChildren(...nodes);
  }

  function renderGitStatusInteractive(container, options) {
    const { text, truncated, classes, onInspectFileDiff, onOpenFile } = options;
    const parsed = parseGitShortStatus(text);
    const nodes = [];
    nodes.push(makeEl("div", `分支：${parsed.branch}`, classes.statusBranch));
    if (!parsed.changes.length) {
      nodes.push(makeEl("div", "✓ 工作区干净，没有未提交改动。", classes.hint));
      container.replaceChildren(...nodes);
      return;
    }
    for (const item of parsed.changes) {
      const row = makeEl("div", undefined, classes.statusRow);
      const mainBtn = makeEl("button", undefined, classes.statusMainBtn);
      mainBtn.type = "button";
      mainBtn.title = "点击查看此文件的 Git Diff";
      mainBtn.append(
        makeEl("span", item.code, classes.statusCode),
        makeEl("span", item.path, classes.statusPath),
      );
      mainBtn.onclick = () => onInspectFileDiff(item);
      row.append(mainBtn);
      if (onOpenFile && !item.code.includes("D")) {
        const openBtn = makeEl("button", "编辑", classes.miniBtn);
        openBtn.type = "button";
        openBtn.title = `在编辑器中打开 ${item.path}`;
        openBtn.onclick = () => onOpenFile(item.path);
        row.append(openBtn);
      }
      nodes.push(row);
    }
    if (truncated) {
      nodes.push(makeEl("div", "[状态列表已截断]", classes.hint));
    }
    container.replaceChildren(...nodes);
  }

  function createHostPreviewer({ resolveHost, onPreview, prefixLabel = "目标：", jumpLabel = "Jump", delayMs = 200 }) {
    let timer = null;
    let activeController = null;
    return (rawHost) => {
      clearTimeout(timer);
      activeController?.abort();
      const host = String(rawHost || "").trim();
      if (!host) {
        onPreview("");
        return;
      }
      timer = setTimeout(async () => {
        const controller = new AbortController();
        activeController = controller;
        try {
          const resolved = await resolveHost(host, controller.signal);
          if (controller.signal.aborted) return;
          const user = resolved.user?.[0];
          const hostname = resolved.hostname?.[0] || host;
          const port = resolved.port?.[0];
          const jump = resolved.proxyjump?.[0];
          const target = `${user ? `${user}@` : ""}${hostname}${port && port !== "22" ? `:${port}` : ""}`;
          onPreview(`${prefixLabel}${target}${jump && jump !== "none" ? ` · ${jumpLabel} ${jump}` : ""}`);
        } catch {
          if (!controller.signal.aborted) onPreview("");
        }
      }, delayMs);
    };
  }

  window.PiRemoteWorkbenchCore = {
    MAX_INLINE_EDITOR_BYTES,
    PREVIEW_HEAD_BYTES,
    decodeBase64Bytes,
    decodeRemoteDocument,
    encodeRemoteSave,
    saveWithConflictConfirm,
    scrollTextareaToLine,
    parseGrepHit,
    parseGitShortStatus,
    renderSearchHits,
    renderDiffLines,
    renderGitStatusInteractive,
    createHostPreviewer,
  };
})();
