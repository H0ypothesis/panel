import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { loadEnvFile } from "node:process";
import { createServer as createViteServer } from "vite";
import { createApi } from "./api.ts";
import { PiRuntime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const port = Number(process.env.PORT ?? 4317);
const store = new Store(resolve(process.env.PANEL_DATA_DIR ?? ".panel"));
await store.init();
const runtime = new PiRuntime();
const scheduler = new Scheduler(store, runtime);
const api = createApi(store, runtime, scheduler);
const vite =
  process.env.NODE_ENV === "production"
    ? undefined
    : await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const server = createServer(async (request, response) => {
  try {
    if (await api(request, response)) return;
    if (vite) {
      vite.middlewares(request, response);
      return;
    }
    const root = resolve("dist");
    const pathname = decodeURIComponent(
      new URL(request.url ?? "/", "http://localhost").pathname,
    );
    const file = resolve(
      root,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    if (!file.startsWith(`${root}${sep}`)) {
      response.writeHead(403);
      response.end();
      return;
    }
    let content: Buffer;
    let contentType = types[extname(file)] ?? "application/octet-stream";
    try {
      content = await readFile(file);
    } catch {
      if (extname(file)) {
        response.writeHead(404);
        response.end();
        return;
      }
      content = await readFile(resolve(root, "index.html"));
      contentType = "text/html";
    }
    response.writeHead(200, { "Content-Type": contentType });
    response.end(content);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Server error");
    if (!response.headersSent) response.writeHead(500);
    response.end("服务暂时不可用");
  }
});
let savedRevision = store.data.revision;
const persistence = setInterval(() => {
  if (savedRevision === store.data.revision) return;
  const revision = store.data.revision;
  void store
    .save()
    .then(() => {
      savedRevision = revision;
    })
    .catch(() => {});
}, 1000);
server.listen(port, "127.0.0.1", () =>
  console.log(`Panel ready at http://127.0.0.1:${port}`),
);
const shutdown = async () => {
  scheduler.shutdown();
  clearInterval(persistence);
  await store.save().catch(() => {});
  await vite?.close();
  server.closeAllConnections();
  server.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
