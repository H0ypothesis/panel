import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ComputerUsePreviewFrame } from "../shared/computer-use-preview.ts";

const execFileAsync = promisify(execFile);
const MAX_FRAME = 2 * 1024 * 1024;

interface CdpPage {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** Opaque Driver tab ids cannot be used as CDP ids. Refuse ambiguous matches. */
export function selectPreviewPage(pages: CdpPage[], observedUrl: string) {
  const matches = pages.filter(
    (page) => page.type === "page" && page.url === observedUrl,
  );
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "多个标签页使用相同网址，无法证明预览对应当前页面。请使用独立浏览器窗口或关闭重复页面。"
        : "当前页面尚未对应到浏览器画面源，请让模型重新观察页面。",
    );
  return matches[0];
}

export function ownedPreviewSocket(value: string, port: number) {
  const url = new URL(value);
  if (
    url.protocol !== "ws:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    Number(url.port) !== port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/devtools\/page\/[A-Za-z0-9_-]+$/.test(url.pathname)
  )
    throw new Error("浏览器预览端点不属于当前进程的本机页面。");
  return url.href;
}

/** Inspect only listeners owned by the already-observed browser PID. No port scan. */
async function browserPorts(
  pid: number,
  signal: AbortSignal,
): Promise<number[]> {
  const { stdout } = await execFileAsync(
    "lsof",
    ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
    { signal, timeout: 3000, maxBuffer: 64 * 1024 },
  );
  return [
    ...new Set(
      stdout.split("\n").flatMap((line) => {
        const match = line.match(/^n(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)$/);
        const port = Number(match?.[1]);
        return port > 0 && port <= 65535 ? [port] : [];
      }),
    ),
  ];
}

export interface BrowserPreviewOptions {
  pid: number;
  url: string;
  scopeId: string;
  active: () => boolean;
  signal: AbortSignal;
  emit: (frame: ComputerUsePreviewFrame) => void;
  viewport?: (size: { width: number; height: number }) => void;
  nativeOverlay?: (state: {
    visible: boolean;
    viewport?: { width: number; height: number };
  }) => void;
  /** Test seam; production proves endpoint ownership through the OS socket table. */
  ports?: (pid: number, signal: AbortSignal) => Promise<number[]>;
}

async function previewPageSocket(options: Omit<BrowserPreviewOptions, "emit">) {
  const { signal } = options;
  signal.throwIfAborted();
  const ports = await (options.ports ?? browserPorts)(
    options.pid,
    signal,
  ).catch((error) => {
    if (signal.aborted) throw error;
    throw new Error(
      "当前浏览器没有可用的本机画面端点，请使用支持 CDP 的独立浏览器实例。",
      { cause: error },
    );
  });
  const pages: Array<CdpPage & { port: number }> = [];
  for (const port of ports) {
    if (!options.active()) throw new Error("操作目标已变化，请刷新预览。");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
        redirect: "error",
      });
      const text = await response.text();
      if (!response.ok || text.length > 256_000) continue;
      const list: unknown = JSON.parse(text);
      if (!Array.isArray(list)) continue;
      for (const page of list) {
        if (
          page &&
          typeof page.id === "string" &&
          typeof page.url === "string" &&
          typeof page.type === "string" &&
          typeof page.webSocketDebuggerUrl === "string"
        ) {
          pages.push({ ...page, port });
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  const page = selectPreviewPage(pages, options.url) as CdpPage & {
    port: number;
  };
  const address = ownedPreviewSocket(page.webSocketDebuggerUrl!, page.port);
  if (!options.active()) throw new Error("操作目标已变化，请刷新预览。");
  return address;
}

export async function streamBrowserPreview(options: BrowserPreviewOptions) {
  await runScreencast(await previewPageSocket(options), options);
}

/** Only an explicit human click may select the page; streaming never does. */
export async function activateBrowserPreview(
  options: Omit<BrowserPreviewOptions, "emit">,
) {
  const address = await previewPageSocket(options);
  options.signal.throwIfAborted();
  if (!options.active()) throw new Error("操作目标已变化，请刷新预览。");
  const socket = new WebSocket(address);
  try {
    await new Promise<void>((resolve, reject) => {
      let sent = false;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(new Error("进入应用已取消。"));
      const timer = setTimeout(
        () => finish(new Error("进入浏览器页面超时。")),
        3000,
      );
      options.signal.addEventListener("abort", abort, { once: true });
      socket.addEventListener("open", () => {
        if (options.signal.aborted || !options.active()) {
          finish(new Error("操作目标已变化，请刷新预览。"));
          return;
        }
        sent = true;
        socket.send(
          JSON.stringify({ id: 1, method: "Page.bringToFront", params: {} }),
        );
      });
      socket.addEventListener("message", (event) => {
        if (
          !sent ||
          typeof event.data !== "string" ||
          event.data.length > 64_000
        )
          return;
        try {
          const message = JSON.parse(event.data);
          if (message.id === 1)
            finish(
              message.error ? new Error("浏览器无法进入当前页面。") : undefined,
            );
        } catch {
          /* Ignore unrelated browser events. */
        }
      });
      socket.addEventListener("error", () =>
        finish(new Error("无法连接当前浏览器页面。")),
      );
      socket.addEventListener("close", () =>
        finish(new Error("浏览器页面连接已关闭。")),
      );
      if (options.signal.aborted) abort();
    });
  } finally {
    socket.close();
  }
}

async function runScreencast(address: string, options: BrowserPreviewOptions) {
  const socket = new WebSocket(address);
  const pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let nextId = 0;
  let ended = false;
  let lastFrame = 0;
  let lastMetrics = 0;
  let readingMetrics = false;
  let overlayTimer: ReturnType<typeof setInterval> | undefined;
  const command = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN)
        return reject(new Error("浏览器画面连接已断开。"));
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("浏览器画面源响应超时。"));
      }, 3000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const abort = () => socket.close();
  const readMetrics = async () => {
    if (
      (!options.viewport && !options.nativeOverlay) ||
      readingMetrics ||
      socket.readyState !== WebSocket.OPEN
    )
      return;
    readingMetrics = true;
    lastMetrics = Date.now();
    try {
      const [metrics, visibility] = await Promise.all([
        command("Page.getLayoutMetrics"),
        options.nativeOverlay
          ? command("Runtime.evaluate", {
              expression: "document.visibilityState === 'visible'",
              returnByValue: true,
              throwOnSideEffect: true,
            })
          : Promise.resolve(undefined),
      ]);
      const viewport = (metrics.cssVisualViewport ??
        metrics.cssLayoutViewport) as Record<string, unknown> | undefined;
      const width = viewport?.clientWidth,
        height = viewport?.clientHeight;
      if (
        typeof width === "number" &&
        typeof height === "number" &&
        Number.isFinite(width) &&
        Number.isFinite(height) &&
        width > 0 &&
        height > 0 &&
        !options.signal.aborted &&
        options.active()
      ) {
        options.viewport?.({ width, height });
        const result = visibility?.result as { value?: unknown } | undefined;
        options.nativeOverlay?.({
          visible: result?.value === true,
          viewport: { width, height },
        });
      } else options.nativeOverlay?.({ visible: false });
    } catch {
      options.nativeOverlay?.({ visible: false });
    } finally {
      readingMetrics = false;
    }
  };
  const closed = new Promise<void>((resolve, reject) => {
    socket.addEventListener("close", () => {
      ended = true;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error("浏览器画面连接已关闭。"));
      }
      pending.clear();
      if (options.signal.aborted || !options.active()) resolve();
      else reject(new Error("浏览器页面已关闭或画面连接中断。"));
    });
    socket.addEventListener("error", () =>
      reject(new Error("无法连接当前浏览器的画面源。")),
    );
  });
  // Install a rejection handler while connecting and starting the screencast.
  void closed.catch(() => {});
  options.signal.addEventListener("abort", abort, { once: true });
  socket.addEventListener("message", (event) => {
    if (
      typeof event.data !== "string" ||
      event.data.length > MAX_FRAME + 64_000
    )
      return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    const request = pending.get(message.id);
    if (request) {
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error)
        request.reject(new Error("浏览器拒绝了画面采集请求。"));
      else request.resolve(message.result ?? {});
    }
    if (message.method !== "Page.screencastFrame") return;
    if (Date.now() - lastMetrics > 1000) void readMetrics();
    const { data, sessionId } = message.params ?? {};
    if (Number.isSafeInteger(sessionId) && socket.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          id: ++nextId,
          method: "Page.screencastFrameAck",
          params: { sessionId },
        }),
      );
    if (options.signal.aborted || !options.active()) return;
    const timestamp = Date.now();
    if (
      timestamp - lastFrame >= 67 &&
      typeof data === "string" &&
      data.startsWith("/9j/") &&
      data.length <= MAX_FRAME &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(data)
    ) {
      lastFrame = timestamp;
      options.emit({
        type: "frame",
        scopeId: options.scopeId,
        mimeType: "image/jpeg",
        data,
        timestamp,
      });
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("浏览器画面连接超时。")),
        3000,
      );
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("浏览器画面连接失败。"));
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          reject(new Error("浏览器画面连接已关闭。"));
        },
        { once: true },
      );
    });
    if (options.signal.aborted || !options.active()) return;
    // Commands are fixed by the host. This connection never receives model input.
    await command("Page.enable");
    await readMetrics();
    if (options.nativeOverlay)
      overlayTimer = setInterval(() => void readMetrics(), 300);
    await command("Page.startScreencast", {
      format: "jpeg",
      quality: 65,
      maxWidth: 1280,
      maxHeight: 960,
      everyNthFrame: 2,
    });
    await closed;
  } finally {
    clearInterval(overlayTimer);
    options.signal.removeEventListener("abort", abort);
    if (!ended && socket.readyState === WebSocket.OPEN) {
      await command("Page.stopScreencast").catch(() => {});
    }
    socket.close();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("预览已停止。"));
    }
    pending.clear();
  }
}
