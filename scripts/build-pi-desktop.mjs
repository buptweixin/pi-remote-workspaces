import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/;
const PLUGIN_VIEW_ICONS = new Set([
  "bell", "book", "bot", "branch", "browser", "chat", "clock", "diff", "files",
  "folder", "image", "key", "link", "list-checks", "palette", "plug", "pull-request",
  "search", "server", "shield", "sparkles", "target", "terminal", "workflow", "wrench",
]);
const PLUGIN_RENDERER_ACTIONS = new Set([
  "plugin.call",
  "composer.insertText",
  "composer.readDraft",
  "composer.replaceDraft",
  "attachments.add",
  "attachments.list",
  "attachments.remove",
]);
const KNOWN_PERMISSIONS = new Set([
  "ui.panel", "ui.view", "ui.theme", "ui.settings", "ui.window.appearance",
  "clipboard.read", "clipboard.write", "notify", "fs.read", "fs.write", "fs.delete",
  "agent.tool.register", "agent.prompt.inject", "agent.complete", "agent.extension",
  "composer.transform", "composer.suggest", "renderer.extension", "provider.register",
  "provider.oauth", "models.list", "net.fetch", "net.anyHost", "shell.openExternal",
  "mcp.server.local", "mcp.server.remote", "background.service", "bus.publish",
  "bus.subscribe", "browser.cdp", "desktop.control", "ui.microphone", "project.create",
  "session.read", "session.import", "session.read.own", "session.update.own",
  "session.delete.own", "session.read.all", "session.update.all", "session.delete.all",
  "session.autoTitle", "usage.read", "audio.capture.background",
  "audio.playback.background", "speech.adapter.register", "keyboard.globalShortcut",
  "net.websocket",
]);
const PERMISSION_API_HINTS = {
  "ui.panel": ["ui.openPanel", "ui.closePanel"],
  "clipboard.write": ["clipboard.writeText"],
  notify: ["ui.notify", "ui.showNativeNotification"],
};
const RUNTIME_FILES = [
  "config.js",
  "anchors.js",
  "process.js",
  "ssh-config.js",
  "remote-script.js",
  "remote.js",
  "dashboard-api.js",
  "server.js",
  "tools.js",
  "pi-web.js",
  "extension.js",
];
const PUBLIC_VIEW_FILES = ["index.html", "app.js", "style.css", "favicon.svg"];
const DESKTOP_WORKBENCH_FILES = ["workbench.html", "workbench.css", "workbench.js"];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a store-only (method 0) ZIP matching PI-Desktop host-core's extract_zip_bytes contract. */
export function buildStoreZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const localBlock = Buffer.concat([local, name, data]);
    locals.push(localBlock);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));

    offset += localBlock.length;
  }

  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBlock, eocd]);
}

async function walkDirectory(rootDir, relPrefix = "") {
  const entries = await readdir(join(rootDir, relPrefix), { withFileTypes: true });
  const files = [];
  for (const item of entries) {
    if (item.name === ".git" || item.name === "node_modules" || item.name === ".DS_Store" || (relPrefix === "" && item.name === "dist")) {
      continue;
    }
    const relPath = relPrefix ? posix.join(relPrefix, item.name) : item.name;
    const absPath = join(rootDir, relPath);
    const st = await lstat(absPath);
    assert.ok(!st.isSymbolicLink(), `Symlinks are forbidden in PI-Desktop packages: ${relPath}`);
    if (st.isDirectory()) {
      files.push(...await walkDirectory(rootDir, relPath));
    } else if (st.isFile()) {
      assert.ok(!/(^|\/)(\.env(\..+)?|\.npmrc|.*\.(pem|key))$/i.test(relPath), `Credential file forbidden in package: ${relPath}`);
      files.push({ path: relPath, absolutePath: absPath, size: st.size });
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function buildPiDesktopPlugin({
  projectDir = process.cwd(),
  outDir = resolve(projectDir, "release-artifacts"),
} = {}) {
  if (!existsSync(join(projectDir, "dist/pi-desktop-main.js"))) {
    const tscBin = join(projectDir, "node_modules/typescript/bin/tsc");
    const compile = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.build.json"], { cwd: projectDir, encoding: "utf8" });
    if (compile.error || compile.status !== 0) {
      throw new Error(`TypeScript build failed:\n${compile.stderr || compile.stdout || compile.error?.message}`);
    }
  }
  const rootPkg = JSON.parse(await readFile(join(projectDir, "package.json"), "utf8"));
  const pluginDir = join(projectDir, "pi-desktop");
  const manifestPath = join(pluginDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== rootPkg.version) {
    manifest.version = rootPkg.version;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  await rm(join(pluginDir, "renderer"), { recursive: true, force: true });
  await rm(join(pluginDir, "runtime"), { recursive: true, force: true });
  await rm(join(pluginDir, "views"), { recursive: true, force: true });
  await mkdir(join(pluginDir, "renderer"), { recursive: true });
  await mkdir(join(pluginDir, "runtime"), { recursive: true });
  await mkdir(join(pluginDir, "views"), { recursive: true });

  const mainCompiled = await readFile(join(projectDir, "dist/pi-desktop-main.js"), "utf8");
  await writeFile(
    join(pluginDir, "main.js"),
    mainCompiled.replace(/from "\.\/([^"]+)"/g, 'from "./runtime/$1"'),
    "utf8",
  );
  await writeFile(
    join(pluginDir, "package.json"),
    `${JSON.stringify({ name: "pi-remote-desktop-plugin", version: rootPkg.version, private: true, type: "module" }, null, 2)}\n`,
    "utf8",
  );

  await copyFile(join(projectDir, "src/pi-desktop-renderer/index.mjs"), join(pluginDir, "renderer/index.mjs"));
  for (const file of RUNTIME_FILES) {
    await copyFile(join(projectDir, "dist", file), join(pluginDir, "runtime", file));
  }
  for (const file of PUBLIC_VIEW_FILES) {
    await copyFile(join(projectDir, "public", file), join(pluginDir, "views", file));
  }
  for (const file of DESKTOP_WORKBENCH_FILES) {
    await copyFile(join(projectDir, "src/pi-desktop-views", file), join(pluginDir, "views", file));
  }
  await copyFile(join(projectDir, "LICENSE"), join(pluginDir, "LICENSE"));

  // Validate against PI-Desktop's check.ts & manifest contract.
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.id, PLUGIN_ID_PATTERN, `Invalid plugin id: ${manifest.id}`);
  assert.equal(typeof manifest.author, "string", "author must be a display string for Rust host-core");
  const permissions = manifest.permissions ?? [];
  for (const perm of permissions) {
    assert.ok(KNOWN_PERMISSIONS.has(perm), `Unknown PI-Desktop permission: ${perm}`);
  }
  const files = await walkDirectory(pluginDir);
  const fileSet = new Set(files.map(f => f.path));
  assert.ok(fileSet.has(manifest.main), `Missing main entry: ${manifest.main}`);
  if (manifest.icon) assert.ok(fileSet.has(manifest.icon), `Missing icon: ${manifest.icon}`);
  if (manifest.renderer) {
    assert.ok(permissions.includes("renderer.extension"), "renderer requires renderer.extension permission");
    assert.match(manifest.renderer, /\.(?:js|mjs)$/, "renderer entry must be .js or .mjs");
    assert.ok(fileSet.has(manifest.renderer), `Missing renderer entry: ${manifest.renderer}`);
    for (const action of manifest.rendererActions ?? []) {
      assert.ok(PLUGIN_RENDERER_ACTIONS.has(action), `Unknown rendererAction: ${action}`);
    }
    assert.ok((manifest.rendererCallMethods ?? []).length <= 32, "rendererCallMethods exceeds cap of 32");
  }
  if (manifest.ui?.panel) {
    assert.ok(permissions.includes("ui.panel"), "ui.panel requires ui.panel permission");
    assert.ok(fileSet.has(manifest.ui.panel), `Missing ui.panel: ${manifest.ui.panel}`);
  }
  for (const view of manifest.contributes?.views ?? []) {
    assert.ok(permissions.includes("ui.view"), "views require ui.view permission");
    assert.ok(fileSet.has(view.entry), `Missing view entry: ${view.entry}`);
    if (view.icon) assert.ok(PLUGIN_VIEW_ICONS.has(view.icon), `Unknown view icon: ${view.icon}`);
  }
  for (const ext of manifest.contributes?.agentExtensions ?? []) {
    assert.ok(permissions.includes("agent.extension"), "agentExtensions require agent.extension permission");
    assert.ok(fileSet.has(ext), `Missing agentExtension: ${ext}`);
  }
  const mainSource = await readFile(join(pluginDir, manifest.main), "utf8");
  for (const [perm, hints] of Object.entries(PERMISSION_API_HINTS)) {
    if (permissions.includes(perm)) {
      assert.ok(hints.some(hint => mainSource.includes(hint)), `Permission ${perm} unused in ${manifest.main}`);
    }
  }

  // Verify the built plugin entry actually resolves every ESM import in an isolated directory (outside repo node_modules).
  const isolatedVerifyDir = await mkdtemp(join(tmpdir(), "pi-remote-verify-main-"));
  try {
    await cp(pluginDir, isolatedVerifyDir, { recursive: true });
    const loadedMain = await import(pathToFileURL(join(isolatedVerifyDir, manifest.main)).href);
    for (const hook of ["onLoad", "onUnload", "onRendererCall", "onPanelInvoke"]) {
      assert.equal(typeof loadedMain[hook], "function", `Packaged ${manifest.main} missing export: ${hook}`);
    }
  } finally {
    await rm(isolatedVerifyDir, { recursive: true, force: true });
  }

  assert.ok(files.length <= 2000, `Too many files in plugin: ${files.length}`);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  assert.ok(totalBytes <= 50 * 1024 * 1024, `Plugin exceeds 50 MiB: ${totalBytes}`);

  const zipEntries = [];
  for (const file of files) {
    zipEntries.push({ name: file.path, data: await readFile(file.absolutePath) });
  }
  const archiveBytes = buildStoreZip(zipEntries);
  await mkdir(outDir, { recursive: true });
  const fileName = `${manifest.id}-${manifest.version}.piplug`;
  const packagePath = join(outDir, fileName);
  await writeFile(packagePath, archiveBytes);
  const shasum = createHash("sha256").update(archiveBytes).digest("hex");

  return { pluginDir, packagePath, fileName, byteLength: archiveBytes.length, shasum, fileCount: files.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--output-dir")) {
    throw new Error("Usage: node scripts/build-pi-desktop.mjs [--output-dir directory]");
  }
  const outDir = args[1] ? resolve(args[1]) : undefined;
  const result = await buildPiDesktopPlugin({ outDir });
  console.log(JSON.stringify(result, null, 2));
}
