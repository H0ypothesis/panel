import { createServer, request, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface SubagentBridgeAddress {
  socketPath: string;
  token: string;
}
export type BridgeHandler = (
  method: string,
  params: unknown,
  signal: AbortSignal,
  emit: (value: unknown) => void,
) => Promise<unknown>;

/** Private, authenticated process bridge. Model credentials stay in the host. */
export async function serveSubagentBridge(
  socketPath: string,
  handle: BridgeHandler,
) {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const address = { socketPath, token: randomBytes(32).toString("hex") };
  const active = new Set<AbortController>();
  const server: Server = createServer(async (req, res) => {
    if (
      req.method !== "POST" ||
      req.headers.authorization !== `Bearer ${address.token}`
    ) {
      res.writeHead(403).end();
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    res.on("close", () => controller.abort());
    const send = (value: unknown) => {
      if (!res.destroyed) res.write(JSON.stringify(value) + "\n");
    };
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) throw new Error("子代理进程消息过大。");
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof input.method !== "string")
        throw new Error("无效的子代理进程请求。");
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const value = await handle(
        input.method,
        input.params,
        controller.signal,
        (value) => send({ event: value }),
      );
      send({ result: value ?? null });
    } catch (error) {
      send({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      active.delete(controller);
      res.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);
  return {
    address,
    async close() {
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketPath, { force: true });
    },
  };
}

export function callSubagentBridge<T = unknown>(
  address: SubagentBridgeAddress,
  method: string,
  params: unknown,
  signal?: AbortSignal,
  onEvent?: (event: unknown) => void | Promise<void>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: address.socketPath,
        path: "/",
        method: "POST",
        headers: {
          Authorization: `Bearer ${address.token}`,
          "Content-Type": "application/json",
        },
        signal,
      },
      async (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`子代理宿主连接失败（${res.statusCode}）。`));
          return;
        }
        let pending = "";
        let completed = false;
        res.setEncoding("utf8");
        try {
          for await (const chunk of res) {
            pending += chunk;
            let end: number;
            while ((end = pending.indexOf("\n")) >= 0) {
              const message = JSON.parse(pending.slice(0, end));
              pending = pending.slice(end + 1);
              if ("error" in message) throw new Error(message.error);
              if ("event" in message) await onEvent?.(message.event);
              if ("result" in message) {
                completed = true;
                resolve(message.result);
              }
            }
          }
          if (!completed) throw new Error("子代理宿主连接中断。");
        } catch (error) {
          reject(error);
        }
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ method, params }));
  });
}
