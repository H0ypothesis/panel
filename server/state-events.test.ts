import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { AppState } from "../shared/types.ts";
import type { AppStatePatch } from "../shared/state-events.ts";
import { applyStatePatch } from "../src/state-sync.ts";
import { createWorkspace } from "./seed.ts";
import { Store } from "./store.ts";
import {
  captureStateFrame,
  serializeStateFrame,
  statePatch,
  StateEvents,
} from "./state-events.ts";
import { createApi } from "./api.ts";
import type { Runtime } from "./runtime.ts";
import type { Scheduler } from "./scheduler.ts";

function state(): AppState {
  const first = createWorkspace("first", "background");
  first.nodes.push({
    ...structuredClone(first.nodes[0]),
    id: "child",
    parentId: first.nodes[0].id,
    status: "running",
    response: "partial",
    toolCalls: [
      {
        id: "tool",
        name: "read",
        arguments: { path: "example" },
        status: "running",
        startedAt: 1,
      },
    ],
  });
  const second = createWorkspace("other", "elsewhere");
  return { instanceId: "server", revision: 1, workspaces: [first, second] };
}

function applyPatch(current: AppState, patch: AppStatePatch): AppState {
  const next = applyStatePatch(current, patch);
  assert.ok(next, "server event must apply to the frontend SSE baseline");
  return next;
}

class Response extends EventEmitter {
  chunks: string[] = [];
  blocked = false;
  destroyed = false;
  writableEnded = false;
  writeHead() {}
  setHeader() {}
  write(chunk: string) {
    this.chunks.push(chunk);
    return !this.blocked;
  }
}
function client(
  t: TestContext,
  stream: StateEvents,
  patches: boolean,
  blocked = false,
) {
  const request = new EventEmitter();
  const response = new Response();
  response.blocked = blocked;
  stream.subscribe(
    request as IncomingMessage,
    response as unknown as ServerResponse,
    patches,
  );
  t.after(() => {
    request.emit("close");
    response.emit("close");
  });
  return { request, response };
}
function eventData(chunk: string) {
  return JSON.parse(
    chunk
      .split("\n")
      .find((line) => line.startsWith("data: "))!
      .slice(6),
  );
}
function storeFixture() {
  const value = state();
  const store = new Store("/private/tmp/panel-state-events-no-io");
  store.data = {
    version: 1,
    revision: value.revision,
    workspaces: value.workspaces,
  };
  return store;
}

test("immutable SSE fingerprints detect nested in-place edits without retransmitting unchanged cards", () => {
  const current = state();
  const original = structuredClone(current);
  const before = captureStateFrame(current);
  current.workspaces[0].nodes[1].toolCalls![0].status = "completed";
  current.workspaces[0].nodes[1].toolCalls![0].output = "result";
  current.revision++;
  const next = captureStateFrame(current);
  const patch = statePatch(before, next)!;
  assert.equal(patch.baseRevision, 1);
  assert.equal(patch.workspaces.length, 1);
  assert.deepEqual(
    patch.workspaces[0].nodes.map((node) => node.id),
    ["child"],
  );
  assert.deepEqual(JSON.parse(serializeStateFrame(before)), original);
  assert.deepEqual(
    JSON.parse(JSON.stringify(applyPatch(original, patch))),
    current,
  );
});

test("SSE patches preserve workspace/card creation, deletion, ordering and removed metadata", () => {
  let current = state();
  let before = captureStateFrame(current);
  let old = structuredClone(current);
  current.workspaces[0].workingDirectory = "/example";
  current.workspaces[0].nodes[1].error = "temporary";
  current.storageError = "disk unavailable";
  current.revision++;
  let patch = statePatch(before, captureStateFrame(current))!;
  current = applyPatch(old, patch);
  before = captureStateFrame(current);
  old = structuredClone(current);
  delete current.storageError;
  delete current.workspaces[0].workingDirectory;
  delete current.workspaces[0].nodes[1].error;
  current.workspaces[0].nodes.reverse();
  current.workspaces.pop();
  current.workspaces.unshift(createWorkspace("new", "new"));
  current.revision++;
  patch = statePatch(before, captureStateFrame(current))!;
  assert.equal(patch.removedWorkspaceIds.length, 1);
  assert.equal(patch.workspaces.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(applyPatch(old, patch))),
    JSON.parse(JSON.stringify(current)),
  );
  before = captureStateFrame(current);
  old = structuredClone(current);
  current.workspaces[1].nodes.pop();
  current.revision++;
  patch = statePatch(before, captureStateFrame(current))!;
  assert.equal(patch.workspaces[0].removedNodeIds.length, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(applyPatch(old, patch))),
    JSON.parse(JSON.stringify(current)),
  );
});

test("SSE frames reject cross-instance or reversed bases and omit unchanged data", () => {
  const current = state();
  const before = captureStateFrame(current);
  assert.equal(
    statePatch(
      before,
      captureStateFrame({ ...current, instanceId: "restarted" }),
    ),
    undefined,
  );
  assert.equal(
    statePatch(before, captureStateFrame({ ...current, revision: 0 })),
    undefined,
  );
  assert.equal(
    statePatch(before, captureStateFrame({ ...current, revision: 2 }))
      ?.workspaces.length,
    0,
  );
});

test("stream coalesces updates and negotiates incremental versus legacy full-state delivery", async (t) => {
  const store = storeFixture();
  const stream = new StateEvents(store, 10);
  const modern = client(t, stream, true).response;
  const legacy = client(t, stream, false).response;
  assert.ok(modern.chunks[0].startsWith("data: "));
  const initial = eventData(modern.chunks[0]);
  for (let i = 0; i < 20; i++) {
    store.data.workspaces[0].nodes[1].response = `progress ${i}`;
    store.touch(store.data.workspaces[0]);
  }
  await delay(30);
  assert.equal(modern.chunks.length, 2);
  assert.equal(legacy.chunks.length, 2);
  assert.ok(modern.chunks[1].startsWith("event: state-patch\n"));
  assert.ok(legacy.chunks[1].startsWith("data: "));
  assert.equal(eventData(modern.chunks[1]).workspaces[0].nodes.length, 1);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(applyPatch(initial, eventData(modern.chunks[1]))),
    ),
    JSON.parse(JSON.stringify(store.snapshot())),
  );
  assert.deepEqual(
    eventData(legacy.chunks[1]),
    JSON.parse(JSON.stringify(store.snapshot())),
  );
});

test("backpressure retains a large initial snapshot and drains only the latest cumulative patch", async (t) => {
  const store = storeFixture();
  store.data.workspaces[1].nodes[0].response = "x".repeat(2_100_000);
  const stream = new StateEvents(store, 10);
  const slow = client(t, stream, true, true).response;
  const fast = client(t, stream, true).response;
  assert.ok(slow.chunks[0].length > 2_000_000);
  const original = eventData(slow.chunks[0]);
  store.data.workspaces[0].nodes[1].response = "first";
  store.touch();
  await delay(25);
  store.data.workspaces[0].nodes[1].response = "latest";
  store.touch();
  await delay(25);
  assert.equal(slow.chunks.length, 1);
  assert.equal(slow.destroyed, false);
  assert.equal(fast.chunks.length, 3);
  slow.blocked = false;
  slow.emit("drain");
  assert.equal(slow.chunks.length, 2);
  const patch = eventData(slow.chunks[1]);
  assert.equal(patch.baseRevision, original.revision);
  assert.equal(patch.revision, store.data.revision);
  assert.equal(patch.workspaces.length, 1);
  assert.ok(slow.chunks[1].length < 5000);
  assert.deepEqual(
    JSON.parse(JSON.stringify(applyPatch(original, patch))),
    JSON.parse(JSON.stringify(store.snapshot())),
  );
});

test("new and reconnected clients receive a current full baseline with independent revisions", async (t) => {
  const store = storeFixture();
  const stream = new StateEvents(store, 10);
  const first = client(t, stream, true);
  store.data.workspaces[0].nodes[1].response = "first update";
  store.touch();
  const second = client(t, stream, true).response;
  assert.equal(eventData(second.chunks[0]).revision, store.data.revision);
  await delay(25);
  assert.equal(first.response.chunks.length, 2);
  assert.equal(second.chunks.length, 1);
  first.request.emit("close");
  store.data.workspaces[0].nodes[1].response = "next update";
  store.touch();
  await delay(25);
  assert.equal(first.response.chunks.length, 2);
  assert.equal(
    eventData(second.chunks[1]).baseRevision,
    eventData(second.chunks[0]).revision,
  );
  const reconnected = client(t, stream, true).response;
  assert.ok(reconnected.chunks[0].startsWith("data: "));
  assert.equal(eventData(reconnected.chunks[0]).revision, store.data.revision);
});

test("API enables named incremental events only when requested", async (t) => {
  const store = storeFixture();
  const api = createApi(store, {} as Runtime, {} as Scheduler);
  const responses: Response[] = [];
  for (const url of ["/api/events", "/api/events?patches=1"]) {
    const request = Object.assign(new EventEmitter(), {
      method: "GET",
      url,
      headers: { host: "127.0.0.1:9999" },
    });
    const response = new Response();
    t.after(() => request.emit("close"));
    await api(
      request as IncomingMessage,
      response as unknown as ServerResponse,
    );
    responses.push(response);
  }
  store.data.workspaces[0].nodes[1].response = "changed";
  store.touch();
  await delay(180);
  assert.ok(responses[0].chunks[1].startsWith("data: "));
  assert.ok(responses[1].chunks[1].startsWith("event: state-patch\n"));
});
