import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import type { AppState, ComputerUseStatus, ToolCall } from "../shared/types.ts";
import { createApi } from "./api.ts";
import type { Runtime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { Store, type StoredNode, type StoredWorkspace } from "./store.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5d8AAAAASUVORK5CYII=",
  "base64",
);
const archivedPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const toolCall = (id = "same-call"): ToolCall => ({
  id,
  name: "computer_use_call",
  arguments: {
    tool: "get_window_state",
    target: { kind: "window", pid: 5, windowId: 42 },
  },
  status: "completed",
  startedAt: 1,
  finishedAt: 2,
});
const transcript = (
  bytes = png,
  id = "same-call",
  mimeType = "image/png",
): Message[] => [
  {
    role: "toolResult",
    toolCallId: id,
    toolName: "computer_use_call",
    content: [
      { type: "text", text: "Captured window" },
      { type: "image", data: bytes.toString("base64"), mimeType },
    ],
    isError: false,
    timestamp: 2,
  },
];
const node = (id: string, revision?: number): StoredNode => ({
  id,
  revision,
  parentId: null,
  prompt: "查看窗口",
  response: "已完成",
  status: "completed",
  config: { model: "test", thinking: "off" },
  color: "sage",
  position: { x: 0, y: 0 },
  contextIds: [],
  createdAt: 1,
  toolCalls: [toolCall()],
  messages: transcript(),
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "panel-computer-api-"));
  const store = new Store(directory);
  await store.init(false);
  const current = node("current", 2);
  current.previousRuns = [
    { ...node("current", 1), messages: transcript(archivedPng), archivedAt: 3 },
  ];
  const malicious = node("malicious", 0);
  malicious.messages = transcript(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    ),
    "same-call",
    "image/svg+xml",
  );
  const workspace: StoredWorkspace = {
    id: "workspace",
    title: "Computer fixture",
    description: "",
    example: false,
    createdAt: 1,
    updatedAt: 2,
    nodes: [
      current,
      node("legacy"),
      malicious,
      {
        ...node("sibling", 0),
        toolCalls: [toolCall("other-call")],
        messages: transcript(png, "other-call"),
      },
    ],
  };
  store.data.workspaces.push(workspace);
  let connected = false;
  const calls = { status: 0, connect: 0, model: 0 };
  const status = (): ComputerUseStatus => ({
    available: true,
    connected,
    overlay: true,
    version: "0.30.4",
    permissions: { accessibility: connected, screenRecording: connected },
  });
  const runtime: Runtime = {
    models: () => [],
    computerUseStatus() {
      calls.status++;
      return status();
    },
    async connectComputerUse() {
      calls.connect++;
      connected = true;
      return status();
    },
    async run() {
      calls.model++;
      throw new Error("API tests must not invoke a model or computer driver");
    },
  };
  const scheduler = new Scheduler(store, runtime);
  const api = createApi(store, runtime, scheduler);
  const server = createServer((request, response) => {
    void api(request, response).then(
      (handled) => {
        if (!handled) {
          response.writeHead(404);
          response.end();
        }
      },
      (error) => response.destroy(error),
    );
  });
  t.after(async () => {
    scheduler.shutdown();
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(directory, { recursive: true, force: true });
    assert.equal(calls.model, 0);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    store,
    current,
    runtime,
    calls,
    status,
    base,
    request: (path: string, init?: RequestInit) =>
      fetch(`${base}${path}`, init),
  };
}

const imagePath = (
  nodeId = "current",
  revision: number | string = 2,
  callId = "same-call",
  index: number | string = 0,
  workspaceId = "workspace",
) =>
  `/api/workspaces/${workspaceId}/nodes/${nodeId}/tool-images/${callId}/${index}?revision=${revision}`;

test("computer-use status is read-only and explicit connect forwards to the runtime", async (t) => {
  const f = await fixture(t);
  const state = JSON.stringify(f.store.data);
  const before = await f.request("/api/computer-use");
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), f.status());
  assert.deepEqual(f.calls, { status: 1, connect: 0, model: 0 });
  assert.equal(JSON.stringify(f.store.data), state);
  const connected = await f.request("/api/computer-use/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: f.base },
    body: "{}",
  });
  assert.equal(connected.status, 200);
  assert.equal(((await connected.json()) as ComputerUseStatus).connected, true);
  assert.deepEqual(f.calls, { status: 1, connect: 1, model: 0 });
  const after = await f.request("/api/computer-use");
  assert.equal(((await after.json()) as ComputerUseStatus).connected, true);
  assert.equal(f.calls.connect, 1);
});

test("preview rejects stale or foreign requests, uses the current lease and ends on regeneration", async (t) => {
  const f = await fixture(t);
  const path = "/api/workspaces/workspace/nodes/current/computer-use/preview";
  let resolutions = 0;
  f.current.status = "running";
  f.current.computerUseScope = {
    id: "live-lease",
    label: "当前窗口",
    target: { kind: "window", pid: 5, windowId: 42 },
  };
  f.runtime.computerUsePreviewSource = (scope) => {
    resolutions++;
    assert.deepEqual(scope, f.current.computerUseScope);
    return {
      scope,
      active: () => true,
      enter: async () => {
        throw new Error("streaming must never activate an app");
      },
      capture: async () => {
        throw new Error("native metadata must not take driver screenshots");
      },
      close: async () => {},
    };
  };
  for (const query of [
    "",
    "?revision=-1",
    "?revision=bogus",
    "?revision=1",
    "?revision=9007199254740992",
  ]) {
    const response = await f.request(path + query);
    assert.notEqual(response.status, 200);
    await response.arrayBuffer();
  }
  const blocked = await f.request(path + "?revision=2", {
    headers: { Origin: "https://untrusted.example" },
  });
  assert.equal(blocked.status, 403);
  await blocked.arrayBuffer();
  assert.equal(resolutions, 0);
  const response = await f.request(
    path + "?revision=2&native=1&pid=99&windowId=999",
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control") ?? "", /no-store/);
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"windowId":42/);
  assert.match(first, /"source":"native"/);
  f.current.revision = 3;
  let tail = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    tail += new TextDecoder().decode(chunk.value);
  }
  assert.match(tail, /"status":"ended"/);
});

test("entering a preview activates only the current task scope and rechecks it after waiting", async (t) => {
  const f = await fixture(t);
  f.current.status = "running";
  const scope = {
    id: "current-lease",
    label: "当前应用",
    target: { kind: "window" as const, pid: 5, windowId: 42 },
  };
  f.current.computerUseScope = scope;
  let enters = 0;
  let released = false;
  let changeWhileWaiting = false;
  f.runtime.computerUsePreviewSource = (target) => {
    assert.deepEqual(target, scope);
    return {
      scope: target,
      active: () => !released,
      enter: async (_signal, assertCurrent) => {
        if (changeWhileWaiting) f.current.revision = 3;
        assertCurrent();
        enters++;
      },
      capture: async () => {
        throw new Error("enter must not capture");
      },
      close: async () => {},
    };
  };
  const path =
    "/api/workspaces/workspace/nodes/current/computer-use/preview/enter";
  const request = (body: unknown, headers = {}) =>
    f.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  for (const body of [
    {},
    { expectedRevision: 1, scopeId: scope.id },
    { expectedRevision: 2, scopeId: "foreign-lease" },
  ]) {
    const response = await request(body);
    assert.notEqual(response.status, 200);
    await response.arrayBuffer();
  }
  const body = {
    expectedRevision: 2,
    scopeId: scope.id,
    pid: 999,
    windowId: 888,
  };
  assert.equal(
    (await request(body, { Origin: "https://foreign.test" })).status,
    403,
  );
  assert.equal(enters, 0);
  assert.equal((await request(body)).status, 200);
  assert.equal(enters, 1);
  released = true;
  assert.equal((await request(body)).status, 409);
  released = false;
  changeWhileWaiting = true;
  assert.equal((await request(body)).status, 409);
  assert.equal(enters, 1);
  f.current.status = "completed";
  assert.equal(
    (await request({ expectedRevision: 3, scopeId: scope.id })).status,
    409,
  );
  assert.equal(enters, 1);
});

test("stopping from a stale preview cannot cancel a regenerated task", async (t) => {
  const f = await fixture(t);
  f.current.status = "running";
  const path = "/api/workspaces/workspace/nodes/current/cancel";
  const stale = await f.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: 1 }),
  });
  assert.equal(stale.status, 409);
  await stale.arrayBuffer();
  assert.equal(f.current.status, "running");
  const current = await f.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expectedRevision: 2 }),
  });
  assert.equal(current.status, 200);
  await current.arrayBuffer();
  assert.equal(f.current.status, "cancelled");
});

test("cross-origin and cross-site setup never starts or grants the computer driver", async (t) => {
  const f = await fixture(t);
  const rejectedHeaders: Record<string, string>[] = [
    { Origin: "https://untrusted.example" },
    { "Sec-Fetch-Site": "cross-site" },
  ];
  for (const headers of rejectedHeaders) {
    const response = await f.request("/api/computer-use/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: "{}",
    });
    assert.equal(response.status, 403, JSON.stringify(headers));
    await response.arrayBuffer();
  }
  // Fetch normalizes Host, so exercise the actual host guard with a raw request.
  const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      `${f.base}/api/computer-use/connect`,
      {
        method: "POST",
        headers: {
          Host: "untrusted.example",
          "Content-Type": "application/json",
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end("{}");
  });
  assert.equal(wrongHost, 403);
  const invalidBody = await f.request("/api/computer-use/connect", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(invalidBody.status, 400);
  await invalidBody.arrayBuffer();
  assert.deepEqual(f.calls, { status: 0, connect: 0, model: 0 });
});

test("snapshots expose revision-bound image references while original transcripts remain private", async (t) => {
  const f = await fixture(t);
  const response = await f.request("/api/state");
  assert.equal(response.status, 200);
  const serialized = await response.text();
  assert.ok(!serialized.includes(png.toString("base64")));
  assert.ok(!serialized.includes(archivedPng.toString("base64")));
  assert.doesNotMatch(serialized, /"messages"|"previousRuns"|"data":/);
  const snapshot = JSON.parse(serialized) as AppState;
  const current = snapshot.workspaces[0].nodes.find(
    (item) => item.id === "current",
  )!;
  assert.equal(current.toolCalls?.[0].images?.[0].url, imagePath());
  assert.equal(current.toolCalls?.[0].images?.[0].mimeType, "image/png");
  assert.equal(
    snapshot.workspaces[0].nodes.find((item) => item.id === "malicious")
      ?.toolCalls?.[0].images,
    undefined,
  );
  assert.equal(f.current.messages?.[0].role, "toolResult");
  assert.deepEqual(f.calls, { status: 0, connect: 0, model: 0 });
});

test("screenshots select exact current or archived run and return private raster headers", async (t) => {
  const f = await fixture(t);
  for (const [revision, expected] of [
    [2, png],
    [1, archivedPng],
  ] as const) {
    const response = await f.request(imagePath("current", revision));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "image/png");
    assert.match(response.headers.get("Cache-Control") ?? "", /no-store/);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.match(
      response.headers.get("Content-Security-Policy") ?? "",
      /default-src 'none'/,
    );
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  const legacy = await f.request(imagePath("legacy", 0));
  assert.equal(legacy.status, 200);
  assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), png);
  assert.deepEqual(f.calls, { status: 0, connect: 0, model: 0 });
});

test("screenshot requests reject missing/invalid revisions and mismatched image identities", async (t) => {
  const f = await fixture(t);
  const paths = [
    imagePath().split("?")[0],
    imagePath("legacy", 0).split("?")[0],
    ...["", "-1", "1.5", "bogus", "Infinity", "9007199254740992", "0", "3"].map(
      (revision) => imagePath("current", revision),
    ),
    imagePath("missing"),
    imagePath("sibling", 0),
    imagePath("current", 2, "wrong-call"),
    imagePath("current", 2, "same-call", 1),
    imagePath("current", 2, "same-call", "-1"),
    imagePath("current", 2, "same-call", "0.5"),
    imagePath("current", 2, "same-call", 0, "missing"),
    imagePath("malicious", 0),
  ];
  for (const path of paths) {
    const response = await f.request(path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(response.headers.get("Content-Type") ?? "", /^image\//);
    assert.ok(!(await response.text()).includes(png.toString("base64")), path);
  }
  const blocked = await f.request(imagePath(), {
    headers: { Origin: "https://untrusted.example" },
  });
  assert.equal(blocked.status, 403);
  await blocked.arrayBuffer();
});
