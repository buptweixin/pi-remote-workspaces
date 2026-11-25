import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function extractReleaseNotes(changelog, version) {
  const lines = changelog.replace(/\r\n/g, "\n").split("\n");
  const startIdx = lines.findIndex(line => line.startsWith(`## ${version} - `));
  assert.ok(startIdx >= 0, `Add ## ${version} - YYYY-MM-DD to CHANGELOG.md first`);
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      endIdx = i;
      break;
    }
  }
  const body = lines.slice(startIdx + 1, endIdx).join("\n").trim();
  assert.ok(body.length > 0, `CHANGELOG.md section for ${version} must not be empty`);
  return `## ${lines[startIdx].slice(3).trim()}\n\n${body}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const tag = process.env.RELEASE_TAG;
  assert.equal(tag, `v${manifest.version}`, "Release tag must match package.json version exactly");
  assert.match(tag, /^v\d+\.\d+\.\d+$/, "This workflow publishes stable releases only");
  assert.equal(manifest.name, "@arnowei/pi-remote-workspaces");
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const notes = extractReleaseNotes(changelog, manifest.version);
  if (process.env.RELEASE_NOTES_FILE) {
    writeFileSync(process.env.RELEASE_NOTES_FILE, notes, "utf8");
  }

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
}
