import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ComputerUseScope } from "../shared/types.ts";
import {
  ownedPreviewSocket,
  activateBrowserPreview,
  selectPreviewPage,
  streamBrowserPreview,
} from "./cua-preview-cdp.ts";
import { serveCuaPreview, type CuaPreviewSource } from "./cua-preview.ts";

const scope: ComputerUseScope = {
  id: "lease-a",
  label: "测试窗口",
  target: { kind: "window", pid: 12, windowId: 34 },
};

test("opaque browser page mapping refuses duplicate URLs, non-page targets and foreign sockets", () => {
  const page = { id: "one", url: "https://preview.test/", type: "page" };
  assert.equal(
    selectPreviewPage(
      [page, { ...page, id: "iframe", type: "iframe" }],
      page.url,
    ),
    page,
  );
  assert.throws(
    () => selectPreviewPage([page, { ...page, id: "two" }], page.url),
    /多个标签页/,
  );
  assert.throws(
    () => selectPreviewPage([page], "https://another.test/"),
    /尚未对应/,
  );
  assert.equal(
    ownedPreviewSocket("ws://127.0.0.1:1234/devtools/page/ONE", 1234),
    "ws://127.0.0.1:1234/devtools/page/ONE",
  );
  for (const url of [
    "ws://evil.test:1234/devtools/page/ONE",
    "ws://127.0.0.1:4321/devtools/page/ONE",
    "ws://user@127.0.0.1:1234/devtools/page/ONE",
    "ws://127.0.0.1:1234/json/list",
    "ws://127.0.0.1:1234/devtools/page/ONE?token=1",
  ])
    assert.throws(() => ownedPreviewSocket(url, 1234));
});

test("CDP preview receives and acknowledges frames without selecting tabs or refreshing DOM refs", async (t) => {
  const { WebSocketServer } = createRequire(import.meta.url)("ws");
  const commands: string[] = [];
  let selected = true;
  let port = 0;
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify([
        {
          id: "ONE",
          url: "https://preview.test/",
          type: "page",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/ONE`,
        },
      ]),
    );
  });
  const sockets = new WebSocketServer({ server });
  sockets.on(
    "connection",
    (socket: {
      on: (event: string, listener: (bytes: Buffer) => void) => void;
      send: (value: string) => void;
    }) => {
      socket.on("message", (bytes) => {
        const message = JSON.parse(bytes.toString());
        commands.push(message.method);
        socket.send(
          JSON.stringify({
            id: message.id,
            result:
              message.method === "Page.getLayoutMetrics"
                ? {
                    cssVisualViewport: { clientWidth: 1000, clientHeight: 500 },
                  }
                : message.method === "Runtime.evaluate"
                  ? { result: { value: selected } }
                  : {},
          }),
        );
        if (message.method === "Page.startScreencast") {
          socket.send(
            JSON.stringify({
              method: "Page.screencastFrame",
              params: { data: "/9j/2Q==", sessionId: 1 },
            }),
          );
        }
      });
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as { port: number }).port;
  t.after(async () => {
    sockets.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const stop = new AbortController();
  const frames: unknown[] = [];
  let viewport: unknown;
  await streamBrowserPreview({
    pid: 42,
    url: "https://preview.test/",
    scopeId: "lease",
    active: () => true,
    signal: stop.signal,
    viewport: (size) => {
      viewport = size;
    },
    ports: async (pid) => {
      assert.equal(pid, 42);
      return [port];
    },
    emit: (frame) => {
      frames.push(frame);
      setTimeout(() => stop.abort(), 20);
    },
  });
  assert.equal(frames.length, 1);
  assert.deepEqual(commands.slice(0, 4), [
    "Page.enable",
    "Page.getLayoutMetrics",
    "Page.startScreencast",
    "Page.screencastFrameAck",
  ]);
  assert.ok(
    commands.every((command) =>
      [
        "Page.enable",
        "Page.getLayoutMetrics",
        "Page.startScreencast",
        "Page.stopScreencast",
        "Page.screencastFrameAck",
      ].includes(command),
    ),
  );
  assert.deepEqual(viewport, { width: 1000, height: 500 });
  const overlayStop = new AbortController();
  const overlayStates: Array<{
    visible: boolean;
    viewport?: { width: number; height: number };
  }> = [];
  await streamBrowserPreview({
    pid: 42,
    url: "https://preview.test/",
    scopeId: "lease",
    active: () => true,
    signal: overlayStop.signal,
    ports: async () => [port],
    emit: () => {},
    nativeOverlay: (state) => {
      overlayStates.push(state);
      if (state.visible) selected = false;
      else overlayStop.abort();
    },
  });
  assert.deepEqual(
    overlayStates.map((s) => s.visible),
    [true, false],
    "switching tabs hides the real overlay even when the page produces no more video frames",
  );
  assert.deepEqual(overlayStates[0].viewport, { width: 1000, height: 500 });
  assert.ok(!commands.includes("Page.bringToFront"));
  const beforeEnter = commands.length;
  const options = {
    pid: 42,
    url: "https://preview.test/",
    scopeId: "lease",
    signal: new AbortController().signal,
    active: () => true,
    ports: async (pid: number) => {
      assert.equal(pid, 42);
      return [port];
    },
  };
  await activateBrowserPreview(options);
  assert.deepEqual(commands.slice(beforeEnter), ["Page.bringToFront"]);
  await assert.rejects(
    activateBrowserPreview({ ...options, active: () => false }),
    /目标已变化/,
  );
  assert.equal(commands.length, beforeEnter + 1);
});

test("native stream sends only the current lease, and stops when the task ends", async (t) => {
  let active = true;
  let captures = 0;
  const server = createServer((request, response) => {
    void serveCuaPreview(
      request,
      response,
      "native-fixture",
      () => ({ active, scope }),
      () => ({
        scope,
        active: () => active,
        nativeOverlay: { pid: 987, bundlePath: "/owned/CuaDriver.app" },
        cursor: async () => {
          throw new Error(
            "native overlay must not poll synthetic cursor state",
          );
        },
        enter: async () => {
          throw new Error("streaming must not enter apps");
        },
        capture: async () => {
          captures++;
          throw new Error("native must not capture through MCP");
        },
        close: async () => {},
      }),
      true,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  );
  const reader = response.body!.getReader();
  let first = new TextDecoder().decode((await reader.read()).value);
  while (!first.includes('"nativeOverlay"'))
    first += new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"source":"native"/);
  assert.match(first, /"windowId":34/);
  assert.match(first, /"id":"lease-a"/);
  assert.match(
    first,
    /"nativeOverlay":\{"pid":987,"bundlePath":"\/owned\/CuaDriver.app"\}/,
  );
  assert.doesNotMatch(first, /"type":"cursor"/);
  active = false;
  let tail = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    tail += new TextDecoder().decode(chunk.value);
  }
  assert.match(tail, /"status":"ended"/);
  assert.equal(captures, 0);
});

test("changing a target discards its in-flight frame and closes its capture session", async (t) => {
  let active = true;
  let current = scope;
  let oldCapture!: () => void;
  let started!: () => void;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let closed = 0;
  const source: CuaPreviewSource = {
    scope,
    active: () => active && current.id === scope.id,
    enter: async () => {
      throw new Error("streaming must not enter apps");
    },
    capture: async () => {
      started();
      await new Promise<void>((resolve) => {
        oldCapture = resolve;
      });
      return {
        type: "frame",
        scopeId: scope.id,
        mimeType: "image/png",
        data: "OLD_FRAME",
        timestamp: 1,
      };
    },
    close: async () => {
      closed++;
    },
  };
  const server = createServer((request, response) => {
    void serveCuaPreview(
      request,
      response,
      "switch-fixture",
      () => ({ active, scope: current }),
      (value) => (value.id === scope.id ? source : undefined),
      false,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  );
  await began;
  current = { ...scope, id: "lease-b" };
  oldCapture();
  await delay(240);
  active = false;
  const text = await response.text();
  assert.doesNotMatch(text, /OLD_FRAME/);
  assert.equal(closed, 1);
  assert.match(text, /"status":"waiting"/);
});
