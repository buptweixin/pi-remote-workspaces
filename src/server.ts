import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DashboardController, type ControllerOptions } from "./dashboard-api.js";

export interface Dashboard { url: string; close(): Promise<void> }
export interface DashboardOptions extends ControllerOptions { port?: number }

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 12 * 1024 * 1024) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

function send(res: ServerResponse, code: number, value: unknown) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

export async function startDashboard(options: DashboardOptions = {}): Promise<Dashboard> {
  const controller = new DashboardController(options);
  const token = randomBytes(32).toString("hex");
  const requestControllers = new Set<AbortController>();
  const server = createServer((req, res) => { void handle(req, res); });
  let origin = "";

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    // Prevent DNS rebinding and browser requests from other origins.
    const requestOrigin = `http://${req.headers.host}`;
    if (!/^127\.0\.0\.1(?::\d{1,5})?$/.test(req.headers.host ?? "") || (req.headers.origin && req.headers.origin !== requestOrigin)) {
      send(res, 403, { error: "Invalid request origin" });
      return;
    }
    const url = new URL(req.url ?? "/", origin);
    const assets: Record<string, [string, string]> = {
      "/": ["index.html", "text/html"],
      "/index.html": ["index.html", "text/html"],
      "/workbench-core.js": ["workbench-core.js", "text/javascript"],
      "/app.js": ["app.js", "text/javascript"],
      "/style.css": ["style.css", "text/css"],
      "/favicon.svg": ["favicon.svg", "image/svg+xml"],
    };
    const asset = assets[url.pathname];
    if (asset && req.method === "GET") {
      for (const dir of ["../public", "../views"]) {
        try {
          const bytes = await readFile(new URL(`${dir}/${asset[0]}`, import.meta.url));
          res.writeHead(200, { "Content-Type": `${asset[1]}; charset=utf-8` });
          res.end(bytes);
          return;
        } catch { /* Try next asset directory. */ }
      }
      res.writeHead(404);
      res.end();
      return;
    }
    const supplied = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    const expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      send(res, 401, { error: "Open the full dashboard URL including its access token" });
      return;
    }
    const reqAbort = new AbortController();
    requestControllers.add(reqAbort);
    res.on("close", () => { if (!res.writableEnded) reqAbort.abort(); });
    try {
      const input = req.method === "GET" || req.method === "DELETE" ? {} : await body(req);
      const outcome = await controller.dispatch(url.pathname, req.method ?? "GET", input, reqAbort.signal);
      send(res, outcome.status, outcome.body);
    } catch (error) {
      if (!res.destroyed) send(res, 400, { error: (error as Error).message });
    } finally {
      requestControllers.delete(reqAbort);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot determine dashboard port");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/#token=${token}`,
    async close() {
      for (const reqAbort of requestControllers) reqAbort.abort();
      server.closeAllConnections();
      await Promise.allSettled([
        controller.close(),
        new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
      ]);
    },
  };
}
