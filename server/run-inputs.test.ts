import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { RunInput, RunInputMode } from "../shared/types.ts";
import { createApi } from "./api.ts";
import { buildContext } from "./context.ts";
import type { RunContextOptions, Runtime } from "./runtime.ts";
import { NodeMutationConflict, Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type StoredNode } from "./store.ts";
import { importWorkspace } from "./workspace-import.ts";

async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Run did not reach expected state");
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "panel-run-input-"));
  const store = new Store(directory);
  await store.init(false);
  const workspace = createWorkspace("Inputs", "Fixture context");
  store.data.workspaces.push(workspace);
  const config = { model: "test/inputs", thinking: "off" as const };
  const runs: {
    options: RunContextOptions;
    received: RunInput[];
    ready: () => void;
    deliver: (input: RunInput) => Promise<void>;
    finish: () => void;
  }[] = [];
  const runtime: Runtime = {
    models: () => [
      {
        id: config.model,
        name: "Fixture",
        provider: "test",
        providerName: "test",
        available: true,
        demo: true,
        contextWindow: 128000,
        thinkingLevels: ["off"],
      },
    ],
    async run(
      _config,
      _history,
      prompt,
      signal,
      _onText,
      _environment,
      options,
    ) {
      let finish!: () => void;
      const wait = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const messages: Message[] = [
        { role: "user", content: prompt, timestamp: 1 },
      ];
      const received: RunInput[] = [];
      const run = {
        options: options!,
        received,
        finish,
        ready: () =>
          options!.onRunInputReady?.((input) => received.push(input)),
        deliver: async (input: RunInput) => {
          messages.push({
            role: "user",
            content: input.text,
            timestamp: input.createdAt,
          });
          options!.onRunInputDelivered?.(input.id);
          await options!.onMessages?.(messages);
        },
      };
      runs.push(run);
      signal.addEventListener("abort", finish, { once: true });
      try {
        await wait;
        signal.throwIfAborted();
        messages.push(fauxAssistantMessage("finished"));
        return { messages, response: "finished" };
      } finally {
        options!.onRunInputReady?.();
        await options!.onMessages?.(messages);
        signal.removeEventListener("abort", finish);
      }
    },
  };
  const scheduler = new Scheduler(store, runtime, 2);
  const api = createApi(store, runtime, scheduler);
  const start = async () => {
    const index = runs.length;
    const node = await scheduler.submit(workspace.id, {
      parentId: workspace.nodes[0].id,
      prompt: "original task",
      requestId: `run-${index}`,
      config,
    });
    await until(() => runs.length > index);
    return { node, ...runs[index] };
  };
  const send = (
    node: StoredNode,
    text = "adjust direction",
    mode: RunInputMode = "steer",
    requestId = "input-1",
    expectedRevision = node.revision ?? 0,
  ) =>
    scheduler.sendRunInput(workspace.id, node.id, {
      text,
      mode,
      requestId,
      expectedRevision,
    });
  const call = async (path: string, body?: unknown, method = "POST") => {
    const request = Readable.from(
      body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
    ) as IncomingMessage;
    Object.assign(request, {
      method,
      url: `/api${path}`,
      headers: { host: "localhost", "content-type": "application/json" },
    });
    let status = 0,
      output = "";
    const response = {
      setHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        output = value;
      },
    } as unknown as ServerResponse;
    await api(request, response);
    return { status, body: JSON.parse(output) };
  };
  t.after(async () => {
    scheduler.shutdown();
    for (const run of runs) run.finish();
    await until(() =>
      workspace.nodes.every((node) => node.status !== "running"),
    );
    await delay(20);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    store,
    workspace,
    config,
    runs,
    scheduler,
    start,
    send,
    call,
  };
}

test("inputs persist before Pi receives them and delivered messages join branch context", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  const input = await f.send(run.node);
  assert.equal(run.received.length, 0);
  run.ready();
  assert.deepEqual(
    run.received.map((item) => item.id),
    [input.id],
  );
  await run.deliver(input);
  assert.equal(input.status, "delivered");
  assert.ok(input.deliveredAt);
  run.finish();
  await until(() => run.node.status === "completed");
  const history = buildContext(f.workspace, run.node.id).messages;
  assert.equal(
    history.filter(
      (message) => message.role === "user" && message.content === input.text,
    ).length,
    1,
  );
  const restored = new Store(f.directory);
  await restored.init(false);
  assert.equal(
    restored
      .workspace(f.workspace.id)
      .nodes.find((node) => node.id === run.node.id)!.runInputs![0].status,
    "delivered",
  );
});

test("parallel cards receive their own queues and retries never deliver twice", async (t) => {
  const f = await fixture(t);
  const a = await f.start(),
    b = await f.start();
  a.ready();
  b.ready();
  const first = await f.send(a.node, "change A");
  assert.equal(await f.send(a.node, "change A"), first);
  await f.send(b.node, "finish B", "followUp");
  assert.deepEqual(
    a.received.map((input) => input.text),
    ["change A"],
  );
  assert.deepEqual(
    b.received.map((input) => input.text),
    ["finish B"],
  );
  await assert.rejects(
    f.send(a.node, "different content"),
    NodeMutationConflict,
  );
  await assert.rejects(
    f.send(a.node, "change A", "followUp"),
    NodeMutationConflict,
  );
  await assert.rejects(
    f.send(a.node, "stale", "steer", "new-id", 1),
    NodeMutationConflict,
  );
});

test("API exposes capabilities and accepts both modes, while invalid and stale inputs reject", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  run.ready();
  assert.equal(
    (await f.call("/capabilities", undefined, "GET")).body.runInputs,
    true,
  );
  const path = `/workspaces/${f.workspace.id}/nodes/${run.node.id}/inputs`;
  const body = {
    text: "follow this guidance",
    mode: "steer",
    requestId: "api-input",
    expectedRevision: 0,
  };
  const first = await f.call(path, body);
  assert.equal(first.status, 200);
  assert.equal(first.body.input.status, "queued");
  assert.equal((await f.call(path, body)).status, 200);
  assert.equal(run.received.length, 1);
  assert.equal(
    (await f.call(path, { ...body, requestId: "follow", mode: "followUp" }))
      .status,
    200,
  );
  for (const change of [
    { text: " " },
    { text: "x".repeat(20001) },
    { mode: "unknown" },
    { expectedRevision: -1 },
    { expectedRevision: undefined },
  ])
    assert.equal((await f.call(path, { ...body, ...change })).status, 400);
  assert.equal(
    (await f.call(path, { ...body, expectedRevision: 1 })).status,
    409,
  );
  assert.equal(run.received.length, 2);
});

test("closing a run during durable acceptance reports undelivered and never enqueues it", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  run.ready();
  const original = f.store.save.bind(f.store);
  let release!: () => void;
  let saving = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const save = t.mock.method(f.store, "save", async () => {
    saving = true;
    await gate;
    await original();
  });
  const sending = f.send(run.node);
  const rejected = assert.rejects(sending, /消息未送达/);
  await until(() => saving);
  run.options.onRunInputReady?.();
  release();
  await rejected;
  save.mock.restore();
  assert.equal(run.node.runInputs![0].status, "cancelled");
  assert.deepEqual(run.received, []);
});

test("failed storage, cancellation and restart cannot replay pending messages", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  run.ready();
  const save = t.mock.method(f.store, "save", async () => {
    throw new Error("fixture disk full");
  });
  await assert.rejects(f.send(run.node), /disk full/);
  save.mock.restore();
  assert.deepEqual(run.received, []);
  assert.equal(run.node.runInputs![0].status, "cancelled");
  const queued = await f.send(run.node, "pending", "followUp", "pending");
  await f.store.save();
  const restored = new Store(f.directory);
  await restored.init(false);
  assert.equal(
    restored
      .workspace(f.workspace.id)
      .nodes.find((node) => node.id === run.node.id)!.runInputs![1].status,
    "cancelled",
  );
  await f.scheduler.cancel(f.workspace.id, run.node.id);
  assert.equal(queued.status, "cancelled");
  await assert.rejects(f.send(run.node, "too late", "steer", "late"), /已结束/);
});

test("queue limit bounds pending messages and regeneration fences the old revision", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  run.ready();
  for (let i = 0; i < 20; i++)
    await f.send(run.node, `message ${i}`, "steer", `message-${i}`);
  await assert.rejects(
    f.send(run.node, "overflow", "steer", "overflow"),
    /20 条/,
  );
  await run.deliver(run.received[0]);
  await f.send(run.node, "room now", "steer", "room");
  run.finish();
  await until(() => run.node.status === "completed");
  assert.equal(run.node.runInputs![1].status, "cancelled");
  assert.equal(
    (await f.send(run.node, "message 0", "steer", "message-0")).status,
    "delivered",
  );
  const regenerated = await f.scheduler.regenerate(
    f.workspace.id,
    run.node.id,
    {
      prompt: "new task",
      config: f.config,
      expectedRevision: 0,
      requestId: "regenerate",
    },
  );
  assert.equal(regenerated.runInputs, undefined);
  assert.equal(regenerated.previousRuns![0].runInputs![0].status, "delivered");
  await assert.rejects(
    f.send(regenerated, "old input", "steer", "stale", 0),
    NodeMutationConflict,
  );
});

test("JSON import preserves delivered input history and cancels pending records", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  run.ready();
  const delivered = await f.send(run.node);
  await run.deliver(delivered);
  await f.send(run.node, "later", "followUp", "later");
  const imported = importWorkspace({
    version: 1,
    workspace: structuredClone(f.workspace),
  });
  const node = imported.nodes.find((node) => node.prompt === "original task")!;
  assert.deepEqual(
    node.runInputs?.map((input) => input.status),
    ["delivered", "cancelled"],
  );
  assert.match(JSON.stringify(node.messages), /adjust direction/);
});
