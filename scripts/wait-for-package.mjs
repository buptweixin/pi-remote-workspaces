import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const name = process.env.PACKAGE_NAME || manifest.name;
const version = process.env.PACKAGE_VERSION || manifest.version;
const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}/${encodeURIComponent(version)}`;
let expectedIntegrity;
if (process.env.PACKAGE_ARCHIVE_DIR) {
  const files = (await readdir(process.env.PACKAGE_ARCHIVE_DIR)).filter(file => file.endsWith(".tgz"));
  assert.equal(files.length, 1, "Expected exactly one verified package archive");
  const archive = await readFile(join(process.env.PACKAGE_ARCHIVE_DIR, files[0]));
  expectedIntegrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
}

const deadline = Date.now() + 10 * 60_000;
let lastStatus = "not checked";
while (Date.now() < deadline) {
  const response = await fetch(url, { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
  if (response?.ok) {
    const published = await response.json();
    assert.equal(published.name, name);
    assert.equal(published.version, version);
    assert.ok(published.dist?.integrity);
    if (expectedIntegrity) assert.equal(published.dist.integrity, expectedIntegrity, "Public npm archive differs from the verified release archive");
    console.log(JSON.stringify({ name, version, integrity: published.dist.integrity, archiveVerified: Boolean(expectedIntegrity) }));
    process.exit(0);
  }
  lastStatus = response?.status ?? "network error";
  if (response && ![404, 429].includes(response.status) && response.status < 500) throw new Error(`npm registry returned HTTP ${response.status}`);
  console.log(`Waiting for ${name}@${version} to become public (${lastStatus})`);
  await new Promise(resolve => setTimeout(resolve, 10_000));
}
throw new Error(`npm publication is still not visible after ten minutes (${lastStatus})`);
