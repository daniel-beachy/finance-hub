import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "@finance-hub/core";
import type { AppContext } from "./context.ts";

export const DEFAULT_PORT = 5202;
const DEV_WEB_PORT = 5201;

export function buildServerApp(ctx: AppContext, port: number) {
  const allowedOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  // The Vite dev server proxies /api here and keeps its own Origin header.
  if (process.env.FH_DEV === "1") {
    allowedOrigins.push(`http://127.0.0.1:${DEV_WEB_PORT}`, `http://localhost:${DEV_WEB_PORT}`);
  }
  const app = createApp(ctx.deps, { allowedOrigins, mode: "local" });
  const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
  if (existsSync(dist)) {
    app.use("*", serveStatic({ root: dist }));
    app.get("*", serveStatic({ path: join(dist, "index.html") }));
  } else {
    app.get("/", (c) => c.text("The dashboard is not built yet. Run: npm run build", 503));
  }
  return app;
}

export function startServer(ctx: AppContext, port = DEFAULT_PORT): Promise<{ close(): void }> {
  const app = buildServerApp(ctx, port);
  return new Promise((resolve, reject) => {
    // Loopback only: this API has no login and must never be reachable
    // from another machine.
    const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () =>
      resolve({ close: () => server.close() }),
    );
    server.on("error", reject);
  });
}
