import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CuaDriverService,
  cuaDaemonLaunchArgs,
  cuaDriverEnvironment,
  resolveCuaDriverLayout,
} from "./cua-driver.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  action?: (name: string) => Promise<CallToolResult>,
  timeout = 1_000,
  stopAction?: () => Promise<void>,
) {
  const calls: Array<{
    name: string;
    args: Record<string, unknown> | undefined;
  }> = [];
  let launches = 0;
  let stops = 0;
  let transports = 0;
  const service = new CuaDriverService({
    binaryPath: "/fake/CuaDriver.app/Contents/MacOS/cua-driver",
    requestTimeoutMs: timeout,
    startDaemon: async () => {
      launches++;
      return {
        socket: "/fake/private.sock",
        close: async () => {
          stops++;
          await stopAction?.();
        },
      };
    },
    createTransport: () => {
      transports++;
      const [client, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server(
        { name: "fake-cua", version: "0.30.4" },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          "click",
          "get_window_state",
          "start_session",
          "end_session",
          "set_agent_cursor_enabled",
        ].map((name) => ({
          name,
          inputSchema: {
            type: "object" as const,
            properties: { session: { type: "string" } },
          },
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        calls.push({
          name: request.params.name,
          args: request.params.arguments,
        });
        if (request.params.name === "click" && action)
          return action(request.params.name);
        return { content: [{ type: "text", text: "ok" }] };
      });
      void server.connect(serverTransport);
      return client;
    },
  });
  return {
    service,
    calls,
    get launches() {
      return launches;
    },
    get stops() {
      return stops;
    },
    get transports() {
      return transports;
    },
  };
}

test("macOS daemon uses signed app via LaunchServices with visible overlay and private socket", () => {
  const layout = resolveCuaDriverLayout({
    binaryPath: "/tmp/CuaDriver.app",
    platform: "darwin",
  });
  const launch = cuaDaemonLaunchArgs(
    layout,
    "/tmp/owned.sock",
    "/tmp/owned.pid",
    "darwin",
  );
  assert.equal(launch.command, "/usr/bin/open");
  assert.ok(launch.args.includes("/tmp/CuaDriver.app"));
  assert.ok(launch.args.includes("/tmp/owned.sock"));
  assert.ok(launch.args.includes("--no-permissions-gate"));
  assert.ok(!launch.args.includes("--no-overlay"));
  assert.ok(!launch.args.includes("--dangerously-bypass-approvals"));
  assert.equal(cuaDriverEnvironment().CUA_DRIVER_RS_TELEMETRY_ENABLED, "false");
  assert.throws(
    () => resolveCuaDriverLayout({ binaryPath: "relative/path" }),
    /absolute/,
  );
});

test("runs share one daemon but have independent scoped sessions and cursor lifetimes", async () => {
  const f = fixture();
  try {
    const [one, two] = await Promise.all([
      f.service.openSession(),
      f.service.openSession(),
    ]);
    assert.equal(f.launches, 1);
    assert.equal(f.transports, 2);
    assert.notEqual(one.id, two.id);
    await one.callTool("click", { pid: 12, window_id: 34 });
    assert.equal(f.calls.at(-1)?.args?.session, one.id);
    assert.equal(
      f.calls.filter(
        (call) =>
          call.name === "set_agent_cursor_enabled" &&
          call.args?.enabled === true,
      ).length,
      2,
    );
    await assert.rejects(
      one.callTool("click", { session: two.id }),
      /another run/,
    );
    await one.close();
    assert.equal(f.stops, 0);
    await two.callTool("get_window_state", {});
  } finally {
    await f.service.close();
  }
  assert.equal(f.stops, 1);
});

test("pre-dispatch cancellation never performs an action", async () => {
  const f = fixture();
  const session = await f.service.openSession();
  try {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await assert.rejects(
      session.callTool("click", {}, controller.signal),
      /cancelled/,
    );
    assert.equal(f.calls.filter((call) => call.name === "click").length, 0);
  } finally {
    await f.service.close();
  }
});

test("cancellation drains an in-flight native action before a scheduling permit may release", async () => {
  const action = deferred<CallToolResult>();
  const entered = deferred<void>();
  const f = fixture(async () => {
    entered.resolve();
    return action.promise;
  });
  const session = await f.service.openSession();
  const controller = new AbortController();
  let settled = false;
  const pending = session.callTool("click", {}, controller.signal);
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await entered.promise;
  controller.abort(new Error("run stopped"));
  await delay(20);
  assert.equal(
    settled,
    false,
    "must not settle on a local abort while native work is still running",
  );
  action.resolve({
    content: [{ type: "text", text: "native action complete" }],
  });
  await assert.rejects(pending, /run stopped/);
  assert.equal(
    f.stops,
    0,
    "a drained cancellation does not disrupt other windows",
  );
  await f.service.close();
});

test("unknown action outcome stops the native owner and never automatically replays the action", async () => {
  const f = fixture(async () => new Promise(() => {}), 30);
  const session = await f.service.openSession();
  const generation = session.generation;
  try {
    await assert.rejects(session.callTool("click", {}), /may have occurred/);
    assert.equal(f.stops, 1);
    assert.ok(
      session.generation > generation,
      "opaque browser capabilities must be invalidated",
    );
    assert.equal(f.calls.filter((call) => call.name === "click").length, 1);
    await session.callTool("get_window_state", {});
    assert.equal(f.launches, 2);
    assert.equal(f.calls.filter((call) => call.name === "click").length, 1);
  } finally {
    await f.service.close();
  }
});

test("service shutdown drains active work before ending native sessions", async () => {
  const action = deferred<CallToolResult>();
  const entered = deferred<void>();
  const f = fixture(async () => {
    entered.resolve();
    return action.promise;
  });
  const session = await f.service.openSession();
  const pending = session.callTool("click", {});
  const rejected = assert.rejects(pending, /session closed/);
  await entered.promise;
  let closed = false;
  const stopping = f.service.close().then(() => {
    closed = true;
  });
  await delay(20);
  assert.equal(closed, false);
  assert.equal(f.stops, 0);
  action.resolve({ content: [] });
  await rejected;
  await stopping;
  assert.equal(f.stops, 1);
});

test("a failed native stop blocks all existing and future sessions and remains a shutdown error", async () => {
  const f = fixture(
    async () => new Promise(() => {}),
    30,
    async () => {
      throw new Error("native stop failed");
    },
  );
  const [one, two] = await Promise.all([
    f.service.openSession(),
    f.service.openSession(),
  ]);
  const secondGeneration = two.generation;
  await assert.rejects(one.callTool("click"), /native stop failed/);
  assert.ok(
    two.generation > secondGeneration,
    "failed stop also retires idle transports",
  );
  const recordedCalls = f.calls.length;
  await assert.rejects(two.callTool("click"), /native stop failed/);
  await assert.rejects(two.listTools(), /native stop failed/);
  await assert.rejects(f.service.openSession(), /native stop failed/);
  assert.equal(
    f.calls.length,
    recordedCalls,
    "no request may bypass the retained stop barrier",
  );
  assert.equal(f.calls.filter((call) => call.name === "click").length, 1);
  assert.equal(f.launches, 1);
  assert.equal(f.transports, 2);
  await assert.rejects(f.service.close(), /native stop failed/);
});

test("status checks do not launch native processes or request permissions", async () => {
  const f = fixture();
  const status = f.service.getStatus();
  assert.equal(status.installed, false);
  assert.equal(status.state, "not_installed");
  assert.equal(f.launches, 0);
  assert.equal(f.calls.length, 0);
  await f.service.close();
});

test("idle-expired sessions reconnect on the next call without replaying stale capabilities", async () => {
  const f = fixture(async () => ({
    isError: true,
    content: [{ type: "text", text: "session ended" }],
    structuredContent: {
      status: "refused",
      refusal: { code: "session_ended" },
    },
  }));
  const session = await f.service.openSession();
  const generation = session.generation;
  try {
    const result = await session.callTool("click", {});
    assert.equal(result.isError, true);
    assert.ok(session.generation > generation);
    await session.listTools();
    assert.equal(f.transports, 2);
    assert.equal(f.launches, 1);
    assert.equal(f.calls.filter((call) => call.name === "click").length, 1);
  } finally {
    await f.service.close();
  }
});

test("permission requests respect the service lifecycle before starting any OS helper", async () => {
  const f = fixture();
  await f.service.close();
  await assert.rejects(f.service.requestPermissions(), /shutting down/);
});
