// Tool delegation follows pi's MIT-licensed SSH example; see THIRD_PARTY_NOTICES.md.
import { posix } from "node:path";
import {
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
  createBashToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition,
  type BashOperations, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { RemoteClient, type Probe, type TextOutput } from "./remote.js";

export function remotePath(value: string, home: string): string {
  return value === "~" ? home : value.startsWith("~/") ? posix.join(home, value.slice(2)) : value;
}

export function bashOperations(client: RemoteClient, root: string): BashOperations {
  return {
    async exec(command, _cwd, options) {
      const result = await client.bash(command, root, {
        signal: options.signal, onData: options.onData, collect: false,
        timeoutMs: (options.timeout ?? client.config.commandTimeoutSeconds) * 1000,
      });
      return { exitCode: result.exitCode };
    },
  };
}

/** Keep the SDK's validation, edit diffs, images, truncation and renderers. */
export function createRemoteTools(client: RemoteClient, probe: Pick<Probe, "root" | "home">, signal?: AbortSignal): Record<string, ToolDefinition<any, any>> {
  const root = probe.root;
  const readFile = async (path: string) => Buffer.from((await client.read(path, signal)).data, "base64");
  const access = async (path: string) => { await client.rpc("access", { path }, signal); };
  const writeFile = async (path: string, content: string) => { await client.write(path, content, undefined, signal); };
  const stat = (path: string) => client.rpc<{ exists: boolean; directory: boolean; mime: string | null }>("stat", { path }, signal);
  const tools: Record<string, ToolDefinition<any, any>> = {
    read: createReadToolDefinition(root, { operations: {
      readFile, access,
      detectImageMimeType: async path => {
        const mime = (await stat(path)).mime;
        return mime && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime) ? mime : null;
      },
    } }),
    write: createWriteToolDefinition(root, { operations: { writeFile, mkdir: async path => { await client.rpc("mkdir", { path }, signal); } } }),
    edit: createEditToolDefinition(root, { operations: (() => {
      // The native edit tool reads before writing. Use that version as a conflict guard.
      const versions = new Map<string, string>();
      return {
        access,
        readFile: async (path: string) => {
          const file = await client.read(path, signal);
          versions.set(path, file.etag);
          return Buffer.from(file.data, "base64");
        },
        writeFile: async (path: string, content: string) => { await client.write(path, content, versions.get(path), signal); },
      };
    })() }),
    bash: createBashToolDefinition(root, { operations: bashOperations(client, root), exposeSessionEnvironment: false }),
    ls: createLsToolDefinition(root, { operations: {
      exists: async path => (await stat(path)).exists,
      stat: async path => { const info = await stat(path); return { isDirectory: () => info.directory }; },
      readdir: async path => (await client.list(path, signal)).map(item => item.name),
    } }),
    find: createFindToolDefinition(root, { operations: {
      exists: async path => (await stat(path)).exists,
      glob: async (pattern, cwd, options) => {
        const result = await client.rpc<TextOutput>("find", { path: cwd, pattern, limit: options.limit }, signal);
        return result.text ? result.text.split("\n") : [];
      },
    } }),
    grep: {
      ...(createGrepToolDefinition(root) as unknown as ToolDefinition<any, any>),
      outputSchema: undefined,
      description: "Search remote file contents with ripgrep over SSH (respects .gitignore).",
      async execute(_id, params, toolSignal) {
        const result = await client.rpc<TextOutput>("grep", params as Record<string, unknown>, toolSignal ?? signal);
        const text = result.text || "No matches found";
        return { content: [{ type: "text", text: text + (result.truncated ? "\n[Results truncated; narrow the search.]" : "") }], details: {} };
      },
    },
  };
  for (const tool of Object.values(tools)) {
    const execute = tool.execute;
    tool.execute = (id, params, toolSignal, update, ctx) => {
      const args = params as Record<string, unknown>;
      return execute(id, typeof args.path === "string" ? { ...args, path: remotePath(args.path, probe.home) } : args,
        toolSignal, update, { ...ctx, cwd: root });
    };
  }
  return tools;
}
