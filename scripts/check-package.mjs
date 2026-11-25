import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { buildPiDesktopPlugin } from "./build-pi-desktop.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--output-dir")) {
  throw new Error("Usage: node scripts/check-package.mjs [--output-dir directory]");
}
const project = process.cwd();
const scratch = await mkdtemp(join(tmpdir(), "pi-remote-package-"));
const output = args[1] ? resolve(args[1]) : scratch;
const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));

function run(program, arguments_, cwd = project) {
  const env = { ...process.env };
  // npm run exports user policy as CLI-style environment settings. npm 11 rejects
  // that setting for a child project install; let it read the original .npmrc.
  for (const key of Object.keys(env)) if (/^npm_config_allow[-_]scripts$/i.test(key)) delete env[key];
  const result = spawnSync(program, arguments_, { cwd, env, encoding: "utf8", timeout: 120_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} ${arguments_.join(" ")} failed:\n${result.stderr || result.stdout || result.error?.message}`);
  }
  return result.stdout;
}

try {
  await mkdir(output, { recursive: true });
  const packed = run("npm", ["pack", "--json", "--pack-destination", output]);
  const [archive] = JSON.parse(packed.slice(packed.indexOf("[")));
  const files = new Set(archive.files.map(file => file.path));
  for (const file of ["src/extension.ts", "dist/cli.js", "public/index.html", "public/workbench-core.js", "public/app.js", "public/style.css", "public/favicon.svg", "README.md", "README.zh-CN.md", "CHANGELOG.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    assert.ok(files.has(file), `Missing package file: ${file}`);
  }
  assert.ok(![...files].some(file => /(^|\/)(node_modules|\.git|\.env|\.npmrc)(\/|$)/.test(file)), "Unexpected private or dependency files in package");
  assert.ok(manifest.keywords.includes("pi-package"));
  assert.equal(manifest.publishConfig.access, "public");
  assert.equal(manifest.repository.url, "git+https://github.com/buptweixin/pi-remote-workspaces.git");

  const piplug = await buildPiDesktopPlugin({ projectDir: project, outDir: output });
  const piplugStat = await stat(piplug.packagePath);
  assert.equal(piplugStat.size, piplug.byteLength);
  const piplugHeader = await readFile(piplug.packagePath);
  assert.equal(piplugHeader.readUInt32LE(0), 0x04034b50, ".piplug must be a ZIP archive");
  assert.equal(piplugHeader.readUInt16LE(8), 0, ".piplug must use store-only (method 0) entries");

  const consumer = join(scratch, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "pi-remote-package-fixture", version: "1.0.0", private: true, type: "module" }));
  const tarball = join(output, archive.filename);
  run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-package-lock", tarball], consumer);
  const installed = join(consumer, "node_modules", manifest.name);
  assert.match(run(process.execPath, [join(installed, "dist/cli.js"), "--help"], consumer), /pi-remote serve/);
  assert.match(run(join(consumer, "node_modules/.bin/pi-remote"), ["--help"], consumer), /pi-remote serve/);
  const loader = new DefaultResourceLoader({
    cwd: consumer, agentDir: join(scratch, "agent"), settingsManager: SettingsManager.inMemory(),
    noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [installed],
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.ok(result.extensions.some(extension => extension.commands.has("remote")), "Packed extension did not register /remote");
  console.log(JSON.stringify({
    package: archive.id,
    files: files.size,
    productionInstall: "passed",
    cli: "passed",
    extension: "/remote registered",
    piDesktopPlugin: piplug.fileName,
    piDesktopSha256: piplug.shasum,
    tarball: args[1] ? tarball : "temporary archive removed after verification",
  }, null, 2));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
