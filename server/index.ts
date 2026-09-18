import { createServer } from "node:http";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { loadEnvFile } from "node:process";
import { createApi } from "./api.ts";
import { PiRuntime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import { waitForPiWebShutdown } from "./pi-web-access.ts";

try {
  loadEnvFile(process.env.PANEL_ENV_FILE);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const readyFile = process.env.PANEL_DESKTOP_READY_FILE;
let port = Number(process.env.PORT ?? 4317);
// Reuse the desktop origin so WebKit keeps local preferences between launches.
// If another application takes the port, listen on a fresh OS-assigned port.
if (readyFile && port === 0) {
  try {
    const previous = Number(await readFile(`${readyFile}.port`, "utf8"));
    if (Number.isInteger(previous) && previous > 1023 && previous <= 65535)
      port = previous;
  } catch {
    // First launch has no saved port.
  }
}
const store = new Store(resolve(process.env.PANEL_DATA_DIR ?? ".panel"));
await store.init();
const runtime = new PiRuntime();
const scheduler = new Scheduler(store, runtime);
const api = createApi(store, runtime, scheduler);
const vite =
  process.env.NODE_ENV === "production"
    ? undefined
    : await (
        await import("vite")
      ).createServer({
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
server.on("error", (error: NodeJS.ErrnoException) => {
  if (readyFile && port !== 0 && error.code === "EADDRINUSE") {
    port = 0;
    server.listen(0, "127.0.0.1");
  } else {
    console.error(error);
    void shutdown();
  }
});
server.listen(port, "127.0.0.1", async () => {
  const address = server.address();
  if (!address || typeof address === "string") return;
  const url = `http://127.0.0.1:${address.port}`;
  console.log(`Panel ready at ${url}`);
  if (readyFile) {
    try {
      const temporary = `${readyFile}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify({ url, pid: process.pid }), {
        mode: 0o600,
      });
      await rename(temporary, readyFile);
      await writeFile(`${readyFile}.port`, String(address.port), {
        mode: 0o600,
      });
    } catch (error) {
      console.error("无法通知桌面客户端服务就绪。", error);
      await shutdown();
    }
  }
});
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  scheduler.shutdown();
  clearInterval(persistence);
  if (parentWatch) clearInterval(parentWatch);
  await waitForPiWebShutdown();
  await store.save().catch(() => {});
  await vite?.close();
  server.closeAllConnections();
  server.close();
  if (readyFile) {
    try {
      const ready = JSON.parse(await readFile(readyFile, "utf8"));
      if (ready.pid === process.pid) await rm(readyFile, { force: true });
    } catch {
      // A ready file is disposable; never remove a different process's file.
    }
  }
  process.exit(0);
};
// A desktop crash must not leave a hidden model/tool server running indefinitely.
const desktopParent = Number(process.env.PANEL_DESKTOP_PARENT_PID);
const parentWatch =
  Number.isSafeInteger(desktopParent) && desktopParent > 1
    ? setInterval(() => {
        if (process.ppid !== desktopParent) void shutdown();
      }, 1000)
    : undefined;
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
