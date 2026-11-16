import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { RemoteClient, type Runner } from "../src/remote.js";
import { defaults, type Workspace } from "../src/config.js";
import { runProcess } from "../src/process.js";

export async function temporary(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "pi-remote-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
/** Executes the actual remote protocol through a shell, without contacting user hosts. */
export const localTransport: Runner = async (program, args, options) => {
  if (program !== "ssh") throw new Error("Expected SSH transport");
  return runProcess("/bin/sh", ["-c", args.at(-1)!], options);
};
export const workspace = (path: string): Workspace => ({ id: "test", name: "Test workspace", host: "fixture", path });
export const clientFor = (path: string) => new RemoteClient(workspace(path), defaults(), localTransport);
