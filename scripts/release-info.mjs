import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const tag = process.env.RELEASE_TAG;
assert.equal(tag, `v${manifest.version}`, "Release tag must match package.json version exactly");
assert.match(tag, /^v\d+\.\d+\.\d+$/, "This workflow publishes stable releases only");
assert.equal(manifest.name, "@arnowei/pi-remote-workspaces");
const changelog = readFileSync("CHANGELOG.md", "utf8");
assert.ok(changelog.split("\n").some(line => line.startsWith(`## ${manifest.version} - `)), "Add this release to CHANGELOG.md first");

const result = spawnSync("npm", ["view", `${manifest.name}@${manifest.version}`, "version", "--json", "--registry=https://registry.npmjs.org/"], { encoding: "utf8", timeout: 30_000 });
let publish;
if (result.status === 0) {
  assert.equal(JSON.parse(result.stdout), manifest.version);
  publish = false;
} else {
  let error;
  try { error = JSON.parse(result.stdout).error; } catch { /* Report the original failure below. */ }
  if (error?.code !== "E404") throw new Error(result.stderr || result.error?.message || result.stdout);
  publish = true;
}
const values = { publish: String(publish), name: manifest.name, version: manifest.version };
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
console.log(JSON.stringify(values));
