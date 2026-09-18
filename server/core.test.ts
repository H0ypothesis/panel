import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import {
  ancestorPath,
  DEFAULT_CONFIG,
  type AppState,
  type ModelOption,
  type RunConfig,
} from "../shared/types.ts";
import { createApi } from "./api.ts";
import { buildContext } from "./context.ts";
import { PiRuntime, type Runtime, type RunResult } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type StoredNode } from "./store.ts";

class ControlledRuntime implements Runtime {
  calls: { prompt: string; history: Message[]; config: RunConfig }[] = [];
  releases = new Map<string, () => void>();
  models(): ModelOption[] {
    return [
      {
        id: "demo/pi-demo",
        name: "Test",
        provider: "demo",
        providerName: "Test",
        available: true,
        demo: true,
        thinkingLevels: ["off", "medium", "high"],
        contextWindow: 100000,
      },
    ];
  }
  async run(
    config: RunConfig,
    history: Message[],
    prompt: string,
    signal: AbortSignal,
    onText: (text: string) => void,
  ): Promise<RunResult> {
    signal.throwIfAborted();
    this.calls.push({
      prompt,
      history: structuredClone(history),
      config: { ...config },
    });
    onText(`partial:${prompt}`);
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.releases.delete(prompt);
        reject(new Error("aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.releases.set(prompt, () => {
        signal.removeEventListener("abort", abort);
        this.releases.delete(prompt);
        resolve();
      });
    });
    signal.throwIfAborted();
    const response = `answer:${prompt}`;
    return {
      response,
      messages: [
        { role: "user", content: prompt, timestamp: Date.now() },
        fauxAssistantMessage(response),
      ],
    };
  }
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for state transition");
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "panel-test-"));
  const store = new Store(directory);
  await store.init(false);
  const workspace = createWorkspace("Root Topic", "Root Background");
  store.data.workspaces.push(workspace);
  const runtime = new ControlledRuntime();
  const scheduler = new Scheduler(store, runtime, 2);
  const submit = (
    prompt: string,
    parentId = workspace.nodes[0].id,
    config = DEFAULT_CONFIG,
    requestId = randomUUID(),
  ) => scheduler.submit(workspace.id, { prompt, parentId, config, requestId });
  const cleanup = async () => {
    scheduler.shutdown();
    await delay(30);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  };
  return { directory, store, workspace, runtime, scheduler, submit, cleanup };
}

test("branches inherit only their ancestors and preserve Pi transcripts without mutation", async () => {
  const env = await setup();
  try {
    const a = await env.submit("A");
    const sibling = await env.submit("SIBLING_SECRET");
    await until(() => env.runtime.calls.length === 2);
    env.runtime.releases.get("A")!();
    env.runtime.releases.get("SIBLING_SECRET")!();
    await until(
      () => a.status === "completed" && sibling.status === "completed",
    );
    const b = await env.submit("B", a.id);
    await until(() => env.runtime.calls.length === 3);
    const inherited = env.runtime.calls[2].history;
    assert.match(JSON.stringify(inherited), /Root Background/);
    assert.match(JSON.stringify(inherited), /answer:A/);
    assert.doesNotMatch(JSON.stringify(inherited), /SIBLING_SECRET/);
    assert.deepEqual(b.contextIds, [env.workspace.nodes[0].id, a.id]);
    assert.equal(
      inherited.filter((message) => message.role === "assistant").length,
      1,
    );
    inherited.splice(0);
    assert.equal(
      buildContext(env.store.workspace(env.workspace.id), a.id).messages.length,
      3,
    );
    env.runtime.releases.get("B")!();
    await until(() => b.status === "completed");
    const backtrack = await env.submit("BACKTRACK", env.workspace.nodes[0].id);
    await until(() => env.runtime.calls.length === 4);
    assert.doesNotMatch(
      JSON.stringify(env.runtime.calls[3].history),
      /answer:A|answer:B|SIBLING_SECRET/,
    );
    env.runtime.releases.get("BACKTRACK")!();
    await until(() => backtrack.status === "completed");
  } finally {
    await env.cleanup();
  }
});

test("parallel runs have independent cancellation; FIFO queue advances and queued cancellation never calls the model", async () => {
  const env = await setup();
  try {
    const a = await env.submit("A");
    const b = await env.submit("B");
    const c = await env.submit("C");
    const d = await env.submit("D");
    await until(() => env.runtime.calls.length === 2);
    assert.equal(a.status, "running");
    assert.equal(b.status, "running");
    assert.equal(c.status, "queued");
    await env.scheduler.cancel(env.workspace.id, d.id);
    await env.scheduler.cancel(env.workspace.id, a.id);
    await until(() => env.runtime.calls.length === 3);
    assert.equal(a.status, "cancelled");
    assert.equal(b.status, "running");
    assert.equal(c.status, "running");
    assert.deepEqual(
      env.runtime.calls.map((call) => call.prompt),
      ["A", "B", "C"],
    );
    env.runtime.releases.get("B")!();
    env.runtime.releases.get("C")!();
    await until(() => b.status === "completed" && c.status === "completed");
    assert.equal(d.status, "cancelled");
    assert.match(a.response, /partial:A/);
  } finally {
    await env.cleanup();
  }
});

test("idempotency prevents duplicate calls; config is a per-node immutable snapshot", async () => {
  const env = await setup();
  try {
    const requestId = randomUUID();
    const config: RunConfig = { ...DEFAULT_CONFIG, thinking: "high" };
    const [a, b] = await Promise.all([
      env.submit("A", undefined, config, requestId),
      env.submit("A", undefined, config, requestId),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(env.workspace.nodes.length, 2);
    config.thinking = "off";
    await until(() => env.runtime.calls.length === 1);
    assert.equal(a.config.thinking, "high");
    assert.equal(env.runtime.calls[0].config.thinking, "high");
    await assert.rejects(
      env.submit("DIFFERENT", undefined, DEFAULT_CONFIG, requestId),
      /请求 ID/,
    );
    env.runtime.releases.get("A")!();
    await until(() => a.status === "completed");
  } finally {
    await env.cleanup();
  }
});

test("invalid model, unsupported thinking, incomplete and cross-workspace parents cannot launch", async () => {
  const env = await setup();
  try {
    await assert.rejects(
      env.submit("A", undefined, { ...DEFAULT_CONFIG, model: "missing/model" }),
      /未配置/,
    );
    await assert.rejects(
      env.submit("A", undefined, { ...DEFAULT_CONFIG, thinking: "max" }),
      /思考强度/,
    );
    await assert.rejects(env.submit("A", "missing-parent"), /上下文节点不存在/);
    const other = createWorkspace("Other", "PRIVATE");
    env.store.data.workspaces.push(other);
    await assert.rejects(
      env.submit("A", other.nodes[0].id),
      /上下文节点不存在/,
    );
    const a = await env.submit("A");
    await assert.rejects(env.submit("B", a.id), /尚未完成/);
    assert.equal(env.workspace.nodes.length, 2);
  } finally {
    await env.cleanup();
  }
});

test("persistence retains concurrent results and restarts never re-run unfinished calls", async () => {
  const env = await setup();
  try {
    const a = await env.submit("A");
    const b = await env.submit("B");
    await until(() => env.runtime.calls.length === 2);
    env.runtime.releases.get("A")!();
    await until(() => a.status === "completed");
    await env.store.save();
    const restarted = new Store(env.directory);
    await restarted.init();
    const nodes = restarted.workspace(env.workspace.id).nodes;
    assert.equal(nodes.find((node) => node.id === a.id)?.status, "completed");
    assert.equal(nodes.find((node) => node.id === b.id)?.status, "failed");
    assert.match(
      nodes.find((node) => node.id === b.id)?.error ?? "",
      /服务重启/,
    );
    assert.equal(nodes.find((node) => node.id === a.id)?.messages?.length, 2);
    assert.equal(
      "messages" in restarted.snapshot().workspaces[0].nodes[1],
      false,
    );
    const persisted = JSON.parse(
      await readFile(join(env.directory, "state.json"), "utf8"),
    );
    assert.equal(persisted.workspaces[0].nodes.length, 3);
  } finally {
    await env.cleanup();
  }
});

test("corrupt storage is reported instead of silently replacing user data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "panel-corrupt-"));
  try {
    await writeFile(join(directory, "state.json"), "{bad-data");
    await assert.rejects(new Store(directory).init());
    assert.equal(
      await readFile(join(directory, "state.json"), "utf8"),
      "{bad-data",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("graceful shutdown preserves interrupted status for active and queued nodes", async () => {
  const env = await setup();
  try {
    const a = await env.submit("A");
    const b = await env.submit("B");
    const c = await env.submit("C");
    await until(() => env.runtime.calls.length === 2);
    env.scheduler.shutdown();
    await delay(30);
    await env.store.save();
    for (const node of [a, b, c]) {
      assert.equal(node.status, "failed");
      assert.match(node.error ?? "", /服务关闭/);
    }
    const restarted = new Store(env.directory);
    await restarted.init();
    assert.notEqual(restarted.instanceId, env.store.instanceId);
    assert.equal(
      restarted
        .workspace(env.workspace.id)
        .nodes.filter((node) => node.status === "failed").length,
      3,
    );
    assert.equal(env.runtime.calls.length, 2);
  } finally {
    await env.cleanup();
  }
});

test("cycle detection and missing ancestors fail explicitly", () => {
  const workspace = createWorkspace("Root", "");
  const root = workspace.nodes[0];
  const node: StoredNode = {
    ...root,
    id: "a",
    parentId: "b",
    status: "completed",
  };
  const other: StoredNode = { ...node, id: "b", parentId: "a" };
  assert.throws(() => ancestorPath([root, node, other], "a"), /循环/);
  assert.throws(() => ancestorPath([root, node], "a"), /不存在/);
});

test("HTTP validates origin, node config, coordinates, and exports the chosen path", async () => {
  const env = await setup();
  const handler = createApi(env.store, env.runtime, env.scheduler);
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  try {
    const blocked = await fetch(`${base}/workspaces`, {
      method: "POST",
      headers: {
        Origin: "https://evil.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: "Bad" }),
    });
    assert.equal(blocked.status, 403);
    const badConfig = await fetch(
      `${base}/workspaces/${env.workspace.id}/nodes`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentId: env.workspace.nodes[0].id,
          prompt: "hello",
          config: null,
        }),
      },
    );
    assert.equal(badConfig.status, 400);
    const positioned = await fetch(
      `${base}/workspaces/${env.workspace.id}/nodes/${env.workspace.nodes[0].id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: { x: 500, y: 100 } }),
      },
    );
    assert.equal(positioned.status, 200);
    assert.equal(env.workspace.nodes[0].position.x, 500);
    const invalid = await fetch(
      `${base}/workspaces/${env.workspace.id}/layout`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          positions: { [env.workspace.nodes[0].id]: { x: "infinity", y: 0 } },
        }),
      },
    );
    assert.equal(invalid.status, 400);
    const exported = await fetch(
      `${base}/workspaces/${env.workspace.id}/export?format=markdown&node=${env.workspace.nodes[0].id}`,
    );
    assert.equal(exported.status, 200);
    assert.match(await exported.text(), /Root Background/);
    const state = await fetch(`${base}/state`);
    assert.equal(((await state.json()) as AppState).workspaces.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await env.cleanup();
  }
});

test("actual Pi Agent streams demo output and can be aborted without credentials", async () => {
  const runtime = new PiRuntime();
  assert.ok(runtime.models().some((model) => model.provider === "anthropic"));
  const controller = new AbortController();
  let partial = "";
  await assert.rejects(
    runtime.run(
      DEFAULT_CONFIG,
      [],
      "测试独立取消",
      controller.signal,
      (text) => {
        partial = text;
        controller.abort();
      },
    ),
  );
  assert.ok(partial.length > 0);
  const result = await runtime.run(
    DEFAULT_CONFIG,
    [{ role: "user", content: "这是根背景", timestamp: Date.now() }],
    "测试真实 Pi 流程",
    new AbortController().signal,
    () => {},
  );
  assert.match(result.response, /演示模型/);
  assert.match(result.response, /1 条用户消息/);
  assert.equal(result.messages[0].role, "user");
  assert.equal(result.messages[1].role, "assistant");
  assert.equal(result.usage, undefined);
});
