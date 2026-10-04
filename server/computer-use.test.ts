import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ComputerUse,
  computerResult,
  type ComputerDriver,
  type ComputerSession,
  type ComputerUseRun,
} from "./computer-use.ts";

type Result = Awaited<ReturnType<ComputerSession["callTool"]>>;
type Invocation = {
  transportId: string;
  name: string;
  args: Record<string, unknown>;
};
type Parameters = {
  tool: string;
  target?: {
    kind: "window" | "page";
    pid: number;
    windowId: number;
    tabId?: string;
  };
  arguments?: Record<string, unknown>;
};

const windowTarget = (windowId = 1): Parameters["target"] => ({
  kind: "window",
  pid: 100,
  windowId,
});
const pageTarget = (tabId: string, windowId = 1): Parameters["target"] => ({
  kind: "page",
  pid: 100,
  windowId,
  tabId,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function pending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "request should still be waiting");
}

const nativeNames = [
  "get_window_state",
  "verify_state",
  "click",
  "type_text",
  "hotkey",
  "press_key",
  "bring_to_front",
  "set_window_frame",
];
const browserNames = [
  "get_browser_state",
  "browser_click",
  "browser_type",
  "browser_navigate",
  "browser_pointer",
];
const discoveryNames = [
  "list_apps",
  "list_windows",
  "launch_app",
  "browser_prepare",
  "check_permissions",
];
function schema(name: string): Tool {
  return {
    name,
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string" },
        pid: { type: "integer", minimum: 1 },
        window_id: { type: "integer", minimum: 1 },
        target_id: { type: "string" },
        tab_id: { type: "string" },
        delivery_mode: { type: "string", enum: ["background", "foreground"] },
        x: { type: "number" },
        y: { type: "number" },
        text: { type: "string" },
        url: { type: "string" },
        element_id: { type: "string" },
        app: { type: "string" },
        prompt: { type: "boolean" },
        creates_new_application_instance: { type: "boolean" },
        allow_launch: { type: "boolean" },
        strategy: { type: "object" },
        profile: { type: "object" },
        keys: { type: "array", items: { type: "string" } },
        modifiers: { type: "array", items: { type: "string" } },
        key: { type: "string" },
        include_screenshot: { type: "boolean" },
      },
      required: nativeNames.includes(name)
        ? ["session", "pid", "window_id"]
        : ["session"],
      additionalProperties: false,
    },
  };
}

class FakeDriver implements ComputerDriver {
  generation = 0;
  readonly sessions: ComputerSession[] = [];
  readonly invocations: Invocation[] = [];
  readonly closedSessions: string[] = [];
  handler?: (
    call: Invocation,
    signal?: AbortSignal,
  ) => Promise<Result> | Result | undefined;
  getStatus() {
    return { installed: true, version: "test", state: "ready" };
  }
  async openSession(): Promise<ComputerSession> {
    const id = `fake-session-${this.sessions.length + 1}`;
    const driver = this;
    const session: ComputerSession = {
      id,
      get generation() {
        return driver.generation;
      },
      listTools: async () =>
        [...nativeNames, ...browserNames, ...discoveryNames].map(schema),
      readCursorState: async (signal) => {
        const call = {
          transportId: id,
          name: "get_agent_cursor_state",
          args: { session: id },
        };
        this.invocations.push(call);
        return (await this.handler?.(call, signal))?.structuredContent;
      },
      callTool: async (name, args, signal) => {
        const invocation = {
          transportId: id,
          name,
          args: structuredClone(args),
        };
        this.invocations.push(invocation);
        if (name === "check_permissions")
          return {
            structuredContent: { accessibility: true, screen_recording: true },
          };
        const overridden = this.handler?.(invocation, signal);
        if (overridden !== undefined) return overridden;
        if (name === "get_browser_state" && args.window_id !== undefined)
          return {
            structuredContent: {
              target_id: `${id}:browser-${args.window_id}`,
              binding_quality: "exact",
              mutation_allowed: true,
              tabs: [
                {
                  tab_id: `page-${args.window_id}-a`,
                  title: "A",
                  url: "https://a.example/",
                },
                {
                  tab_id: `page-${args.window_id}-b`,
                  title: "B",
                  url: "https://b.example/",
                },
              ],
            },
          };
        if (name === "list_windows")
          return {
            structuredContent: {
              windows: [1, 2, 3].map((window_id) => ({ pid: 100, window_id })),
            },
          };
        return {
          content: [{ type: "text", text: "ok" }],
          structuredContent: { element_id: "observed-ref" },
        };
      },
      close: async () => {
        this.closedSessions.push(id);
      },
    };
    this.sessions.push(session);
    return session;
  }
  async close() {}
}

function fixture(t: TestContext) {
  const driver = new FakeDriver();
  const host = new ComputerUse(driver);
  const runs: ComputerUseRun[] = [];
  t.after(async () => {
    await Promise.all(runs.map((run) => run.close()));
    await host.close();
  });
  return {
    driver,
    host,
    run: () => {
      const run = host.newRun(true);
      runs.push(run);
      return run;
    },
  };
}

function tool(run: ComputerUseRun, name = "computer_use_call") {
  const found = run.tools().find((item) => item.name === name);
  assert.ok(found);
  return found;
}

const discoveredCore = new WeakSet<ComputerUseRun>();
async function discoverCore(run: ComputerUseRun) {
  if (discoveredCore.has(run)) return;
  await tool(run, "computer_use_tools").execute(randomUUID(), {
    group: "core",
  });
  discoveredCore.add(run);
}

async function invoke(
  run: ComputerUseRun,
  args: Parameters,
  signal = new AbortController().signal,
) {
  await discoverCore(run);
  const id = randomUUID();
  await run.prepare(
    { id, name: "computer_use_call", arguments: args },
    signal,
    () => {},
  );
  return tool(run).execute(id, args, signal);
}

async function enableBrowser(run: ComputerUseRun) {
  await tool(run, "computer_use_tools").execute(randomUUID(), {
    group: "browser",
  });
}

test("preview sources require a live observed lease, use independent image-only sessions and expire on reconnect", async (t) => {
  const { host, driver, run } = fixture(t);
  driver.handler = (call) =>
    call.name === "get_window_state"
      ? {
          structuredContent: {
            pid: call.args.pid,
            window_id: call.args.window_id,
            elements: [],
          },
          content: [
            { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
          ],
        }
      : undefined;
  const current = run();
  await invoke(current, { tool: "get_window_state", target: windowTarget() });
  const snapshot = (
    current as unknown as {
      snapshot: { scope: import("../shared/types.ts").ComputerUseScope };
    }
  ).snapshot;
  const source = host.previewSource(snapshot.scope);
  assert.ok(source);
  const original = driver.invocations.find(
    (call) => call.name === "get_window_state",
  )!.transportId;
  await source.enter(new AbortController().signal, () => {});
  const focused = driver.invocations.at(-1)!;
  assert.equal(focused.name, "bring_to_front");
  assert.equal(focused.transportId, original);
  assert.deepEqual(focused.args, { pid: 100, window_id: 1, session: original });
  await source.capture(new AbortController().signal);
  const capture = driver.invocations.at(-1)!;
  assert.notEqual(capture.transportId, original);
  assert.equal(capture.args.include_accessibility_tree, false);
  assert.equal(capture.args.pid, 100);
  assert.equal(capture.args.window_id, 1);
  await source.close();
  assert.ok(driver.closedSessions.includes(capture.transportId));
  driver.generation++;
  assert.equal(source.active(), false);
  assert.equal(host.previewSource(snapshot.scope), undefined);
  current.release();
  assert.equal(host.previewSource(snapshot.scope), undefined);
  await assert.rejects(
    source.enter(new AbortController().signal, () => {}),
    /目标已释放/,
  );
});

test("preview focus waits for model input and refuses a lease released while queued", async (t) => {
  const { host, driver, run } = fixture(t);
  driver.handler = (call) =>
    call.name === "get_window_state"
      ? {
          structuredContent: {
            pid: call.args.pid,
            window_id: call.args.window_id,
            elements: [],
          },
        }
      : undefined;
  const current = run();
  await invoke(current, { tool: "get_window_state", target: windowTarget() });
  const snapshot = (
    current as unknown as {
      snapshot: { scope: import("../shared/types.ts").ComputerUseScope };
    }
  ).snapshot;
  const source = host.previewSource(snapshot.scope)!;
  const busy = await host.locks.acquireOperation(
    "busy-other-task",
    "exclusive",
  );
  const enter = source.enter(new AbortController().signal, () => {});
  await pending(enter);
  assert.equal(
    driver.invocations.some((call) => call.name === "bring_to_front"),
    false,
  );
  current.release();
  busy();
  host.locks.releaseOwner("busy-other-task");
  await assert.rejects(enter, /目标已释放/);
  assert.equal(
    driver.invocations.some((call) => call.name === "bring_to_front"),
    false,
  );
});

test("preview focus rejects an old page URL even when navigation retains the task scope", async (t) => {
  const { host, driver, run } = fixture(t);
  const current = run();
  await enableBrowser(current);
  await invoke(current, { tool: "get_browser_state", target: windowTarget() });
  let url = "https://a.example/first";
  driver.handler = (call) =>
    call.name === "get_browser_state"
      ? {
          structuredContent: {
            status: "ok",
            mode: "snapshot",
            target_id: call.args.target_id,
            tab_id: call.args.tab_id,
            refs: [],
            url,
          },
        }
      : undefined;
  await invoke(current, {
    tool: "get_browser_state",
    target: pageTarget("page-1-a"),
  });
  const snapshot = () =>
    (
      current as unknown as {
        snapshot: { scope: import("../shared/types.ts").ComputerUseScope };
      }
    ).snapshot;
  const source = host.previewSource(snapshot().scope)!;
  url = "https://a.example/second";
  await invoke(current, {
    tool: "get_browser_state",
    target: pageTarget("page-1-a"),
  });
  assert.equal(
    snapshot().scope.id,
    source.scope.id,
    "scope covers the same tab and origin",
  );
  await assert.rejects(
    source.enter(new AbortController().signal, () => {}),
    /页面已变化/,
  );
  assert.equal(
    driver.invocations.some((call) => call.name === "bring_to_front"),
    false,
  );
});

test("native cursor survives screenshot-free observations and model thinking, and expires with its lease", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { host, driver, run } = fixture(t);
  driver.handler = (call) =>
    call.name === "get_window_state"
      ? {
          structuredContent: {
            pid: call.args.pid,
            window_id: call.args.window_id,
            elements: [],
          },
        }
      : call.name === "get_agent_cursor_state"
        ? {
            structuredContent: {
              session: call.transportId,
              enabled: true,
              position: { x: 210, y: 120 },
              window_bounds: { x: 10, y: 20, width: 800, height: 500 },
              theme: { reduced_motion: "on" },
              motion: { glide_duration_ms: 240 },
            },
          }
        : undefined;
  const current = run();
  await invoke(current, {
    tool: "get_window_state",
    target: windowTarget(),
    arguments: { include_screenshot: false },
  });
  const snapshot = (
    current as unknown as {
      snapshot: { scope: import("../shared/types.ts").ComputerUseScope };
    }
  ).snapshot;
  const source = host.previewSource(snapshot.scope)!;
  assert.equal(await source.cursor!(new AbortController().signal), undefined);
  await invoke(current, {
    tool: "click",
    target: windowTarget(),
    arguments: { x: 200, y: 100 },
  });
  const cursor = await source.cursor!(new AbortController().signal);
  assert.ok(cursor);
  assert.equal(cursor.x, 0.25);
  assert.equal(cursor.y, 0.2);
  assert.equal(cursor.action, "click");
  assert.equal(cursor.pressed, true);
  assert.equal(cursor.reducedMotion, true);
  assert.equal(cursor.durationMs, 240);
  t.mock.timers.tick(30_000);
  await invoke(current, {
    tool: "get_window_state",
    target: windowTarget(),
    arguments: { include_screenshot: false },
  });
  const idle = await source.cursor!(new AbortController().signal);
  assert.equal(
    idle?.x,
    0.25,
    "keep the last real pointer position while the target lease is active",
  );
  assert.equal(idle?.action, "move");
  assert.equal(idle?.pressed, false, "idle heartbeats must not replay clicks");
  current.release();
  assert.equal(await source.cursor!(new AbortController().signal), undefined);
});

test("browser cursor uses dispatched main-frame coordinates and stays isolated on a shared transport", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { host, driver, run } = fixture(t);
  const a = run(),
    b = run();
  await enableBrowser(a);
  await enableBrowser(b);
  await invoke(a, { tool: "get_browser_state", target: windowTarget() });
  driver.handler = (call) =>
    call.name === "get_browser_state"
      ? {
          structuredContent: {
            status: "ok",
            mode: "snapshot",
            target_id: call.args.target_id,
            tab_id: call.args.tab_id,
            refs: [],
            url: "https://a.example/",
          },
        }
      : call.name === "browser_click"
        ? {
            structuredContent: {
              status: "ok",
              target_id: call.args.target_id,
              tab_id: call.args.tab_id,
              frame: "main",
              x: call.args.x,
              y: call.args.y,
            },
          }
        : undefined;
  await invoke(a, {
    tool: "get_browser_state",
    target: pageTarget("page-1-a"),
  });
  await invoke(b, {
    tool: "get_browser_state",
    target: pageTarget("page-1-b"),
  });
  const scope = (r: ComputerUseRun) =>
    (
      r as unknown as {
        snapshot: { scope: import("../shared/types.ts").ComputerUseScope };
      }
    ).snapshot.scope;
  const first = host.previewSource(scope(a))!,
    second = host.previewSource(scope(b))!;
  await invoke(a, {
    tool: "browser_click",
    target: pageTarget("page-1-a"),
    arguments: { x: 100, y: 200 },
  });
  await invoke(b, {
    tool: "browser_click",
    target: pageTarget("page-1-b"),
    arguments: { x: 500, y: 300 },
  });
  assert.equal((await first.cursor!(new AbortController().signal))?.x, 100);
  assert.equal((await second.cursor!(new AbortController().signal))?.x, 500);
  t.mock.timers.tick(30_000);
  const idle = await first.cursor!(new AbortController().signal);
  assert.equal(idle?.x, 100);
  assert.equal(idle?.action, "move");
  assert.equal(idle?.pressed, false);
  await invoke(a, {
    tool: "get_browser_state",
    target: pageTarget("page-1-a"),
  });
  driver.handler = (call) =>
    call.name === "browser_click"
      ? {
          structuredContent: {
            status: "ok",
            target_id: call.args.target_id,
            tab_id: call.args.tab_id,
            frame: "oopif",
            x: 10,
            y: 20,
          },
        }
      : undefined;
  await invoke(a, {
    tool: "browser_click",
    target: pageTarget("page-1-a"),
    arguments: { x: 10, y: 20 },
  });
  assert.equal(
    await first.cursor!(new AbortController().signal),
    undefined,
    "child-frame geometry is not guessed",
  );
});

test("same-window ownership spans observation, reasoning, and action; separate windows proceed", async (t) => {
  const { host, driver, run } = fixture(t);
  const a = run();
  const b = run();
  const c = run();
  await invoke(a, { tool: "get_window_state", target: windowTarget() });
  const bObservation = invoke(b, {
    tool: "get_window_state",
    target: windowTarget(),
  });
  await pending(bObservation);
  await invoke(c, { tool: "get_window_state", target: windowTarget(2) });
  await invoke(a, {
    tool: "click",
    target: windowTarget(),
    arguments: { x: 1, y: 2 },
  });
  await pending(bObservation);
  assert.equal(
    driver.invocations.filter((item) => item.name === "click").length,
    1,
  );
  assert.equal(host.locks.getTarget(a.id)?.windowId, "1");
  a.release();
  await bObservation;
});

test("different windows run background driver operations concurrently but foreground waits for them", async (t) => {
  const { driver, run } = fixture(t);
  const a = run();
  const b = run();
  const c = run();
  const aStarted = deferred<void>();
  const bStarted = deferred<void>();
  const finishA = deferred<Result>();
  const finishB = deferred<Result>();
  driver.handler = (invocation) => {
    if (invocation.name !== "get_window_state") return;
    if (invocation.args.window_id === 1) {
      aStarted.resolve();
      return finishA.promise;
    }
    if (invocation.args.window_id === 2) {
      bStarted.resolve();
      return finishB.promise;
    }
  };
  const first = invoke(a, {
    tool: "get_window_state",
    target: windowTarget(1),
  });
  await aStarted.promise;
  const second = invoke(b, {
    tool: "get_window_state",
    target: windowTarget(2),
  });
  await bStarted.promise;
  const foreground = invoke(c, {
    tool: "get_window_state",
    target: windowTarget(3),
    arguments: { delivery_mode: "foreground" },
  });
  await pending(foreground);
  finishA.resolve({ content: [{ type: "text", text: "a" }] });
  await first;
  await pending(foreground);
  finishB.resolve({ content: [{ type: "text", text: "b" }] });
  await second;
  await foreground;
});

test("runs share canonical browser target IDs and independent pages retain separate leases", async (t) => {
  const { host, driver, run } = fixture(t);
  const a = run();
  const b = run();
  await enableBrowser(a);
  await enableBrowser(b);
  await invoke(a, { tool: "get_browser_state", target: windowTarget() });
  await invoke(a, {
    tool: "get_browser_state",
    target: pageTarget("page-1-a"),
  });
  // Cached metadata must not reread the whole window or overwrite A's DOM refs.
  await invoke(b, { tool: "get_browser_state", target: windowTarget() });
  await invoke(b, {
    tool: "get_browser_state",
    target: pageTarget("page-1-b"),
  });
  await invoke(a, {
    tool: "browser_click",
    target: pageTarget("page-1-a"),
    arguments: { element_id: "observed-ref" },
  });
  await invoke(b, {
    tool: "browser_click",
    target: pageTarget("page-1-b"),
    arguments: { element_id: "observed-ref" },
  });
  const browserCalls = driver.invocations.filter(
    (item) =>
      item.name.startsWith("browser_") || item.name === "get_browser_state",
  );
  assert.equal(new Set(browserCalls.map((item) => item.transportId)).size, 1);
  assert.equal(
    browserCalls.filter((item) => item.args.window_id === 1).length,
    1,
  );
  const clicks = browserCalls.filter((item) => item.name === "browser_click");
  assert.equal(clicks[0].args.target_id, clicks[1].args.target_id);
  assert.notEqual(clicks[0].args.tab_id, clicks[1].args.tab_id);
  assert.equal(clicks[0].args.session, clicks[0].transportId);
  assert.equal(host.locks.getTarget(a.id)?.kind, "page");
  assert.equal(host.locks.getTarget(b.id)?.kind, "page");
});

test("window operations cannot overlap an owned browser page and native input cannot use a page lease", async (t) => {
  const { run } = fixture(t);
  const browser = run();
  const native = run();
  await enableBrowser(browser);
  await invoke(browser, { tool: "get_browser_state", target: windowTarget() });
  await invoke(browser, {
    tool: "get_browser_state",
    target: pageTarget("page-1-a"),
  });
  await assert.rejects(
    invoke(browser, {
      tool: "click",
      target: pageTarget("page-1-a"),
      arguments: { x: 1, y: 2 },
    }),
    /window/,
  );
  const observation = invoke(native, {
    tool: "get_window_state",
    target: windowTarget(),
  });
  await pending(observation);
  browser.release();
  await observation;
});

test("refreshing browser bindings waits for every page owner in that window", async (t) => {
  const { driver, run } = fixture(t);
  const a = run();
  const b = run();
  const refreshRun = run();
  for (const item of [a, b, refreshRun]) await enableBrowser(item);
  await invoke(a, { tool: "get_browser_state", target: windowTarget() });
  await invoke(a, {
    tool: "get_browser_state",
    target: pageTarget("page-1-a"),
  });
  await invoke(b, {
    tool: "get_browser_state",
    target: pageTarget("page-1-b"),
  });
  const refresh = invoke(refreshRun, {
    tool: "get_browser_state",
    target: windowTarget(),
    arguments: { refresh_binding: true },
  });
  await pending(refresh);
  a.release();
  await pending(refresh);
  assert.equal(
    driver.invocations.filter(
      (item) => item.name === "get_browser_state" && item.args.window_id === 1,
    ).length,
    1,
  );
  b.release();
  await refresh;
  assert.equal(
    driver.invocations.filter(
      (item) => item.name === "get_browser_state" && item.args.window_id === 1,
    ).length,
    2,
  );
});

test("different pages perform CDP actions concurrently on the shared transport", async (t) => {
  const { driver, run } = fixture(t);
  const a = run();
  const b = run();
  await enableBrowser(a);
  await enableBrowser(b);
  await invoke(a, { tool: "get_browser_state", target: windowTarget() });
  await invoke(a, {
    tool: "get_browser_state",
    target: pageTarget("page-1-a"),
  });
  await invoke(b, {
    tool: "get_browser_state",
    target: pageTarget("page-1-b"),
  });
  const aStarted = deferred<void>();
  const bStarted = deferred<void>();
  const finish = deferred<Result>();
  driver.handler = (invocation) => {
    if (invocation.name !== "browser_click") return;
    (invocation.args.tab_id === "page-1-a" ? aStarted : bStarted).resolve();
    return finish.promise;
  };
  const first = invoke(a, {
    tool: "browser_click",
    target: pageTarget("page-1-a"),
    arguments: { element_id: "observed-ref" },
  });
  await aStarted.promise;
  const second = invoke(b, {
    tool: "browser_click",
    target: pageTarget("page-1-b"),
    arguments: { element_id: "observed-ref" },
  });
  await bStarted.promise;
  finish.resolve({ content: [{ type: "text", text: "clicked" }] });
  await Promise.all([first, second]);
});

test("Panel injects exact target and session routing and rejects caller routing/output overrides", async (t) => {
  const { driver, run } = fixture(t);
  const a = run();
  await invoke(a, { tool: "get_window_state", target: windowTarget(2) });
  const observation = driver.invocations.at(-1)!;
  assert.equal(observation.args.pid, 100);
  assert.equal(observation.args.window_id, 2);
  assert.equal(observation.args.session, observation.transportId);
  for (const key of [
    "pid",
    "window_id",
    "session",
    "target",
    "target_id",
    "tab_id",
    "scope",
    "screenshot_out_file",
    "debug_image_out",
    "output_dir",
    "recording_path",
  ]) {
    await assert.rejects(
      invoke(a, {
        tool: "get_window_state",
        target: windowTarget(2),
        arguments: { [key]: "override" },
      }),
      new RegExp(`/arguments/${key}`),
    );
  }
  const before = driver.invocations.length;
  await assert.rejects(
    invoke(a, {
      tool: "get_window_state",
      target: windowTarget(2),
      arguments: { undocumented_argument: true },
    }),
    /\/arguments\/undocumented_argument/,
  );
  assert.equal(driver.invocations.length, before);
});

test("actions require a fresh observation and target switching or release invalidates old refs", async (t) => {
  const { driver, run } = fixture(t);
  const a = run();
  const action = (windowId: number) =>
    invoke(a, {
      tool: "click",
      target: windowTarget(windowId),
      arguments: { element_id: "observed-ref" },
    });
  await assert.rejects(action(1), /先观察/);
  await invoke(a, { tool: "get_window_state", target: windowTarget(1) });
  await action(1);
  await assert.rejects(action(1), /先观察/);
  await invoke(a, { tool: "get_window_state", target: windowTarget(1) });
  await invoke(a, { tool: "get_window_state", target: windowTarget(2) });
  await assert.rejects(action(1), /先观察/);
  await invoke(a, { tool: "get_window_state", target: windowTarget(1) });
  a.release();
  await assert.rejects(action(1), /先观察/);
  assert.equal(
    driver.invocations.filter((item) => item.name === "click").length,
    1,
  );
});

test("verify_state alone does not authorize using unobserved coordinates or references", async (t) => {
  const { run } = fixture(t);
  const a = run();
  await invoke(a, { tool: "verify_state", target: windowTarget() });
  await assert.rejects(
    invoke(a, {
      tool: "click",
      target: windowTarget(),
      arguments: { element_id: "unobserved-ref" },
    }),
    /先观察/,
  );
});

test("prepared approval is bound to exact arguments and cannot be replayed or redirected", async (t) => {
  const { driver, run } = fixture(t);
  const a = run();
  const parameters = { tool: "get_window_state", target: windowTarget(1) };
  const signal = new AbortController().signal;
  await discoverCore(a);
  const callsBefore = driver.invocations.length;
  await a.prepare(
    { id: "approval", name: "computer_use_call", arguments: parameters },
    signal,
    () => {},
  );
  await assert.rejects(
    tool(a).execute(
      "approval",
      { ...parameters, target: windowTarget(2) },
      signal,
    ),
    /审批|准备|参数|占用/,
  );
  assert.equal(driver.invocations.length, callsBefore);
  await a.prepare(
    { id: "valid", name: "computer_use_call", arguments: parameters },
    signal,
    () => {},
  );
  await tool(a).execute("valid", parameters, signal);
  const before = driver.invocations.length;
  await assert.rejects(
    tool(a).execute("valid", parameters, signal),
    /审批|准备|参数|占用/,
  );
  assert.equal(driver.invocations.length, before);
});

test("failed observations and uncertain action failures invalidate previously observed references", async (t) => {
  const { driver, run } = fixture(t);
  const a = run();
  const observe = () =>
    invoke(a, { tool: "get_window_state", target: windowTarget() });
  const click = () =>
    invoke(a, {
      tool: "click",
      target: windowTarget(),
      arguments: { element_id: "observed-ref" },
    });
  await observe();
  driver.handler = (invocation) =>
    invocation.name === "get_window_state"
      ? {
          isError: true,
          content: [{ type: "text", text: "failed observation" }],
        }
      : undefined;
  await assert.rejects(observe(), /failed observation|拒绝|未能/);
  await assert.rejects(click(), /先观察/);
  driver.handler = undefined;
  await observe();
  driver.handler = (invocation) => {
    if (invocation.name === "click")
      throw new Error("connection failed after possible dispatch");
    return undefined;
  };
  await assert.rejects(click(), /connection failed/);
  driver.handler = undefined;
  await assert.rejects(click(), /先观察/);
});

test("canceling an active call retains the target until the driver actually settles", async (t) => {
  const { host, driver, run } = fixture(t);
  const a = run();
  const b = run();
  const started = deferred<void>();
  const finish = deferred<Result>();
  let held = true;
  driver.handler = (invocation, signal) => {
    if (held && invocation.name === "get_window_state") {
      held = false;
      started.resolve();
      return finish.promise.then((result) => {
        signal?.throwIfAborted();
        return result;
      });
    }
  };
  const controller = new AbortController();
  const first = invoke(
    a,
    { tool: "get_window_state", target: windowTarget() },
    controller.signal,
  );
  const firstRejected = assert.rejects(first, /cancel run/);
  await started.promise;
  const second = invoke(b, {
    tool: "get_window_state",
    target: windowTarget(),
  });
  controller.abort(new Error("cancel run"));
  await a.close();
  assert.ok(host.locks.getTarget(a.id));
  await pending(second);
  finish.resolve({
    content: [{ type: "text", text: "completed after cancellation" }],
  });
  await firstRejected;
  await second;
  assert.equal(host.locks.getTarget(a.id), undefined);
});

test("closing a run prevents fresh native, discovery, and pooled browser dispatch", async (t) => {
  const { driver, run } = fixture(t);
  const a = run();
  await enableBrowser(a);
  await invoke(a, { tool: "get_browser_state", target: windowTarget() });
  await a.close();
  const before = driver.invocations.length;
  for (const parameters of [
    { tool: "list_apps" },
    { tool: "get_window_state", target: windowTarget() },
    { tool: "get_browser_state", target: pageTarget("page-1-a") },
  ])
    await assert.rejects(invoke(a, parameters), /关闭/);
  assert.equal(driver.invocations.length, before);
});

test("browser binding rejects inexact read-only mappings and unknown tabs", async (t) => {
  const { driver, run } = fixture(t);
  const a = run();
  await enableBrowser(a);
  for (const binding of [
    { binding_quality: "approximate", mutation_allowed: true },
    { binding_quality: "exact", mutation_allowed: false },
  ]) {
    driver.handler = (invocation) =>
      invocation.name === "get_browser_state"
        ? { structuredContent: { target_id: "wrong", ...binding, tabs: [] } }
        : undefined;
    await assert.rejects(
      invoke(a, { tool: "get_browser_state", target: windowTarget() }),
      /精确|绑定|只读|不匹配/,
    );
  }
  driver.handler = undefined;
  await invoke(a, { tool: "get_browser_state", target: windowTarget() });
  const before = driver.invocations.length;
  await assert.rejects(
    invoke(a, { tool: "get_browser_state", target: pageTarget("unknown") }),
    /不属于/,
  );
  assert.equal(driver.invocations.length, before);
});

test("browser preparation only creates an isolated profile and app launch requests a new instance", async (t) => {
  const { driver, run } = fixture(t);
  const a = run();
  await enableBrowser(a);
  await invoke(a, { tool: "browser_prepare" });
  const prepared = driver.invocations.at(-1)!;
  assert.deepEqual(prepared.args.profile, { mode: "isolated_new" });
  assert.equal(prepared.args.allow_launch, true);
  assert.equal(prepared.args.strategy, undefined);
  for (const args of [
    { strategy: { kind: "existing_profile" } },
    { profile: { mode: "existing" } },
  ]) {
    await assert.rejects(
      invoke(a, { tool: "browser_prepare", arguments: args }),
      /隔离|配置|profile|strategy/,
    );
  }
  await invoke(a, {
    tool: "launch_app",
    arguments: { app: "Test" },
  });
  assert.equal(
    driver.invocations.at(-1)!.args.creates_new_application_instance,
    true,
  );
  for (const args of [
    { urls: ["https://example.com"] },
    { webkit_inspector_port: 9222 },
    { additional_arguments: ["--remote-debugging-port=9222"] },
  ]) {
    await assert.rejects(
      invoke(a, { tool: "launch_app", arguments: args }),
      new RegExp(`/arguments/${Object.keys(args)[0]}`),
    );
  }
  await assert.rejects(
    invoke(a, {
      tool: "launch_app",
      arguments: { creates_new_application_instance: false },
    }),
    /\/arguments\/creates_new_application_instance/,
  );
  await assert.rejects(
    invoke(a, { tool: "browser_prepare", arguments: { allow_launch: false } }),
    /\/arguments\/allow_launch/,
  );
});

test("desktop and clipboard shortcuts cannot escape window ownership while local editing keys work", async (t) => {
  const { driver, run } = fixture(t);
  const a = run();
  const shortcuts = [
    ["command", "q"],
    ["cmd", "h"],
    ["cmd", "tab"],
    ["meta", "space"],
    ["cmd", "option", "w"],
    ["control", "right"],
    ["ctrl", "f3"],
    ["alt", "tab"],
    ["ctrl", "alt", "delete"],
    ["super", "r"],
    ["cmd", "c"],
    ["ctrl", "x"],
    ["command", "v"],
    ["shift", "insert"],
  ];
  for (const keys of shortcuts) {
    await assert.rejects(
      invoke(a, {
        tool: "hotkey",
        target: windowTarget(),
        arguments: { keys },
      }),
      /剪贴板|整个应用或桌面/,
    );
    await assert.rejects(
      invoke(a, {
        tool: "press_key",
        target: windowTarget(),
        arguments: { modifiers: keys.slice(0, -1), key: keys.at(-1) },
      }),
      /剪贴板|整个应用或桌面/,
    );
  }
  assert.equal(
    driver.invocations.some((call) =>
      ["hotkey", "press_key"].includes(call.name),
    ),
    false,
  );
  await invoke(a, { tool: "get_window_state", target: windowTarget() });
  await invoke(a, {
    tool: "hotkey",
    target: windowTarget(),
    arguments: { keys: ["cmd", "a"] },
  });
  assert.equal(driver.invocations.at(-1)!.name, "hotkey");
});

test("driver generation changes invalidate browser transport bindings and native observations", async (t) => {
  const { driver, host, run } = fixture(t);
  const a = run();
  await enableBrowser(a);
  await invoke(a, { tool: "get_browser_state", target: windowTarget() });
  const firstBinding = host.binding({ kind: "window", pid: 100, windowId: 1 });
  assert.ok(firstBinding);
  await invoke(a, { tool: "get_window_state", target: windowTarget() });
  driver.generation++;
  assert.equal(
    host.binding({ kind: "window", pid: 100, windowId: 1 }),
    undefined,
  );
  await assert.rejects(
    invoke(a, {
      tool: "click",
      target: windowTarget(),
      arguments: { x: 1, y: 2 },
    }),
    /先观察|重新观察|变化/,
  );
  await invoke(a, { tool: "get_browser_state", target: windowTarget() });
  const rebound = host.binding({ kind: "window", pid: 100, windowId: 1 });
  assert.ok(rebound);
  assert.notEqual(rebound, firstBinding);
  assert.equal(
    driver.invocations.filter(
      (item) => item.name === "get_browser_state" && item.args.window_id === 1,
    ).length,
    2,
  );
});

test("result conversion preserves supported images and clearly marks bounded text", () => {
  const converted = computerResult({
    content: [
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      { type: "text", text: "a".repeat(50_000) },
    ],
    structuredContent: { elements: "b".repeat(33_000) },
  });
  assert.equal(converted.content[0].type, "image");
  const text = converted.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  assert.match(text, /截断/);
  assert.match(text, /已省略/);
});
