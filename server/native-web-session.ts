import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PI_WEB_CONFIG,
  piWebEnvironment,
  type PiWebResult,
} from "./pi-web-access.ts";
import {
  validateNativeWebRequest,
  type NativeWebRequest,
} from "./native-web-contract.ts";

export type NativeWebRunner = (
  request: NativeWebRequest,
  signal?: AbortSignal,
) => Promise<PiWebResult>;
export const NATIVE_WEB_CONFIG = {
  ...PI_WEB_CONFIG,
  provider: "exa",
  webSearch: { allowedProviders: ["exa"] },
  toolActivation: "eager",
  fetch: { defaultMode: "readable", allowedModes: ["readable", "raw"] },
};

const sessions = new Set<() => Promise<void>>();

/** Stop all native web workers and wait for cache cleanup on server shutdown. */
export async function closeNativeWebSessions() {
  await Promise.allSettled([...sessions].map((close) => close()));
}

/** Lazy, isolated session. It is started only inside an approved tool invocation. */
export function createNativeWebSession() {
  let child: ChildProcess | undefined;
  let directory: string | undefined;
  let exited: Promise<void> | undefined;
  let closed = false;
  let queue = Promise.resolve();
  let closing: Promise<void> | undefined;
  let initializing: Promise<void> | undefined;
  async function close() {
    closed = true;
    closing ??= (async () => {
      await initializing?.catch(() => {});
      child?.kill("SIGKILL");
      await exited;
      if (directory) await rm(directory, { recursive: true, force: true });
      sessions.delete(close);
    })();
    return closing;
  }
  const run: NativeWebRunner = (request, signal) => {
    request = structuredClone(request);
    const execute = async () => {
      signal?.throwIfAborted();
      validateNativeWebRequest(request);
      if (closed) throw new Error("本轮联网会话已结束；缓存不再可用。");
      if (!child) {
        sessions.add(close);
        initializing = (async () => {
          directory = await mkdtemp(join(tmpdir(), "panel-native-web-"));
          await writeFile(
            join(directory, "web-search.json"),
            JSON.stringify(NATIVE_WEB_CONFIG),
            { mode: 0o600 },
          );
          if (closed || signal?.aborted) {
            await rm(directory, { recursive: true, force: true });
            signal?.throwIfAborted();
            throw new Error("本轮联网会话已结束。");
          }
          const worker = import.meta.url.endsWith(".mjs")
            ? "./native-web-worker.mjs"
            : "./native-web-worker.ts";
          child = fork(new URL(worker, import.meta.url), [], {
            cwd: directory,
            env: piWebEnvironment(directory),
            execArgv: ["--import", import.meta.resolve("tsx")],
            stdio: ["ignore", "ignore", "ignore", "ipc"],
          });
          exited = new Promise((resolve) =>
            child!.once("close", () => {
              closed = true;
              resolve();
            }),
          );
        })();
        try {
          await initializing;
        } catch (error) {
          await close();
          throw error;
        }
      }
      if (closed) throw new Error("本轮联网会话已结束。");
      const worker = child!;
      return new Promise<PiWebResult>((resolve, reject) => {
        const id = randomUUID();
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          worker.off("message", receive);
          worker.off("error", fail);
          worker.off("close", died);
        };
        const fail = (error: Error) => {
          cleanup();
          reject(error);
        };
        const stop = (error: Error) => {
          cleanup();
          void close().then(() => reject(error), reject);
        };
        const died = () =>
          fail(new Error("联网工具进程已退出，本轮缓存已失效。"));
        const abort = () =>
          stop(signal?.reason ?? new Error("联网操作已取消。"));
        const receive = (message: {
          id?: string;
          result?: PiWebResult;
          error?: string;
        }) => {
          if (message.id !== id) return;
          cleanup();
          if (message.error) reject(new Error(message.error));
          else if (
            message.result &&
            typeof message.result.text === "string" &&
            Array.isArray(message.result.sources)
          )
            resolve(message.result);
          else reject(new Error("联网工具返回了无效结果。"));
        };
        const timer = setTimeout(
          () => stop(new Error("联网研究工具超时，本轮缓存已关闭。")),
          180_000,
        );
        worker.on("message", receive);
        worker.once("error", fail);
        worker.once("close", died);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        else
          worker.send({ id, request }, (error) => {
            if (error) fail(error);
          });
      });
    };
    const pending = queue.then(execute);
    queue = pending.then(
      () => {},
      () => {},
    );
    return pending;
  };
  return { run, close };
}
