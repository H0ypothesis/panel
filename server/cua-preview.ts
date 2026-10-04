import { setTimeout as delay } from "node:timers/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ComputerUseScope } from "../shared/types.ts";
import type {
  ComputerUsePreviewEvent,
  ComputerUsePreviewFrame,
  ComputerUsePreviewState,
} from "../shared/computer-use-preview.ts";
import { streamBrowserPreview } from "./cua-preview-cdp.ts";
import { type PreviewCursorSample } from "./cua-preview-cursor.ts";

export interface CuaPreviewSource {
  scope: ComputerUseScope;
  nativeOverlay?: { pid: number; bundlePath: string };
  url?: string;
  active(): boolean;
  cursor?(signal: AbortSignal): Promise<PreviewCursorSample | undefined>;
  enter(signal: AbortSignal, assertCurrent: () => void): Promise<void>;
  capture(signal: AbortSignal): Promise<ComputerUsePreviewFrame>;
  close(): Promise<void>;
}

export interface CuaPreviewTask {
  active: boolean;
  scope?: ComputerUseScope;
  action?: string;
}

const viewers = new Map<string, number>();

/** Ephemeral frames travel independently of transcript/state persistence. */
export async function serveCuaPreview(
  request: IncomingMessage,
  response: ServerResponse,
  key: string,
  task: () => CuaPreviewTask,
  resolve: (scope: ComputerUseScope) => CuaPreviewSource | undefined,
  native: boolean,
) {
  if ((viewers.get(key) ?? 0) >= 3) {
    response.writeHead(429, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ error: "当前任务已打开多个预览，请先关闭一个。" }),
    );
    return;
  }
  viewers.set(key, (viewers.get(key) ?? 0) + 1);
  const controller = new AbortController();
  const stop = () => controller.abort();
  response.on("close", stop);
  request.on("aborted", stop);
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();
  let lastState = "";
  let sourceKey = "";
  let worker: { controller: AbortController; done: Promise<void> } | undefined;
  let failure: string | undefined;
  const emit = (event: ComputerUsePreviewEvent) => {
    if (controller.signal.aborted || response.destroyed) return;
    // Do not queue obsolete frames behind a slow or suspended renderer.
    if (
      ["frame", "cursor"].includes(event.type) &&
      response.writableLength > 256_000
    )
      return;
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const state = (value: ComputerUsePreviewState) => {
    const serialized = JSON.stringify(value);
    if (serialized === lastState) return;
    lastState = serialized;
    emit(value);
  };
  const retire = async () => {
    worker?.controller.abort();
    await worker?.done;
    worker = undefined;
  };
  let heartbeat = Date.now();
  try {
    while (!controller.signal.aborted) {
      const current = task();
      if (!current.active) {
        state({
          type: "state",
          status: "ended",
          label: "任务已结束，预览已停止。",
        });
        break;
      }
      const source = current.scope ? resolve(current.scope) : undefined;
      const nextKey = source
        ? JSON.stringify([
            source.scope.id,
            source.url,
            source.scope.target,
            source.nativeOverlay,
          ])
        : "";
      if (nextKey !== sourceKey) {
        // Retire the old capture before advertising the new target.
        sourceKey = "";
        await retire();
        failure = undefined;
        sourceKey = nextKey;
        if (source) {
          const capture = new AbortController();
          const signal = AbortSignal.any([capture.signal, controller.signal]);
          const isCurrent = () => {
            const live = task();
            return (
              !signal.aborted &&
              live.active &&
              live.scope?.id === source.scope.id &&
              source.active() &&
              sourceKey === nextKey
            );
          };
          const frames = (async () => {
            try {
              if (native && source.scope.target.kind === "window") {
                if (!signal.aborted)
                  await new Promise<void>((resolve) =>
                    signal.addEventListener("abort", () => resolve(), {
                      once: true,
                    }),
                  );
                return;
              }
              if (source.scope.target.kind === "page") {
                if (!source.url) throw new Error("请先观察当前浏览器页面。");
                await streamBrowserPreview({
                  pid: source.scope.target.pid,
                  url: source.url,
                  scopeId: source.scope.id,
                  active: isCurrent,
                  signal,
                  nativeOverlay:
                    native && source.nativeOverlay
                      ? (state) => {
                          if (isCurrent())
                            emit({
                              type: "overlay",
                              scopeId: source.scope.id,
                              ...state,
                              timestamp: Date.now(),
                            });
                        }
                      : undefined,
                  emit: (frame) => {
                    if (isCurrent()) emit(frame);
                  },
                });
              } else {
                while (isCurrent()) {
                  const frame = await source.capture(signal);
                  if (isCurrent()) emit(frame);
                  await delay(200, undefined, { signal });
                }
              }
            } catch (error) {
              if (isCurrent())
                failure =
                  error instanceof Error
                    ? error.message
                    : "画面采集暂时不可用。";
            }
          })();
          const done = frames.finally(async () => {
            await source.close().catch(() => {});
          });
          worker = { controller: capture, done };
        }
      }
      const kind = source?.scope.target.kind;
      state({
        type: "state",
        status: failure ? "unavailable" : source ? "live" : "waiting",
        source: source
          ? kind === "page"
            ? "cdp"
            : native
              ? "native"
              : "snapshots"
          : undefined,
        scope: source?.scope,
        nativeOverlay: native ? source?.nativeOverlay : undefined,
        label: source?.scope.label ?? "等待模型观察操作目标…",
        action: current.action,
        error: failure,
      });
      // Each resolution creates no capture session; discard unused wrappers.
      if (Date.now() - heartbeat > 15_000) {
        response.write(": keepalive\n\n");
        heartbeat = Date.now();
      }
      await delay(200, undefined, { signal: controller.signal });
    }
  } catch (error) {
    if (!controller.signal.aborted)
      state({
        type: "state",
        status: "unavailable",
        label: "预览连接中断。",
        error: error instanceof Error ? error.message : "请重新打开预览。",
      });
  } finally {
    controller.abort();
    await retire();
    response.off("close", stop);
    request.off("aborted", stop);
    const remaining = (viewers.get(key) ?? 1) - 1;
    if (remaining) viewers.set(key, remaining);
    else viewers.delete(key);
    if (!response.destroyed) response.end();
  }
}
