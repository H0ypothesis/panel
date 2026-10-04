import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { TurnNode } from "../shared/types";
import { ComputerUsePreview } from "./ComputerUsePreview";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const node: TurnNode = {
  id: "node",
  revision: 3,
  parentId: "root",
  prompt: "查看窗口",
  response: "",
  status: "running",
  config: { model: "test", thinking: "off" },
  color: "sage",
  position: { x: 0, y: 0 },
  contextIds: [],
  createdAt: 1,
  toolRequests: ["computer_use"],
};

function fixture(t: TestContext, native = false) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://127.0.0.1:4317",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const connections: FakeEvents[] = [];
  class FakeEvents {
    closed = false;
    onerror?: () => void;
    listeners = new Map<string, (event: unknown) => void>();
    constructor(readonly url: string) {
      connections.push(this);
    }
    addEventListener(name: string, listener: (event: unknown) => void) {
      this.listeners.set(name, listener);
    }
    emit(name: string, data: unknown) {
      this.listeners.get(name)?.({ data: JSON.stringify(data) });
    }
    close() {
      this.closed = true;
    }
  }
  const opened: unknown[] = [];
  let closes = 0;
  let stops = 0;
  const entered: Array<{ path: string; body: unknown }> = [];
  if (native)
    window.panelDesktop = {
      platform: "macos",
      setComputerUsePreview: async (task: unknown) => {
        opened.push(task);
      },
      closeComputerUsePreview: async () => {
        closes++;
      },
    };
  const globals = {
    window,
    document: window.document,
    localStorage: window.localStorage,
    EventSource: FakeEvents,
    fetch: async (path: string, options: RequestInit) => {
      entered.push({ path, body: JSON.parse(options.body as string) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const root = createRoot(window.document.getElementById("root")!);
  t.after(async () => {
    await act(() => root.unmount());
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const render = async (current = node) => {
    await act(() =>
      root.render(
        <ComputerUsePreview
          workspaceId="workspace"
          node={current}
          online
          onStop={async () => {
            stops++;
          }}
        />,
      ),
    );
  };
  return {
    window,
    connections,
    render,
    opened,
    entered,
    get stops() {
      return stops;
    },
    get closes() {
      return closes;
    },
  };
}

test("browser preview follows task revisions, drops foreign frames and clears the picture on target changes", async (t) => {
  const f = fixture(t);
  await f.render();
  const events = f.connections[0];
  assert.match(
    events.url,
    /workspace\/nodes\/node\/computer-use\/preview\?revision=3/,
  );
  await act(() =>
    events.emit("state", {
      type: "state",
      status: "live",
      scope: { id: "one" },
      label: "窗口一",
    }),
  );
  await act(() =>
    events.emit("frame", {
      type: "frame",
      scopeId: "foreign",
      mimeType: "image/png",
      data: "foreign",
      timestamp: Date.now(),
    }),
  );
  assert.equal(
    f.window.document.querySelector(".computer-preview-picture img"),
    null,
  );
  await act(() =>
    events.emit("frame", {
      type: "frame",
      scopeId: "one",
      mimeType: "image/png",
      data: "aW1hZ2U=",
      timestamp: Date.now(),
    }),
  );
  assert.ok(f.window.document.querySelector(".computer-preview-picture img"));
  await act(() =>
    events.emit("state", {
      type: "state",
      status: "live",
      scope: { id: "two" },
      label: "窗口二",
    }),
  );
  assert.equal(
    f.window.document.querySelector(".computer-preview-picture img"),
    null,
  );
  await f.render({ ...node, id: "second", revision: 4 });
  assert.equal(events.closed, true);
  await act(() =>
    events.emit("state", {
      type: "state",
      status: "live",
      scope: { id: "old" },
      label: "旧窗口不得复活",
    }),
  );
  assert.ok(!f.window.document.body.textContent.includes("旧窗口不得复活"));
  assert.match(
    f.connections[1].url,
    /nodes\/second\/computer-use\/preview\?revision=4/,
  );
  await f.render({ ...node, status: "completed" });
  assert.equal(f.connections[1].closed, true);
  assert.equal(
    f.window.document.querySelector(".computer-preview-window"),
    null,
  );
});

test("compact controls enter the controlled target, reconnect and close without stopping; sizing keeps the video ratio", async (t) => {
  const f = fixture(t);
  f.window.focus = () => {
    throw new Error("enter must not focus Panel");
  };
  await f.render();
  const picture = f.window.document.querySelector(
    ".computer-preview-window",
  ) as HTMLElement;
  assert.equal(picture.style.width, "280px");
  assert.equal(picture.style.height, "175px");
  assert.equal(picture.querySelector("header,footer"), null);
  const click = async (label: string) =>
    act(() =>
      (picture.querySelector(`[aria-label="${label}"]`) as HTMLElement).click(),
    );
  const before = f.connections[0];
  await click("刷新画面");
  assert.equal(before.closed, true);
  assert.equal(f.connections.length, 2);
  assert.equal(f.stops, 0);
  await click("进入被控制的应用");
  assert.equal(f.entered.length, 0, "waiting has no target to enter");
  await act(() =>
    f.connections[1].emit("state", {
      type: "state",
      status: "live",
      source: "snapshots",
      label: "被控制应用",
      scope: {
        id: "target-lease",
        label: "被控制应用",
        target: { kind: "window", pid: 100, windowId: 42 },
      },
    }),
  );
  await click("进入被控制的应用");
  assert.deepEqual(f.entered, [
    {
      path: "/api/workspaces/workspace/nodes/node/computer-use/preview/enter",
      body: { expectedRevision: 3, scopeId: "target-lease" },
    },
  ]);
  const handle = picture.querySelector('[aria-label="调节画中画大小"]')!;
  await act(() =>
    handle.dispatchEvent(
      new f.window.KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
      }),
    ),
  );
  assert.equal(picture.style.width, "300px");
  assert.equal(picture.style.height, "187.5px");
  await click("中止任务");
  assert.equal(f.stops, 1);
  await click("关闭画中画");
  assert.equal(f.connections[1].closed, true);
  assert.equal(f.stops, 1, "closing only stops the preview subscription");
  assert.equal(
    f.window.document.querySelector(".computer-preview-window"),
    null,
  );
});

test("legacy cursor events never render a synthetic pointer over captured pixels", async (t) => {
  const f = fixture(t);
  await f.render();
  const events = f.connections[0];
  const scope = {
    id: "a",
    label: "应用",
    target: { kind: "window", pid: 1, windowId: 2 },
  };
  await act(() =>
    events.emit("state", {
      type: "state",
      status: "live",
      source: "snapshots",
      label: "应用",
      scope,
    }),
  );
  await act(() =>
    events.emit("frame", {
      type: "frame",
      scopeId: "a",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
      timestamp: Date.now(),
    }),
  );
  const image = f.window.document.querySelector(
    ".computer-preview-picture img",
  )!;
  Object.defineProperty(image, "naturalWidth", { value: 1000 });
  Object.defineProperty(image, "naturalHeight", { value: 500 });
  await act(() => image.dispatchEvent(new f.window.Event("load")));
  const cursor = {
    type: "cursor",
    scopeId: "a",
    id: "click",
    visible: true,
    x: 0.25,
    y: 0.5,
    action: "click",
    pressed: true,
    durationMs: 180,
    reducedMotion: false,
    timestamp: Date.now(),
  };
  await act(() => events.emit("cursor", { ...cursor, scopeId: "foreign" }));
  assert.equal(
    f.window.document.querySelector(".computer-preview-cursor"),
    null,
  );
  await act(() => events.emit("cursor", cursor));
  assert.equal(
    f.window.document.querySelector(".computer-preview-cursor-surface"),
    null,
  );
  assert.equal(
    f.window.document.querySelector(".computer-preview-cursor"),
    null,
  );
  await act(() =>
    events.emit("state", {
      type: "state",
      status: "live",
      label: "另一个窗口",
      scope: { ...scope, id: "b" },
    }),
  );
  assert.equal(
    f.window.document.querySelector(".computer-preview-cursor"),
    null,
  );
  await act(() => events.onerror?.());
  assert.equal(
    f.window.document.querySelector(".computer-preview-cursor"),
    null,
  );
});

test("native preview passes task identifiers only and respects a user closing the floating panel", async (t) => {
  const f = fixture(t, true);
  await f.render();
  assert.deepEqual(f.opened, [
    { workspaceId: "workspace", nodeId: "node", revision: 3 },
  ]);
  assert.equal(
    f.connections.length,
    0,
    "the native panel owns its stream when the main window is in the background",
  );
  await f.render({ ...node, id: "second" });
  assert.equal(f.closes, 1);
  await act(() =>
    f.window.dispatchEvent(new f.window.CustomEvent("panel:preview-closed")),
  );
  assert.equal(f.closes, 2);
  await f.render({ ...node, id: "third" });
  assert.equal(
    f.opened.length,
    2,
    "closing must not immediately reopen the panel on the next update",
  );
});
