import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { ModelOption, RunConfig } from "../shared/types.ts";
import { buildContext } from "./context.ts";
import { createApi } from "./api.ts";
import type { RunEnvironment, Runtime, RunResult } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type StoredNode, type StoredWorkspace } from "./store.ts";

const config: RunConfig = { model: "test/main", thinking: "medium" };
class ControlledRuntime implements Runtime {
  calls: Array<{
    prompt: string;
    history: Message[];
    environment?: RunEnvironment;
  }> = [];
  releases = new Map<string, () => void>();
  models(): ModelOption[] {
    return [
      {
        id: config.model,
        name: "Test",
        provider: "test",
        providerName: "Test",
        available: true,
        demo: false,
        thinkingLevels: ["medium", "high"],
        contextWindow: 100_000,
      },
    ];
  }
  async run(
    _config: RunConfig,
    history: Message[],
    prompt: string,
    signal: AbortSignal,
    _onText: (text: string) => void,
    environment?: RunEnvironment,
  ): Promise<RunResult> {
    this.calls.push({ prompt, history: structuredClone(history), environment });
    // Deliberately finish only when released, including after cancellation, to
    // verify that a cancelled node cannot be mutated during executor cleanup.
    await new Promise<void>((resolve) =>
      this.releases.set(prompt, () => {
        this.releases.delete(prompt);
        resolve();
      }),
    );
    signal.throwIfAborted();
    return {
      response: `new answer:${prompt}`,
      messages: [
        { role: "user", content: prompt, timestamp: Date.now() },
        fauxAssistantMessage(`new answer:${prompt}`),
      ],
    };
  }
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Timed out waiting for runtime");
}

async function setup(t: TestContext, concurrency = 2) {
  const directory = await mkdtemp(join(tmpdir(), "panel-node-mutations-"));
  const store = new Store(directory);
  await store.init(false);
  const workspace: StoredWorkspace = createWorkspace("Topic", "Background");
  const root = workspace.nodes[0];
  const make = (id: string, parentId: string): StoredNode => ({
    id,
    parentId,
    prompt: `old prompt:${id}`,
    response: `old answer:${id}`,
    status: "completed",
    config: { ...config },
    contextIds: [root.id],
    color: "sage",
    position: { x: id.length * 370, y: id.length * 250 },
    createdAt: 1234,
    startedAt: 1240,
    finishedAt: 1250,
    usage: { input: 1, output: 2, total: 3 },
    messages: [
      { role: "user", content: `old prompt:${id}`, timestamp: 1240 },
      fauxAssistantMessage(`OLD_TRANSCRIPT_${id}`),
    ],
    requestId: `original-${id}`,
    error: "old error",
    toolCalls: [
      {
        id: `old-tool-${id}`,
        name: "read",
        arguments: { path: "old.txt" },
        status: "completed",
        startedAt: 1240,
        authorization: {
          id: `old-auth-${id}`,
          actionHash: "old",
          policyVersion: "old",
          issuedAt: 1240,
          expiresAt: Date.now() + 30_000,
        },
      },
    ],
  });
  const a = make("a", root.id);
  const b = make("bb", a.id);
  const c = make("ccc", b.id);
  const sibling = make("sibling", root.id);
  workspace.nodes.push(a, b, c, sibling);
  store.data.workspaces.push(workspace);
  await store.save();
  const runtime = new ControlledRuntime();
  const scheduler = new Scheduler(store, runtime, concurrency);
  const regenerate = (
    nodeId = a.id,
    prompt = "new question",
    expectedRevision = 0,
    requestId = randomUUID(),
  ) =>
    scheduler.regenerate(workspace.id, nodeId, {
      prompt,
      expectedRevision,
      requestId,
      config,
    });
  const finish = async (prompt: string) => {
    await until(() => runtime.releases.has(prompt));
    runtime.releases.get(prompt)!();
    await until(
      () =>
        !workspace.nodes.some(
          (node) => node.prompt === prompt && node.status === "running",
        ),
    );
    await store.save();
    await delay(0);
  };
  t.after(async () => {
    scheduler.shutdown();
    for (const release of runtime.releases.values()) release();
    await delay(20);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    store,
    workspace,
    root,
    a,
    b,
    c,
    sibling,
    runtime,
    scheduler,
    regenerate,
    finish,
  };
}

test("regeneration preserves node identity and layout while replacing only its run and parent context", async (t) => {
  const e = await setup(t);
  e.workspace.approvalMode = "auto";
  e.workspace.safetyModel = config.model;
  const node = await e.regenerate();
  await until(() => e.runtime.calls.length === 1);
  assert.equal(node.id, e.a.id);
  assert.equal(node.parentId, e.a.parentId);
  assert.deepEqual(node.position, e.a.position);
  assert.equal(node.createdAt, e.a.createdAt);
  assert.equal(node.color, e.a.color);
  assert.equal(node.revision, 1);
  assert.equal(node.contextStale, false);
  assert.equal(node.response, "");
  assert.equal(node.messages, undefined);
  assert.equal(node.toolCalls, undefined);
  assert.equal(node.usage, undefined);
  assert.equal(node.error, undefined);
  assert.equal(node.finishedAt, undefined);
  assert.ok(node.startedAt! > e.a.startedAt!);
  assert.deepEqual(node.contextIds, [e.root.id]);
  assert.equal(node.execution?.approvalMode, "auto");
  assert.equal(node.execution?.safetyModel, config.model);
  assert.doesNotMatch(
    JSON.stringify(e.runtime.calls[0].history),
    /old prompt:a|OLD_TRANSCRIPT|old answer/,
  );
  assert.match(JSON.stringify(e.runtime.calls[0].history), /Topic/);
  assert.equal(node.previousRuns?.length, 1);
  assert.equal(node.previousRuns?.[0].response, "old answer:a");
  assert.ok(node.previousRuns?.[0].toolCalls?.[0].authorization?.invalidatedAt);
  const publicNode = e.store
    .snapshot()
    .workspaces[0].nodes.find((entry) => entry.id === node.id)!;
  assert.equal("previousRuns" in publicNode, false);
  assert.equal("messages" in publicNode, false);
  const saved = JSON.parse(
    await readFile(join(e.directory, "state.json"), "utf8"),
  );
  assert.equal(
    saved.workspaces[0].nodes.find((entry: StoredNode) => entry.id === node.id)
      .previousRuns.length,
    1,
  );
  await e.finish("new question");
});

test("regeneration marks every descendant stale and requires regeneration in ancestor order", async (t) => {
  const e = await setup(t);
  await e.regenerate();
  assert.equal(
    e.workspace.nodes.find((node) => node.id === e.b.id)?.contextStale,
    true,
  );
  assert.equal(
    e.workspace.nodes.find((node) => node.id === e.c.id)?.contextStale,
    true,
  );
  assert.equal(
    e.workspace.nodes.find((node) => node.id === e.sibling.id)?.contextStale,
    undefined,
  );
  assert.throws(() => buildContext(e.workspace, e.b.id));
  await assert.rejects(
    e.regenerate(e.c.id, "cannot skip stale parent"),
    /失效|尚未完成/,
  );
  await e.finish("new question");
  await assert.rejects(
    e.scheduler.submit(e.workspace.id, {
      parentId: e.b.id,
      prompt: "stale followup",
      config,
      requestId: randomUUID(),
    }),
    /失效/,
  );
  const b = await e.regenerate(e.b.id, "refresh child");
  await until(() => e.runtime.calls.length === 2);
  assert.equal(b.contextStale, false);
  const history = JSON.stringify(e.runtime.calls[1].history);
  assert.match(history, /new question/);
  assert.doesNotMatch(history, /OLD_TRANSCRIPT|old prompt:bb/);
  await e.finish("refresh child");
  assert.doesNotThrow(() => buildContext(e.workspace, e.b.id));
  assert.throws(() => buildContext(e.workspace, e.c.id), /失效/);
});

test("concurrent repeated request IDs are idempotent and different writers cannot overwrite a revision", async (t) => {
  const e = await setup(t);
  const requestId = randomUUID();
  const [one, two] = await Promise.all([
    e.regenerate(e.a.id, "once", 0, requestId),
    e.regenerate(e.a.id, "once", 0, requestId),
  ]);
  assert.equal(one, two);
  await until(() => e.runtime.calls.length === 1);
  await assert.rejects(
    e.regenerate(e.a.id, "different", 0, requestId),
    /请求 ID/,
  );
  await assert.rejects(e.regenerate(e.a.id, "stale writer", 0), /已被修改/);
  await e.finish("once");
  const next = await e.regenerate(e.a.id, "twice", 1);
  assert.equal(next.revision, 2);
  assert.equal((await e.regenerate(e.a.id, "once", 0, requestId)).id, e.a.id);
  assert.equal(
    e.workspace.nodes.find((node) => node.id === e.a.id)?.previousRuns?.length,
    2,
  );
  await e.finish("twice");
  assert.equal(e.runtime.calls.length, 2);
  await assert.rejects(
    e.scheduler.submit(e.workspace.id, {
      parentId: e.root.id,
      prompt: "reuse",
      config,
      requestId,
    }),
    /请求 ID/,
  );
});

test("regeneration and deletion reject roots, queued tasks, descendants and cancelled-but-active cleanup", async (t) => {
  const e = await setup(t, 1);
  await assert.rejects(e.regenerate(e.root.id), /根节点/);
  await assert.rejects(
    e.scheduler.deleteNode(e.workspace.id, e.root.id, {
      expectedRevision: 0,
      expectedNodeIds: e.workspace.nodes.map((node) => node.id),
    }),
    /根节点/,
  );
  const running = await e.scheduler.submit(e.workspace.id, {
    parentId: e.a.id,
    prompt: "running child",
    config,
    requestId: randomUUID(),
  });
  await until(() => e.runtime.calls.length === 1);
  await assert.rejects(e.regenerate(), /运行|排队/);
  const queued = await e.scheduler.submit(e.workspace.id, {
    parentId: e.sibling.id,
    prompt: "queued child",
    config,
    requestId: randomUUID(),
  });
  assert.equal(queued.status, "queued");
  await assert.rejects(e.regenerate(queued.id, "edit queued"), /运行|排队/);
  await e.scheduler.cancel(e.workspace.id, running.id);
  assert.equal(running.status, "cancelled");
  await assert.rejects(e.regenerate(running.id, "edit cleanup"), /收尾/);
  await assert.rejects(
    e.scheduler.deleteNode(e.workspace.id, running.id, {
      expectedRevision: 0,
      expectedNodeIds: [running.id],
    }),
    /收尾/,
  );
  await e.finish("running child");
  await e.scheduler.cancel(e.workspace.id, queued.id);
  if (e.runtime.releases.has("queued child")) await e.finish("queued child");
});

test("cascade deletion removes only the confirmed subtree and refuses revision or membership conflicts", async (t) => {
  const e = await setup(t);
  await assert.rejects(
    e.scheduler.deleteNode(e.workspace.id, e.a.id, {
      expectedRevision: 1,
      expectedNodeIds: [e.a.id, e.b.id, e.c.id],
    }),
    /已被修改/,
  );
  for (const expectedNodeIds of [
    [e.a.id, e.b.id],
    [e.a.id, e.b.id, e.c.id, e.sibling.id],
    [e.a.id, e.a.id, e.b.id, e.c.id],
  ])
    await assert.rejects(
      e.scheduler.deleteNode(e.workspace.id, e.a.id, {
        expectedRevision: 0,
        expectedNodeIds,
      }),
      /删除范围/,
    );
  assert.equal(e.workspace.nodes.length, 5);
  const state = await e.scheduler.deleteNode(e.workspace.id, e.a.id, {
    expectedRevision: 0,
    expectedNodeIds: [e.c.id, e.a.id, e.b.id],
  });
  assert.deepEqual(
    state.workspaces[0].nodes.map((node) => node.id),
    [e.root.id, e.sibling.id],
  );
  assert.equal(e.workspace.nodes[1], e.sibling);
  assert.equal(e.runtime.calls.length, 0);
});

test("failed persistence retains the exact old tree and cannot launch a regenerated model", async (t) => {
  const e = await setup(t);
  const original = e.store.save.bind(e.store);
  const before = JSON.stringify(e.workspace.nodes);
  e.store.save = async () => {
    throw new Error("disk failed");
  };
  await assert.rejects(e.regenerate(), /disk failed/);
  assert.equal(JSON.stringify(e.workspace.nodes), before);
  assert.equal(e.runtime.calls.length, 0);
  await assert.rejects(
    e.scheduler.deleteNode(e.workspace.id, e.a.id, {
      expectedRevision: 0,
      expectedNodeIds: [e.a.id, e.b.id, e.c.id],
    }),
    /disk failed/,
  );
  assert.equal(JSON.stringify(e.workspace.nodes), before);
  assert.equal(e.runtime.calls.length, 0);
  e.store.save = original;
});

test("a concurrent child insertion changes the confirmed deletion set before deletion can commit", async (t) => {
  const e = await setup(t);
  const submit = e.scheduler.submit(e.workspace.id, {
    parentId: e.a.id,
    prompt: "new descendant",
    config,
    requestId: randomUUID(),
  });
  const deletion = e.scheduler.deleteNode(e.workspace.id, e.a.id, {
    expectedRevision: 0,
    expectedNodeIds: [e.a.id, e.b.id, e.c.id],
  });
  const child = await submit;
  await assert.rejects(deletion, /运行|删除范围/);
  assert.ok(e.workspace.nodes.some((node) => node.id === child.id));
  await e.finish("new descendant");
  await assert.rejects(
    e.scheduler.deleteNode(e.workspace.id, e.a.id, {
      expectedRevision: 0,
      expectedNodeIds: [e.a.id, e.b.id, e.c.id],
    }),
    /删除范围/,
  );
});

test("an approval from an old revision cannot approve a reused tool ID in a regenerated run", async (t) => {
  const e = await setup(t);
  const node = await e.regenerate(e.a.id, "needs tool");
  await until(() => e.runtime.calls.length === 1);
  const environment = e.runtime.calls[0].environment!;
  const waiting = environment.beforeToolCall({
    id: "old-tool-a",
    name: "write",
    arguments: { path: "new.txt", content: "new action" },
  });
  await until(() => node.toolCalls?.[0].status === "awaiting_approval");
  await assert.rejects(
    e.scheduler.approve(e.workspace.id, node.id, "old-tool-a", "approve", 0),
    /已失效/,
  );
  await assert.rejects(
    e.scheduler.approve(e.workspace.id, node.id, "old-tool-a", "approve"),
    /已失效/,
  );
  assert.equal(node.toolCalls![0].status, "awaiting_approval");
  assert.equal(node.toolCalls![0].authorization, undefined);
  await e.scheduler.approve(
    e.workspace.id,
    node.id,
    "old-tool-a",
    "approve",
    1,
  );
  assert.equal(await waiting, true);
  let executions = 0;
  await environment.executeTool(
    {
      id: "old-tool-a",
      name: "write",
      arguments: { path: "new.txt", content: "new action" },
    },
    async () => {
      executions++;
    },
  );
  assert.equal(executions, 1);
  await e.finish("needs tool");
});

test("node mutation API validates versions and subtree confirmation and exports no hidden run history", async (t) => {
  const e = await setup(t);
  const api = createApi(e.store, e.runtime, e.scheduler);
  const call = async (method: string, path: string, body?: unknown) => {
    const request = Readable.from(
      body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
    ) as IncomingMessage;
    Object.assign(request, {
      method,
      url: `/api/workspaces/${e.workspace.id}${path}`,
      headers: { host: "127.0.0.1:9999", "content-type": "application/json" },
    });
    let status = 0;
    let output = "";
    const response = {
      setHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        output = value;
      },
    } as unknown as ServerResponse;
    assert.equal(await api(request, response), true);
    return { status, output };
  };
  const input = {
    prompt: "api edit",
    config,
    requestId: randomUUID(),
    expectedRevision: 0,
  };
  assert.equal(
    (
      await call("POST", `/nodes/${e.a.id}/regenerate`, {
        ...input,
        expectedRevision: undefined,
      })
    ).status,
    400,
  );
  const regenerated = await call("POST", `/nodes/${e.a.id}/regenerate`, input);
  assert.equal(regenerated.status, 200);
  assert.equal(JSON.parse(regenerated.output).nodeId, e.a.id);
  assert.doesNotMatch(regenerated.output, /previousRuns|OLD_TRANSCRIPT/);
  await e.finish("api edit");
  const markdown = await call("GET", `/export?format=markdown&node=${e.c.id}`);
  assert.match(
    markdown.output,
    /上游已更新，此回答基于修改前的上下文，需重新生成/,
  );
  const exported = await call("GET", "/export");
  assert.equal(exported.status, 200);
  assert.doesNotMatch(
    exported.output,
    /previousRuns|"messages"|OLD_TRANSCRIPT/,
  );
  const stale = await call("DELETE", `/nodes/${e.a.id}`, {
    expectedRevision: 0,
    expectedNodeIds: [e.a.id, e.b.id, e.c.id],
  });
  assert.equal(stale.status, 409);
  const changed = await call("DELETE", `/nodes/${e.a.id}`, {
    expectedRevision: 1,
    expectedNodeIds: [e.a.id],
  });
  assert.equal(changed.status, 409);
  const deleted = await call("DELETE", `/nodes/${e.a.id}`, {
    expectedRevision: 1,
    expectedNodeIds: [e.a.id, e.b.id, e.c.id],
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(
    JSON.parse(deleted.output).workspaces[0].nodes.map(
      (node: StoredNode) => node.id,
    ),
    [e.root.id, e.sibling.id],
  );
});
