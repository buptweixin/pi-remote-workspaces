// Tool delegation follows pi's MIT-licensed SSH example; see THIRD_PARTY_NOTICES.md.
import { posix } from "node:path";
import {
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createBashToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition,
  type BashOperations, type GrepToolDetails, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ProcessAbortError, ProcessTimeoutError } from "./process.js";
import { RemoteClient, type DirectoryEntry, type Probe, type TextOutput } from "./remote.js";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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

/** Keep the SDK's validation, edit diffs, images, truncation and renderers while minimizing SSH round-trips. */
export function createRemoteTools(client: RemoteClient, probe: Pick<Probe, "root" | "home">, signal?: AbortSignal): Record<string, ToolDefinition<any, any>> {
  const root = probe.root;
  const normalizeArgs = (params: unknown) => {
    const args = params as Record<string, unknown>;
    return typeof args?.path === "string" ? { ...args, path: remotePath(args.path, probe.home) } : args;
  };

  const baseRead = createReadToolDefinition(root) as ToolDefinition<any, any>;
  const baseWrite = createWriteToolDefinition(root) as ToolDefinition<any, any>;
  const baseEdit = createEditToolDefinition(root) as ToolDefinition<any, any>;
  const baseBash = createBashToolDefinition(root, { operations: bashOperations(client, root), exposeSessionEnvironment: false }) as ToolDefinition<any, any>;
  const baseLs = createLsToolDefinition(root) as ToolDefinition<any, any>;
  const baseFind = createFindToolDefinition(root) as ToolDefinition<any, any>;
  const baseGrep = createGrepToolDefinition(root) as unknown as ToolDefinition<any, any>;

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
        const impl = createReadToolDefinition(root, {
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
        const impl = createWriteToolDefinition(root, {
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
        const impl = createEditToolDefinition(root, {
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
        const impl = createLsToolDefinition(root, {
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
        const impl = createFindToolDefinition(root, {
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
            maxBytes: 50 * 1024,
          };
        }
        if (result.linesTruncated) {
          notices.push("Some lines truncated to 500 chars. Use read tool to see full lines");
          details.linesTruncated = true;
        }
        if (!notices.length && result.truncated) notices.push("Results truncated; narrow the search");
        if (notices.length) text += `\n\n[${notices.join(". ")}]`;
        return { content: [{ type: "text", text }], details: Object.keys(details).length ? details : undefined };
      },
    },
  };
}
