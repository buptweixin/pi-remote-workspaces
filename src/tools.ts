// Tool delegation follows pi's MIT-licensed SSH example; see THIRD_PARTY_NOTICES.md.
import { posix } from "node:path";
import { Type } from "typebox";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import type { BashOperations, GrepToolDetails, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ProcessAbortError, ProcessTimeoutError } from "./process.js";
import { RemoteClient, type DirectoryEntry, type Probe, type TextOutput } from "./remote.js";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_TOOL_TEXT_BYTES = 50 * 1024;
const MAX_READ_LINES = 2000;

export const REMOTE_DESKTOP_TOOL_NAMES = [
  "remote_read",
  "remote_write",
  "remote_edit",
  "remote_bash",
  "remote_ls",
  "remote_find",
  "remote_grep",
] as const;

export type RemoteDesktopToolName = (typeof REMOTE_DESKTOP_TOOL_NAMES)[number];

export const LOCAL_READONLY_TOOL_NAMES = [
  "local_read",
  "local_ls",
  "local_find",
  "local_grep",
] as const;

export type LocalReadonlyToolName = (typeof LOCAL_READONLY_TOOL_NAMES)[number];

/**
 * Inspect ownKeys without triggering PI-Desktop's Proxy get/has diagnostics on
 * `@earendil-works/pi-coding-agent` exports outside its compatibility subset.
 */
export function hasNativeToolFactories(mod: object = codingAgent): boolean {
  return Reflect.ownKeys(mod).includes("createReadToolDefinition");
}

export function getNativeToolFactories(): Array<(cwd: string, options?: any) => ToolDefinition<any, any>> {
  if (!hasNativeToolFactories()) return [];
  return [
    codingAgent.createReadToolDefinition,
    codingAgent.createWriteToolDefinition,
    codingAgent.createEditToolDefinition,
    codingAgent.createBashToolDefinition,
    codingAgent.createFindToolDefinition,
    codingAgent.createGrepToolDefinition as unknown as (cwd: string, options?: any) => ToolDefinition<any, any>,
    codingAgent.createLsToolDefinition,
  ];
}

export interface LocalReadonlyToolSpec {
  name: LocalReadonlyToolName;
  label: string;
  description: string;
  factory: (cwd: string, options?: any) => ToolDefinition<any, any>;
}

export function getNativeReadonlyToolFactories(): LocalReadonlyToolSpec[] {
  if (!hasNativeToolFactories()) return [];
  return [
    {
      name: "local_read",
      label: "Local Read",
      description: "Read a text or image file on the local machine (relative paths resolve against the local session working directory, not the SSH remote workspace).",
      factory: codingAgent.createReadToolDefinition,
    },
    {
      name: "local_ls",
      label: "Local List",
      description: "List directory contents on the local machine (relative paths resolve against the local session working directory, not the SSH remote workspace).",
      factory: codingAgent.createLsToolDefinition,
    },
    {
      name: "local_find",
      label: "Local Find",
      description: "Find files by glob pattern on the local machine (relative paths resolve against the local session working directory, not the SSH remote workspace).",
      factory: codingAgent.createFindToolDefinition,
    },
    {
      name: "local_grep",
      label: "Local Grep",
      description: "Search file contents on the local machine (relative paths resolve against the local session working directory, not the SSH remote workspace).",
      factory: codingAgent.createGrepToolDefinition as unknown as (cwd: string, options?: any) => ToolDefinition<any, any>,
    },
  ];
}

export function remotePath(value: string, home: string): string {
  const normalized = value.replace(UNICODE_SPACES, " ").replace(/^@/, "");
  return normalized === "~" ? home : normalized.startsWith("~/") ? posix.join(home, normalized.slice(2)) : normalized;
}

function readUint16LE(buf: Buffer, offset: number): number {
  return (buf[offset] ?? 0) + ((buf[offset + 1] ?? 0) << 8);
}
function readUint32BE(buf: Buffer, offset: number): number {
  return ((buf[offset] ?? 0) * 0x1000000) + ((buf[offset + 1] ?? 0) << 16) + ((buf[offset + 2] ?? 0) << 8) + (buf[offset + 3] ?? 0);
}
function readUint32LE(buf: Buffer, offset: number): number {
  return (buf[offset] ?? 0) + ((buf[offset + 1] ?? 0) << 8) + ((buf[offset + 2] ?? 0) << 16) + ((buf[offset + 3] ?? 0) * 0x1000000);
}
function isAnimatedPng(buf: Buffer): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buf.length) {
    const length = readUint32BE(buf, offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "acTL") return true;
    if (type === "IDAT") return false;
    const next = offset + 12 + length;
    if (next <= offset || next > buf.length) return false;
    offset = next;
  }
  return false;
}
function isValidBmp(buf: Buffer): boolean {
  if (buf.length < 26) return false;
  const fileSize = readUint32LE(buf, 2);
  const pixelOffset = readUint32LE(buf, 10);
  const dibSize = readUint32LE(buf, 14);
  if ((fileSize !== 0 && fileSize < 26) || pixelOffset < 14 + dibSize || (fileSize !== 0 && pixelOffset >= fileSize)) return false;
  if (dibSize === 12) return readUint16LE(buf, 22) === 1 && [1, 4, 8, 16, 24, 32].includes(readUint16LE(buf, 24));
  if (dibSize >= 40 && dibSize <= 124 && buf.length >= 30) {
    return readUint16LE(buf, 26) === 1 && [1, 4, 8, 16, 24, 32].includes(readUint16LE(buf, 28));
  }
  return false;
}

/** Magic-byte image sniffing on already-fetched buffers (zero extra SSH round-trips). */
export function detectImageMimeType(buf: Buffer): string | null {
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return buf[3] === 0xf7 ? null : "image/jpeg";
  if (buf.length >= 16 && PNG_SIGNATURE.every((b, i) => buf[i] === b)) {
    return readUint32BE(buf, 8) === 13 && buf.subarray(12, 16).toString("ascii") === "IHDR" && !isAnimatedPng(buf) ? "image/png" : null;
  }
  if (buf.length >= 6) {
    const head = buf.subarray(0, 6).toString("ascii");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d && isValidBmp(buf)) return "image/bmp";
  return null;
}

export function bashOperations(client: RemoteClient, root: string): BashOperations {
  return {
    async exec(command, _cwd, options) {
      const effectiveTimeout = options.timeout ?? client.config.commandTimeoutSeconds;
      try {
        const result = await client.bash(command, root, {
          signal: options.signal, onData: options.onData, collect: false,
          timeoutMs: effectiveTimeout * 1000,
        });
        return { exitCode: result.exitCode };
      } catch (error) {
        if (error instanceof ProcessAbortError || options.signal?.aborted) throw new Error("aborted");
        if (error instanceof ProcessTimeoutError) throw new Error(`timeout:${effectiveTimeout}`);
        throw error;
      }
    },
  };
}

function formatGrepOutput(result: TextOutput): { content: Array<{ type: "text"; text: string }>; details: GrepToolDetails | undefined } {
  if (!result.text) return { content: [{ type: "text", text: "No matches found" }], details: undefined };
  let text = result.text;
  const notices: string[] = [];
  const details: GrepToolDetails = {};
  if (result.matchLimitReached) {
    notices.push(`${result.matchLimitReached} matches limit reached. Use limit=${result.matchLimitReached * 2} for more, or refine pattern`);
    details.matchLimitReached = result.matchLimitReached;
  }
  if (result.byteTruncated) {
    notices.push("50.0KB limit reached");
    details.truncation = {
      content: result.text,
      truncated: true,
      truncatedBy: "bytes",
      totalLines: result.text.split("\n").length,
      totalBytes: Buffer.byteLength(result.text, "utf8"),
      outputLines: result.text.split("\n").length,
      outputBytes: Buffer.byteLength(result.text, "utf8"),
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines: Number.MAX_SAFE_INTEGER,
      maxBytes: MAX_TOOL_TEXT_BYTES,
    };
  }
  if (result.linesTruncated) {
    notices.push("Some lines truncated to 500 chars. Use read tool to see full lines");
    details.linesTruncated = true;
  }
  if (!notices.length && result.truncated) notices.push("Results truncated; narrow the search");
  if (notices.length) text += `\n\n[${notices.join(". ")}]`;
  return { content: [{ type: "text", text }], details: Object.keys(details).length ? details : undefined };
}

function renderEditDiff(path: string, edits: Array<{ oldText: string; newText: string }>): string {
  const blocks = edits.map((item, idx) => {
    const removed = item.oldText.split("\n").map(line => `-${line}`).join("\n");
    const added = item.newText.split("\n").map(line => `+${line}`).join("\n");
    return `@@ edit ${idx + 1} @@\n${removed}\n${added}`;
  });
  return [`--- a/${path}`, `+++ b/${path}`, ...blocks].join("\n");
}

function applyTextEdits(path: string, rawBuffer: Buffer, edits: Array<{ oldText: string; newText: string }>): { updated: string; diff: string } {
  if (rawBuffer.subarray(0, 8192).includes(0)) throw new Error(`Cannot edit binary file: ${path}`);
  const decoded = rawBuffer.toString("utf8");
  const hasBom = decoded.startsWith("\uFEFF");
  const body = hasBom ? decoded.slice(1) : decoded;
  const crlf = body.includes("\r\n") && !body.replaceAll("\r\n", "").includes("\n");
  const normalized = body.replaceAll("\r\n", "\n");
  const normalizedEdits = edits.map(item => ({
    oldText: item.oldText.replaceAll("\r\n", "\n"),
    newText: item.newText.replaceAll("\r\n", "\n"),
  }));

  const matches: Array<{ start: number; end: number; newText: string }> = [];
  for (const item of normalizedEdits) {
    if (!item.oldText) throw new Error(`oldText must not be empty when editing ${path}`);
    const first = normalized.indexOf(item.oldText);
    if (first < 0) throw new Error(`Could not find exact oldText in ${path}. Read the latest file content first.`);
    const second = normalized.indexOf(item.oldText, first + 1);
    if (second >= 0) throw new Error(`Found multiple occurrences of oldText in ${path}; include more surrounding lines.`);
    matches.push({ start: first, end: first + item.oldText.length, newText: item.newText });
  }

  const ordered = [...matches].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]!.start < ordered[i - 1]!.end) {
      throw new Error(`Overlapping edits in ${path}; combine overlapping changes into a single edit.`);
    }
  }

  let cursor = 0;
  let result = "";
  for (const patch of ordered) {
    result += normalized.slice(cursor, patch.start) + patch.newText;
    cursor = patch.end;
  }
  result += normalized.slice(cursor);
  const withLineEndings = crlf ? result.replaceAll("\n", "\r\n") : result;
  return {
    updated: `${hasBom ? "\uFEFF" : ""}${withLineEndings}`,
    diff: renderEditDiff(path, normalizedEdits),
  };
}

function tailBytesUtf8(chunks: Buffer[], maxBytes: number): { text: string; truncated: boolean } {
  const full = Buffer.concat(chunks);
  if (full.length <= maxBytes) return { text: full.toString("utf8"), truncated: false };
  let slice = full.subarray(full.length - maxBytes);
  // Advance past any UTF-8 continuation bytes so we never emit a replacement char at start.
  let offset = 0;
  while (offset < slice.length && offset < 4 && (slice[offset]! & 0b1100_0000) === 0b1000_0000) offset++;
  slice = slice.subarray(offset);
  return { text: slice.toString("utf8"), truncated: true };
}

export const REMOTE_DESKTOP_TOOL_SCHEMAS = {
  remote_read: {
    label: "Remote Read (SSH)",
    description: "Read a text or image file from the bound SSH remote workspace. Paths are relative to the remote workspace root (or ~/ / absolute within workspace).",
    parameters: Type.Object({
      path: Type.String({ description: "Remote file path within the SSH workspace" }),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-based start line number for text files" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, description: "Maximum number of lines to return (default: 2000)" })),
    }),
  },
  remote_write: {
    label: "Remote Write (SSH)",
    description: "Atomically create or overwrite a UTF-8 file in the bound SSH remote workspace, creating parent directories as needed.",
    parameters: Type.Object({
      path: Type.String({ description: "Remote file path within the SSH workspace" }),
      content: Type.String({ description: "Complete file content to write" }),
    }),
  },
  remote_edit: {
    label: "Remote Edit (SSH)",
    description: "Apply conflict-checked exact text replacements to an existing UTF-8 file in the bound SSH remote workspace. Supply either oldText/newText or edits[].",
    parameters: Type.Object({
      path: Type.String({ description: "Remote file path within the SSH workspace" }),
      oldText: Type.Optional(Type.String({ description: "Exact existing text to replace (when performing a single edit)" })),
      newText: Type.Optional(Type.String({ description: "Replacement text (when performing a single edit)" })),
      edits: Type.Optional(Type.Array(Type.Object({
        oldText: Type.String({ description: "Exact existing text to replace" }),
        newText: Type.String({ description: "Replacement text" }),
      }), { minItems: 1, description: "Multiple non-overlapping exact replacements in the same file" })),
    }),
  },
  remote_bash: {
    label: "Remote Bash (SSH)",
    description: "Execute a bash command on the bound SSH host starting in the remote workspace root.",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to run on the SSH host" }),
      timeout: Type.Optional(Type.Number({ minimum: 0.1, maximum: 3600, description: "Optional command timeout in seconds" })),
    }),
  },
  remote_ls: {
    label: "Remote List Directory (SSH)",
    description: "List directory entries inside the bound SSH remote workspace.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory path relative to the remote workspace root (default: '.')" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, description: "Maximum entries to list (default: 500)" })),
    }),
  },
  remote_find: {
    label: "Remote Find Files (SSH)",
    description: "Find files by glob pattern inside the bound SSH remote workspace (uses remote ripgrep --files and respects .gitignore).",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern to match remote file paths, e.g. '**/*.ts' or '*.md'" }),
      path: Type.Optional(Type.String({ description: "Subdirectory relative to the remote workspace root (default: '.')" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, description: "Maximum file paths to return (default: 1000)" })),
    }),
  },
  remote_grep: {
    label: "Remote Grep (SSH)",
    description: "Search remote file contents with ripgrep over SSH (respects .gitignore). Returns matching lines with relative paths and line numbers.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Regex or literal search pattern" }),
      path: Type.Optional(Type.String({ description: "File or directory relative to the remote workspace root (default: '.')" })),
      glob: Type.Optional(Type.String({ description: "Optional glob filter such as '*.ts'" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string rather than regex" })),
      context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, description: "Context lines before and after each match" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Maximum matches to return (default: 100)" })),
    }),
  },
} as const;

/**
 * Self-contained remote tools for hosts like PI-Desktop where core tool names
 * (Read/Write/Edit/Bash/Glob/Grep) are reserved and SDK tool factories are shimmed.
 */
export function createStandaloneRemoteTools(
  client: RemoteClient,
  probe: Pick<Probe, "root" | "home">,
  signal?: AbortSignal,
): Record<RemoteDesktopToolName, ToolDefinition<any, any>> {
  const norm = (value: unknown, fallback = ".") => remotePath(typeof value === "string" && value.trim() ? value : fallback, probe.home);

  return {
    remote_read: {
      name: "remote_read",
      ...REMOTE_DESKTOP_TOOL_SCHEMAS.remote_read,
      async execute(_id, params: { path: string; offset?: number; limit?: number }, toolSignal) {
        const activeSignal = toolSignal ?? signal;
        const target = norm(params.path);
        const file = await client.read(target, activeSignal);
        const buffer = Buffer.from(file.data, "base64");
        const mimeType = detectImageMimeType(buffer);
        if (mimeType) {
          return {
            content: [
              { type: "text", text: `Read remote image file ${target} [${mimeType}]` },
              { type: "image", data: file.data, mimeType },
            ],
            details: { path: target, mimeType, bytes: buffer.length },
          };
        }
        if (buffer.subarray(0, 8192).includes(0)) {
          throw new Error(`Binary file cannot be displayed as UTF-8 text: ${target}`);
        }
        const raw = buffer.toString("utf8");
        const text = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
        const lines = text.replaceAll("\r\n", "\n").split("\n");
        const start = Math.max(1, params.offset ?? 1);
        const maxLines = Math.max(1, Math.min(5000, params.limit ?? MAX_READ_LINES));
        if (start > lines.length && lines.length > 0) {
          return {
            content: [{ type: "text", text: `[Offset ${start} exceeds file length (${lines.length} lines) in ${target}]` }],
            details: { path: target, totalLines: lines.length },
          };
        }
        const selected: string[] = [];
        let bytes = 0;
        let truncatedByBytes = false;
        const endLimit = Math.min(lines.length, start - 1 + maxLines);
        for (let idx = start - 1; idx < endLimit; idx++) {
          const line = lines[idx]!;
          const lineBytes = Buffer.byteLength(line, "utf8") + 1;
          if (selected.length > 0 && bytes + lineBytes > MAX_TOOL_TEXT_BYTES) {
            truncatedByBytes = true;
            break;
          }
          selected.push(line);
          bytes += lineBytes;
        }
        const endLine = start + selected.length - 1;
        let output = selected.join("\n");
        if (endLine < lines.length || truncatedByBytes) {
          output += `\n\n[Showing lines ${start}-${endLine} of ${lines.length}${truncatedByBytes ? " (50.0KB limit)" : ""}. Use offset=${endLine + 1} to read more.]`;
        }
        return {
          content: [{ type: "text", text: output }],
          details: { path: target, startLine: start, endLine, totalLines: lines.length },
        };
      },
    },
    remote_write: {
      name: "remote_write",
      ...REMOTE_DESKTOP_TOOL_SCHEMAS.remote_write,
      async execute(_id, params: { path: string; content: string }, toolSignal) {
        const activeSignal = toolSignal ?? signal;
        const target = norm(params.path);
        const content = String(params.content ?? "");
        await client.write(target, content, undefined, activeSignal);
        const bytes = Buffer.byteLength(content, "utf8");
        return {
          content: [{ type: "text", text: `Successfully wrote ${bytes} bytes to remote file ${target}` }],
          details: { path: target, bytes },
        };
      },
    },
    remote_edit: {
      name: "remote_edit",
      ...REMOTE_DESKTOP_TOOL_SCHEMAS.remote_edit,
      async execute(_id, params: { path: string; oldText?: string; newText?: string; edits?: Array<{ oldText: string; newText: string }> }, toolSignal) {
        const activeSignal = toolSignal ?? signal;
        const target = norm(params.path);
        const edits = Array.isArray(params.edits) && params.edits.length > 0
          ? params.edits
          : typeof params.oldText === "string" && typeof params.newText === "string"
            ? [{ oldText: params.oldText, newText: params.newText }]
            : [];
        if (edits.length === 0) {
          throw new Error("Provide either { oldText, newText } or a non-empty edits[] array");
        }
        const preflight = await client.rpc<{ data: string; etag: string }>("read", { path: target, writable: true }, activeSignal);
        const { updated, diff } = applyTextEdits(target, Buffer.from(preflight.data, "base64"), edits);
        await client.write(target, updated, preflight.etag, activeSignal);
        return {
          content: [{ type: "text", text: `Edited remote file ${target} (${edits.length} change${edits.length > 1 ? "s" : ""}):\n\n${diff}` }],
          details: { path: target, diff, editsApplied: edits.length },
        };
      },
    },
    remote_bash: {
      name: "remote_bash",
      ...REMOTE_DESKTOP_TOOL_SCHEMAS.remote_bash,
      async execute(_id, params: { command: string; timeout?: number }, toolSignal, onUpdate) {
        const activeSignal = toolSignal ?? signal;
        const effectiveTimeout = params.timeout ?? client.config.commandTimeoutSeconds;
        const chunks: Buffer[] = [];
        let retainedBytes = 0;
        let overflowed = false;
        const pushChunk = (data: Buffer) => {
          chunks.push(data);
          retainedBytes += data.length;
          while (chunks.length > 1 && retainedBytes - chunks[0]!.length > MAX_TOOL_TEXT_BYTES * 2) {
            retainedBytes -= chunks.shift()!.length;
            overflowed = true;
          }
          if (onUpdate) {
            const snapshot = tailBytesUtf8(chunks, MAX_TOOL_TEXT_BYTES);
            onUpdate({ content: [{ type: "text", text: snapshot.text }], details: {} });
          }
        };
        try {
          const result = await client.bash(params.command, probe.root, {
            signal: activeSignal,
            timeoutMs: effectiveTimeout * 1000,
            collect: false,
            onData: pushChunk,
          });
          const rendered = tailBytesUtf8(chunks, MAX_TOOL_TEXT_BYTES);
          let text = rendered.text || "(no output)";
          if (overflowed || rendered.truncated) text = `[Output truncated to last 50.0KB]\n${text}`;
          if (result.exitCode !== 0) text += `\n\nCommand exited with code ${result.exitCode}`;
          return {
            content: [{ type: "text", text }],
            details: { exitCode: result.exitCode, truncated: overflowed || rendered.truncated },
            ...(result.exitCode !== 0 ? { isError: true } : {}),
          };
        } catch (error) {
          const partial = tailBytesUtf8(chunks, MAX_TOOL_TEXT_BYTES).text;
          if (error instanceof ProcessTimeoutError) {
            const prefix = partial ? `${partial}\n\n` : "";
            throw new Error(`${prefix}Command timed out after ${effectiveTimeout} seconds`);
          }
          if (error instanceof ProcessAbortError || activeSignal?.aborted) {
            const prefix = partial ? `${partial}\n\n` : "";
            throw new Error(`${prefix}Command aborted`);
          }
          throw error;
        }
      },
    },
    remote_ls: {
      name: "remote_ls",
      ...REMOTE_DESKTOP_TOOL_SCHEMAS.remote_ls,
      async execute(_id, params: { path?: string; limit?: number }, toolSignal) {
        const activeSignal = toolSignal ?? signal;
        const target = norm(params?.path, ".");
        const limit = Math.max(1, Math.min(5000, params?.limit ?? 500));
        const entries = (await client.list(target, activeSignal))
          .filter(entry => !entry.escaped)
          .sort((a, b) => a.name.localeCompare(b.name));
        if (!entries.length) return { content: [{ type: "text", text: "(empty directory)" }], details: { path: target, count: 0 } };
        const shown = entries.slice(0, limit).map(entry => `${entry.name}${entry.directory ? "/" : ""}`);
        let text = shown.join("\n");
        if (entries.length > limit) text += `\n\n[${entries.length - limit} more entries omitted; pass a larger limit or inspect a subdirectory]`;
        return { content: [{ type: "text", text }], details: { path: target, count: entries.length } };
      },
    },
    remote_find: {
      name: "remote_find",
      ...REMOTE_DESKTOP_TOOL_SCHEMAS.remote_find,
      async execute(_id, params: { pattern: string; path?: string; limit?: number }, toolSignal) {
        const activeSignal = toolSignal ?? signal;
        const target = norm(params.path, ".");
        const limit = params.limit ?? 1000;
        const result = await client.rpc<TextOutput>("find", { path: target, pattern: params.pattern, limit }, activeSignal);
        if (!result.text) return { content: [{ type: "text", text: "No files found matching pattern" }], details: { path: target, count: 0 } };
        let text = result.text;
        if (result.truncated) text += `\n\n[Results truncated at ${limit} files; narrow the pattern or path]`;
        return { content: [{ type: "text", text }], details: { path: target, truncated: result.truncated } };
      },
    },
    remote_grep: {
      name: "remote_grep",
      ...REMOTE_DESKTOP_TOOL_SCHEMAS.remote_grep,
      async execute(_id, params: Record<string, unknown>, toolSignal) {
        const activeSignal = toolSignal ?? signal;
        const normalized = typeof params?.path === "string" ? { ...params, path: norm(params.path) } : params;
        const result = await client.rpc<TextOutput>("grep", normalized, activeSignal);
        return formatGrepOutput(result);
      },
    },
  };
}

/** Keep the SDK's validation, edit diffs, images, truncation and renderers while minimizing SSH round-trips. */
export function createRemoteTools(client: RemoteClient, probe: Pick<Probe, "root" | "home">, signal?: AbortSignal): Record<string, ToolDefinition<any, any>> {
  const root = probe.root;
  const normalizeArgs = (params: unknown) => {
    const args = params as Record<string, unknown>;
    return typeof args?.path === "string" ? { ...args, path: remotePath(args.path, probe.home) } : args;
  };

  const baseRead = codingAgent.createReadToolDefinition(root) as ToolDefinition<any, any>;
  const baseWrite = codingAgent.createWriteToolDefinition(root) as ToolDefinition<any, any>;
  const baseEdit = codingAgent.createEditToolDefinition(root) as ToolDefinition<any, any>;
  const baseBash = codingAgent.createBashToolDefinition(root, { operations: bashOperations(client, root), exposeSessionEnvironment: false }) as ToolDefinition<any, any>;
  const baseLs = codingAgent.createLsToolDefinition(root) as ToolDefinition<any, any>;
  const baseFind = codingAgent.createFindToolDefinition(root) as ToolDefinition<any, any>;
  const baseGrep = codingAgent.createGrepToolDefinition(root) as unknown as ToolDefinition<any, any>;

  return {
    read: {
      ...baseRead,
      execute(id, params, toolSignal, update, ctx) {
        const activeSignal = toolSignal ?? signal;
        let cached: { path: string; buffer: Buffer } | undefined;
        const load = async (path: string) => {
          if (cached?.path === path) return cached.buffer;
          const file = await client.read(path, activeSignal);
          const buffer = Buffer.from(file.data, "base64");
          cached = { path, buffer };
          return buffer;
        };
        const impl = codingAgent.createReadToolDefinition(root, {
          operations: {
            access: async path => { await load(path); },
            detectImageMimeType: async path => detectImageMimeType(await load(path)),
            readFile: async path => {
              const buffer = await load(path);
              cached = undefined;
              return buffer;
            },
          },
        }) as ToolDefinition<any, any>;
        return impl.execute(id, normalizeArgs(params), activeSignal, update, { ...ctx, cwd: root });
      },
    },
    write: {
      ...baseWrite,
      execute(id, params, toolSignal, update, ctx) {
        const activeSignal = toolSignal ?? signal;
        // Remote write validates and creates parent directories atomically in a single RPC.
        const impl = codingAgent.createWriteToolDefinition(root, {
          operations: {
            mkdir: async () => {},
            writeFile: async (path, content) => { await client.write(path, content, undefined, activeSignal); },
          },
        }) as ToolDefinition<any, any>;
        return impl.execute(id, normalizeArgs(params), activeSignal, update, { ...ctx, cwd: root });
      },
    },
    edit: {
      ...baseEdit,
      execute(id, params, toolSignal, update, ctx) {
        const activeSignal = toolSignal ?? signal;
        let preflight: { path: string; buffer: Buffer; etag: string } | undefined;
        let etag: string | undefined;
        const loadWritable = async (path: string) => {
          if (preflight?.path === path) return preflight;
          const file = await client.rpc<{ data: string; etag: string }>("read", { path, writable: true }, activeSignal);
          preflight = { path, buffer: Buffer.from(file.data, "base64"), etag: file.etag };
          return preflight;
        };
        const impl = codingAgent.createEditToolDefinition(root, {
          operations: {
            access: async path => { await loadWritable(path); },
            readFile: async path => {
              const loaded = await loadWritable(path);
              etag = loaded.etag;
              preflight = undefined;
              return loaded.buffer;
            },
            writeFile: async (path, content) => {
              if (!etag) throw new Error("Missing conflict token before remote edit write");
              await client.write(path, content, etag, activeSignal);
            },
          },
        }) as ToolDefinition<any, any>;
        return impl.execute(id, normalizeArgs(params), activeSignal, update, { ...ctx, cwd: root });
      },
    },
    bash: {
      ...baseBash,
      execute(id, params, toolSignal, update, ctx) {
        return baseBash.execute(id, normalizeArgs(params), toolSignal ?? signal, update, { ...ctx, cwd: root });
      },
    },
    ls: {
      ...baseLs,
      execute(id, params, toolSignal, update, ctx) {
        const activeSignal = toolSignal ?? signal;
        let snapshot: { dir: string; directory: boolean; entries: DirectoryEntry[]; byPath: Map<string, DirectoryEntry> } | undefined;
        const impl = codingAgent.createLsToolDefinition(root, {
          operations: {
            exists: async path => {
              try {
                const entries = await client.list(path, activeSignal);
                const byPath = new Map(entries.map(item => [posix.join(path, item.name), item]));
                snapshot = { dir: path, directory: true, entries, byPath };
                return true;
              } catch (error) {
                const message = (error as Error).message;
                if (message.startsWith("Path not found:")) return false;
                if (message.startsWith("Not a directory:")) {
                  snapshot = { dir: path, directory: false, entries: [], byPath: new Map() };
                  return true;
                }
                throw error;
              }
            },
            stat: async path => {
              if (snapshot?.dir === path) return { isDirectory: () => snapshot!.directory };
              const entry = snapshot?.byPath.get(path);
              if (entry) {
                if (entry.escaped) throw new Error(`Symlink escapes workspace: ${path}`);
                return { isDirectory: () => entry.directory };
              }
              const info = await client.rpc<{ exists: boolean; directory: boolean }>("stat", { path }, activeSignal);
              return { isDirectory: () => info.directory };
            },
            readdir: async path => snapshot?.dir === path ? snapshot.entries.map(item => item.name) : (await client.list(path, activeSignal)).map(item => item.name),
          },
        }) as ToolDefinition<any, any>;
        return impl.execute(id, normalizeArgs(params), activeSignal, update, { ...ctx, cwd: root });
      },
    },
    find: {
      ...baseFind,
      execute(id, params, toolSignal, update, ctx) {
        const activeSignal = toolSignal ?? signal;
        // Remote find checks path existence inside a single RPC.
        const impl = codingAgent.createFindToolDefinition(root, {
          operations: {
            exists: async () => true,
            glob: async (pattern, cwd, options) => {
              const result = await client.rpc<TextOutput>("find", { path: cwd, pattern, limit: options.limit }, activeSignal);
              return result.text ? result.text.split("\n") : [];
            },
          },
        }) as ToolDefinition<any, any>;
        return impl.execute(id, normalizeArgs(params), activeSignal, update, { ...ctx, cwd: root });
      },
    },
    grep: {
      ...baseGrep,
      outputSchema: undefined,
      description: "Search remote file contents with ripgrep over SSH (respects .gitignore). Returns matching lines with relative paths and line numbers.",
      async execute(_id, params, toolSignal) {
        const activeSignal = toolSignal ?? signal;
        const normalized = normalizeArgs(params);
        const result = await client.rpc<TextOutput>("grep", normalized, activeSignal);
        return formatGrepOutput(result);
      },
    },
  };
}
