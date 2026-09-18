import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import type {
  ContextCheckpoint,
  ModelOption,
  RunConfig,
} from "../shared/types.ts";
import { layoutTree } from "../shared/types.ts";
import { ContextCompactor } from "./compaction.ts";
import { buildContext } from "./context.ts";
import { contextUsageForNode } from "../shared/context-usage.ts";
import { createApi } from "./api.ts";
import type { RunContextOptions, RunEnvironment, Runtime } from "./runtime.ts";
import { NodeMutationConflict, Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type StoredNode, type StoredWorkspace } from "./store.ts";

const config: RunConfig = { model: "test/context", thinking: "off" };
class ContextRuntime implements Runtime {
  summaries = 0;
  requests: Message[][] = [];
  summaryGate?: Promise<void>;
  models(): ModelOption[] {
    return [
      {
        id: config.model,
        name: "Context test",
        provider: "test",
        providerName: "Test",
        available: true,
        demo: false,
        thinkingLevels: ["off"],
        contextWindow: 16000,
      },
    ];
  }
  compactor(options: RunContextOptions, currentPromptIndex?: number) {
    return new ContextCompactor({
      ...options,
      model: config.model,
      thinking: "off",
      contextWindow: 16000,
      maxOutputTokens: 2000,
      systemPrompt: "test",
      tools: [],
      currentPromptIndex,
      summarize: async (_messages, _previous, signal) => {
        this.summaries++;
        if (this.summaryGate) await this.summaryGate;
        signal.throwIfAborted();
        return {
          text: "目标：继续完成用户工作。进度：已读历史。约束：保留原始数据。下一步：继续。",
        };
      },
    });
  }
  async prepareContext(
    _config: RunConfig,
    history: Message[],
    signal: AbortSignal,
    options: RunContextOptions,
  ) {
    let checkpoint: ContextCheckpoint | undefined;
    await this.compactor({
      ...options,
      onCheckpoint: async (value) => {
        checkpoint = value;
        await options.onCheckpoint?.(value);
      },
    }).prepare(history, signal, true);
    return checkpoint;
  }
  async run(
    _config: RunConfig,
    history: Message[],
    prompt: string,
    signal: AbortSignal,
    _onText: (value: string) => void,
    _env?: RunEnvironment,
    options?: RunContextOptions,
  ) {
    assert.ok(options);
    const messages: Message[] = [
      { role: "user", content: prompt, timestamp: Date.now() },
    ];
    await options.onMessages?.(messages);
    const input = await this.compactor(options, history.length).prepare(
      [...history, ...messages],
      signal,
    );
    this.requests.push(structuredClone(input));
    messages.push(fauxAssistantMessage("Done"));
    await options.onMessages?.(messages);
    return { messages, response: "Done" };
  }
}

function completed(
  workspace: StoredWorkspace,
  parentId: string,
  text: string,
): StoredNode {
  const node: StoredNode = {
    ...workspace.nodes[0],
    id: randomUUID(),
    parentId,
    status: "completed",
    prompt: "请分析",
    response: text,
    config,
    contextIds: [],
    messages: [
      { role: "user", content: "请分析", timestamp: 1 },
      fauxAssistantMessage(text),
    ],
  };
  workspace.nodes.push(node);
  return node;
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for context state");
}

async function afterRunSettles<T>(mutate: () => Promise<T>): Promise<T> {
  for (let i = 0; i < 200; i++) {
    try {
      return await mutate();
    } catch (error) {
      if (
        !(error instanceof NodeMutationConflict) ||
        !error.message.includes("收尾")
      )
        throw error;
      await delay(10);
    }
  }
  assert.fail("Timed out waiting for scheduler cleanup");
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "panel-context-integration-"));
  const store = new Store(directory);
  await store.init(false);
  const workspace = createWorkspace("Root", "Preserve root background");
  store.data.workspaces.push(workspace);
  const runtime = new ContextRuntime();
  const scheduler = new Scheduler(store, runtime);
  return {
    directory,
    store,
    workspace,
    runtime,
    scheduler,
    async close() {
      scheduler.shutdown();
      await delay(30);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("long branch compacts without modifying its originals or a short sibling path", async () => {
  const env = await setup();
  try {
    const a = completed(
      env.workspace,
      env.workspace.nodes[0].id,
      "共同祖先的完整信息",
    );
    const long = completed(
      env.workspace,
      a.id,
      "Long historical evidence. ".repeat(7000),
    );
    const before = structuredClone(long.messages);
    const running = await env.scheduler.submit(env.workspace.id, {
      parentId: long.id,
      prompt: "继续长分支",
      config,
      requestId: randomUUID(),
    });
    await until(() => ["completed", "failed"].includes(running.status));
    assert.equal(running.status, "completed", running.error);
    assert.equal(running.contextState?.status, "compacted");
    assert.ok(running.compactions?.length);
    assert.deepEqual(long.messages, before);
    const sibling = await env.scheduler.submit(env.workspace.id, {
      parentId: a.id,
      prompt: "短分支",
      config,
      requestId: randomUUID(),
    });
    await until(() => sibling.status === "completed");
    assert.equal(sibling.contextState?.status, "full");
    assert.equal(sibling.compactions, undefined);
    assert.match(
      JSON.stringify(env.runtime.requests.at(-1)),
      /共同祖先的完整信息/,
    );
    assert.doesNotMatch(
      JSON.stringify(env.runtime.requests.at(-1)),
      /Long historical evidence/,
    );
    assert.equal(running.messages?.length, 2);
    assert.equal(buildContext(env.workspace, long.id).messages.length, 5);
  } finally {
    await env.close();
  }
});

test("scheduler publishes streaming context output and replaces it with the final per-request usage", async () => {
  const env = await setup();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  env.runtime.run = async (
    _config,
    _history,
    prompt,
    _signal,
    _onText,
    _environment,
    options,
  ) => {
    assert.ok(options);
    const now = Date.now();
    await options.onState?.({
      status: "full",
      updatedAt: now,
      inputTokens: 1000,
      contextWindow: 16000,
    });
    options.onRequestUsage?.({
      inputTokens: 1000,
      outputTokens: 50,
      timestamp: now + 1,
      estimated: true,
    });
    await gate;
    options.onRequestUsage?.({
      inputTokens: 1200,
      outputTokens: 250,
      timestamp: now + 1,
    });
    const answer = fauxAssistantMessage("done");
    answer.provider = "test";
    answer.model = "context";
    answer.timestamp = now + 1;
    answer.usage = {
      ...answer.usage,
      input: 1200,
      output: 250,
      totalTokens: 1450,
    };
    const messages: Message[] = [
      { role: "user", content: prompt, timestamp: now },
      answer,
    ];
    await options.onMessages?.(messages);
    return { messages, response: "done" };
  };
  try {
    const node = await env.scheduler.submit(env.workspace.id, {
      parentId: env.workspace.nodes[0].id,
      prompt: "continue",
      config,
      requestId: randomUUID(),
    });
    await until(() => node.lastRequestUsage?.outputTokens === 50);
    const streaming = env.store
      .snapshot()
      .workspaces[0].nodes.find((item) => item.id === node.id)!;
    assert.equal(contextUsageForNode(streaming, 10, 16000).tokens, 1050);
    assert.equal(contextUsageForNode(streaming, 10, 16000).source, "estimate");
    finish();
    await until(() => node.status === "completed");
    const completed = env.store
      .snapshot()
      .workspaces[0].nodes.find((item) => item.id === node.id)!;
    assert.equal(contextUsageForNode(completed, 10, 16000).tokens, 1450);
    assert.equal(contextUsageForNode(completed, 10, 16000).source, "provider");
    const restored = new Store(env.directory);
    await restored.init(false);
    const saved = restored
      .snapshot()
      .workspaces[0].nodes.find((item) => item.id === node.id)!;
    assert.equal(contextUsageForNode(saved, 10, 16000).tokens, 1450);
    assert.equal(node.messages?.length, 2);
  } finally {
    finish();
    await env.close();
  }
});

test("manual preparation is idempotent and only explicit next-run selection applies below threshold", async () => {
  const env = await setup();
  try {
    const a = completed(
      env.workspace,
      env.workspace.nodes[0].id,
      "original detail ".repeat(400),
    );
    const request = { config, expectedRevision: 0, requestId: randomUUID() };
    const [first, again] = await Promise.all([
      env.scheduler.compactContext(env.workspace.id, a.id, request),
      env.scheduler.compactContext(env.workspace.id, a.id, request),
    ]);
    assert.ok(first);
    assert.equal(first.id, again?.id);
    assert.equal(env.runtime.summaries, 1);
    assert.equal(a.contextState, undefined);
    assert.equal(a.compactions, undefined);
    const plain = await env.scheduler.submit(env.workspace.id, {
      parentId: a.id,
      prompt: "普通续写",
      config,
      requestId: randomUUID(),
    });
    await until(() => plain.status === "completed");
    assert.equal(plain.contextState?.status, "full");
    const selected = await env.scheduler.submit(env.workspace.id, {
      parentId: a.id,
      prompt: "选用摘要",
      config,
      requestId: randomUUID(),
      contextCheckpointId: first.id,
    });
    await until(() => ["completed", "failed"].includes(selected.status));
    assert.equal(selected.status, "completed", selected.error);
    assert.equal(selected.contextState?.status, "compacted");
    assert.equal(env.runtime.summaries, 1);
    assert.equal(selected.compactions?.[0].id, first.id);
    await assert.rejects(
      env.scheduler.submit(env.workspace.id, {
        parentId: env.workspace.nodes[0].id,
        prompt: "错误路径",
        config,
        requestId: randomUUID(),
        contextCheckpointId: first.id,
      }),
      /不属于|失效/,
    );
    a.revision = 1;
    await assert.rejects(
      env.scheduler.submit(env.workspace.id, {
        parentId: a.id,
        prompt: "旧版本",
        config,
        requestId: randomUUID(),
        contextCheckpointId: first.id,
      }),
      /失效/,
    );
  } finally {
    await env.close();
  }
});

test("manual cancellation cannot publish a late summary and does not cancel the completed answer", async () => {
  const env = await setup();
  let release = () => {};
  try {
    const a = completed(
      env.workspace,
      env.workspace.nodes[0].id,
      "original evidence ".repeat(400),
    );
    env.runtime.summaryGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = env.scheduler.compactContext(env.workspace.id, a.id, {
      config,
      expectedRevision: 0,
      requestId: randomUUID(),
    });
    const rejection = assert.rejects(task);
    await until(() => env.runtime.summaries === 1);
    await assert.rejects(
      env.scheduler.regenerate(env.workspace.id, a.id, {
        config,
        prompt: "changed",
        expectedRevision: 0,
        requestId: randomUUID(),
      }),
      /运行|等待/,
    );
    await env.scheduler.cancel(env.workspace.id, a.id);
    release();
    await rejection;
    assert.equal(a.status, "completed");
    assert.equal(a.preparedContextState?.status, "cancelled");
    assert.equal(a.preparedCompaction, undefined);
    assert.equal(a.messages?.length, 2);
  } finally {
    release();
    await env.close();
  }
});

test("older manual request IDs remain idempotent after newer preparations and restart", async () => {
  const env = await setup();
  try {
    const a = completed(
      env.workspace,
      env.workspace.nodes[0].id,
      "original detail ".repeat(500),
    );
    const firstRequest = {
      config,
      expectedRevision: 0,
      requestId: randomUUID(),
    };
    const first = await env.scheduler.compactContext(
      env.workspace.id,
      a.id,
      firstRequest,
    );
    const second = await env.scheduler.compactContext(env.workspace.id, a.id, {
      ...firstRequest,
      requestId: randomUUID(),
    });
    assert.ok(first && second);
    assert.notEqual(first.id, second.id);
    assert.equal(
      (await env.scheduler.compactContext(env.workspace.id, a.id, firstRequest))
        ?.id,
      first.id,
    );
    assert.equal(env.runtime.summaries, 2);
    const restarted = new Store(env.directory);
    await restarted.init(false);
    const scheduler = new Scheduler(restarted, env.runtime);
    try {
      assert.equal(
        (await scheduler.compactContext(env.workspace.id, a.id, firstRequest))
          ?.id,
        first.id,
      );
      assert.equal(env.runtime.summaries, 2);
    } finally {
      scheduler.shutdown();
    }
  } finally {
    await env.close();
  }
});

test("manual success state is published with its checkpoint, never before it", async () => {
  const env = await setup();
  let release = () => {};
  try {
    const a = completed(
      env.workspace,
      env.workspace.nodes[0].id,
      "old details ".repeat(500),
    );
    let signalled = false;
    const prepare = env.runtime.prepareContext.bind(env.runtime);
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    env.runtime.prepareContext = async (...args) => {
      const checkpoint = await prepare(...args);
      signalled = true;
      await gate;
      return checkpoint;
    };
    const pending = env.scheduler.compactContext(env.workspace.id, a.id, {
      config,
      expectedRevision: 0,
      requestId: randomUUID(),
    });
    await until(() => signalled);
    assert.equal(a.preparedContextState?.status, "compacting");
    assert.equal(a.preparedCompaction, undefined);
    release();
    const checkpoint = await pending;
    assert.equal(a.preparedContextState?.status, "compacted");
    assert.equal(
      env.store.snapshot().workspaces[0].nodes.find((node) => node.id === a.id)
        ?.preparedCompaction?.id,
      checkpoint?.id,
    );
  } finally {
    release();
    await env.close();
  }
});

test("regenerate and retry reject IDs already used by manual preparation without changing original runs", async () => {
  const env = await setup();
  try {
    const a = completed(
      env.workspace,
      env.workspace.nodes[0].id,
      "original preparation evidence ".repeat(400),
    );
    const usedRequestId = randomUUID();
    await env.scheduler.compactContext(env.workspace.id, a.id, {
      config,
      expectedRevision: 0,
      requestId: usedRequestId,
    });
    const failed = completed(
      env.workspace,
      env.workspace.nodes[0].id,
      "original failed response",
    );
    failed.status = "failed";
    const before = structuredClone(env.workspace.nodes);
    await assert.rejects(
      env.scheduler.regenerate(env.workspace.id, a.id, {
        config,
        prompt: "must not replace the original question",
        expectedRevision: 0,
        requestId: usedRequestId,
      }),
      /请求 ID 已用于摘要任务/,
    );
    await assert.rejects(
      env.scheduler.retry(env.workspace.id, failed.id, {
        expectedRevision: 0,
        requestId: usedRequestId,
      }),
      /请求 ID 已用于摘要任务/,
    );
    assert.deepEqual(env.workspace.nodes, before);
    assert.equal(a.revision ?? 0, 0);
    assert.equal(failed.revision ?? 0, 0);
    assert.equal(env.runtime.summaries, 1);
    assert.equal(env.runtime.requests.length, 0);
  } finally {
    await env.close();
  }
});

test("restart interrupts preparation while preserving checkpoint records and raw transcripts", async () => {
  const env = await setup();
  try {
    const a = completed(
      env.workspace,
      env.workspace.nodes[0].id,
      "original evidence ".repeat(400),
    );
    const checkpoint = await env.scheduler.compactContext(
      env.workspace.id,
      a.id,
      { config, expectedRevision: 0, requestId: randomUUID() },
    );
    a.contextState = { status: "compacting", updatedAt: Date.now() };
    a.preparedContextState = { status: "compacting", updatedAt: Date.now() };
    await env.scheduler.configureWorkspace(env.workspace.id, {
      autoCompact: false,
    });
    await env.store.save();
    const restarted = new Store(env.directory);
    await restarted.init(false);
    const restored = restarted.workspace(env.workspace.id);
    assert.equal(restored.autoCompact, false);
    const node = restored.nodes.find((item) => item.id === a.id)!;
    assert.equal(node.preparedContextState?.status, "failed");
    assert.match(node.contextState?.error ?? "", /重启/);
    assert.equal(node.preparedCompaction?.id, checkpoint?.id);
    assert.deepEqual(node.messages, a.messages);
    assert.equal(env.runtime.summaries, 1);
  } finally {
    await env.close();
  }
});

test("HTTP validates compression settings and JSON export retains original messages with summaries", async () => {
  const env = await setup();
  const handler = createApi(env.store, env.runtime, env.scheduler);
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/workspaces/${env.workspace.id}`;
  try {
    const a = completed(
      env.workspace,
      env.workspace.nodes[0].id,
      "retained original ".repeat(400),
    );
    const bad = await fetch(base, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoCompact: "yes" }),
    });
    assert.equal(bad.status, 400);
    const compacted = await fetch(`${base}/nodes/${a.id}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config,
        expectedRevision: 0,
        requestId: randomUUID(),
      }),
    });
    assert.equal(compacted.status, 200, await compacted.clone().text());
    const exported = (await (await fetch(`${base}/export`)).json()) as {
      workspace: StoredWorkspace;
    };
    const node = exported.workspace.nodes.find((item) => item.id === a.id)!;
    assert.deepEqual(node.messages, a.messages);
    assert.equal(node.preparedCompaction?.id, a.preparedCompaction?.id);
    assert.equal("preparationRequest" in node, false);
    for (const selection of [
      { contextMode: "raw", contextCheckpointId: a.preparedCompaction!.id },
      { contextMode: "invalid" },
    ]) {
      const result = await fetch(`${base}/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentId: a.id,
          prompt: "validate branch origin",
          config,
          requestId: randomUUID(),
          ...selection,
        }),
      });
      assert.equal(result.status, 400);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await env.close();
  }
});

test("compression origins preserve summary descendants and independent raw branches", async () => {
  const env = await setup();
  try {
    const parent = completed(
      env.workspace,
      env.workspace.nodes[0].id,
      "UNCOMPRESSED_EVIDENCE ".repeat(400),
    );
    const original = structuredClone(parent.messages);
    const checkpoint = await env.scheduler.compactContext(
      env.workspace.id,
      parent.id,
      {
        config,
        expectedRevision: 0,
        requestId: randomUUID(),
      },
    );
    assert.ok(checkpoint);
    const selected = await env.scheduler.submit(env.workspace.id, {
      parentId: parent.id,
      prompt: "从圆点继续",
      config,
      requestId: randomUUID(),
      contextCheckpointId: checkpoint.id,
    });
    await until(() => selected.status === "completed");
    assert.equal(selected.requestedContextCheckpointId, checkpoint.id);
    assert.equal(selected.effectiveContextCheckpointId, checkpoint.id);
    assert.equal(selected.position.x, parent.position.x + 500);
    const descendant = await env.scheduler.submit(env.workspace.id, {
      parentId: selected.id,
      prompt: "延续摘要路径",
      config,
      requestId: randomUUID(),
    });
    await until(() => descendant.status === "completed");
    assert.equal(descendant.requestedContextCheckpointId, undefined);
    assert.equal(descendant.effectiveContextCheckpointId, checkpoint.id);
    assert.equal(descendant.contextState?.status, "compacted");
    assert.match(JSON.stringify(env.runtime.requests.at(-1)), /<summary>/);
    const positions = layoutTree(env.workspace.nodes);
    assert.equal(
      positions.get(selected.id)!.x - positions.get(parent.id)!.x,
      500,
    );
    assert.equal(
      positions.get(descendant.id)!.x - positions.get(selected.id)!.x,
      360,
    );
    const rawInput = {
      parentId: parent.id,
      prompt: "从原卡片继续",
      config,
      requestId: randomUUID(),
      contextMode: "raw" as const,
    };
    const raw = await env.scheduler.submit(env.workspace.id, rawInput);
    await until(() => raw.status === "completed");
    assert.equal(raw.contextState?.status, "full");
    assert.equal(raw.contextAutoCompact, false);
    assert.equal(raw.effectiveContextMode, "raw");
    assert.equal(raw.effectiveContextCheckpointId, undefined);
    assert.equal(raw.position.x, parent.position.x + 360);
    assert.match(
      JSON.stringify(env.runtime.requests.at(-1)),
      /UNCOMPRESSED_EVIDENCE/,
    );
    assert.doesNotMatch(
      JSON.stringify(env.runtime.requests.at(-1)),
      /<summary>/,
    );
    assert.equal(
      (await env.scheduler.submit(env.workspace.id, rawInput)).id,
      raw.id,
    );
    await assert.rejects(
      env.scheduler.submit(env.workspace.id, {
        ...rawInput,
        contextMode: undefined,
      }),
      /请求 ID/,
    );
    const rawChild = await env.scheduler.submit(env.workspace.id, {
      parentId: raw.id,
      prompt: "延续原文路径",
      config,
      requestId: randomUUID(),
    });
    await until(() => rawChild.status === "completed");
    assert.equal(rawChild.contextMode, undefined);
    assert.equal(rawChild.effectiveContextMode, "raw");
    assert.equal(rawChild.contextAutoCompact, false);
    assert.equal(rawChild.contextState?.status, "full");
    const reset = await env.scheduler.submit(env.workspace.id, {
      parentId: rawChild.id,
      prompt: "主动进入摘要",
      config,
      requestId: randomUUID(),
      contextCheckpointId: checkpoint.id,
    });
    await until(() => reset.status === "completed");
    assert.equal(reset.effectiveContextMode, undefined);
    assert.equal(reset.effectiveContextCheckpointId, checkpoint.id);
    assert.deepEqual(parent.messages, original);
    assert.equal(env.runtime.summaries, 1);
  } finally {
    await env.close();
  }
});

test("explicit raw context cannot silently adopt a manual summary above the input window", async () => {
  const env = await setup();
  try {
    const parent = completed(
      env.workspace,
      env.workspace.nodes[0].id,
      "too much evidence ".repeat(7000),
    );
    const checkpoint = await env.scheduler.compactContext(
      env.workspace.id,
      parent.id,
      { config, expectedRevision: 0, requestId: randomUUID() },
    );
    assert.ok(checkpoint);
    const raw = await env.scheduler.submit(env.workspace.id, {
      parentId: parent.id,
      prompt: "保留原文",
      config,
      requestId: randomUUID(),
      contextMode: "raw",
    });
    await until(() => raw.status === "failed");
    assert.match(raw.error!, /超过模型可用窗口/);
    assert.equal(raw.compactions, undefined);
    assert.equal(env.runtime.requests.length, 0);
    assert.equal(env.runtime.summaries, 1);
    await assert.rejects(
      env.scheduler.submit(env.workspace.id, {
        parentId: parent.id,
        prompt: "不能二选全选",
        config,
        requestId: randomUUID(),
        contextMode: "raw",
        contextCheckpointId: checkpoint.id,
      }),
      /不能同时/,
    );
  } finally {
    await env.close();
  }
});

test("retry and regeneration retain compression entry choices with idempotent requests", async () => {
  const env = await setup();
  try {
    const parent = completed(
      env.workspace,
      env.workspace.nodes[0].id,
      "original evidence ".repeat(400),
    );
    const checkpoint = await env.scheduler.compactContext(
      env.workspace.id,
      parent.id,
      { config, expectedRevision: 0, requestId: randomUUID() },
    );
    assert.ok(checkpoint);
    const normalRun = env.runtime.run.bind(env.runtime);
    env.runtime.run = async () => {
      throw new Error("temporary failure");
    };
    const selected = await env.scheduler.submit(env.workspace.id, {
      parentId: parent.id,
      prompt: "从摘要继续",
      config,
      requestId: randomUUID(),
      contextCheckpointId: checkpoint.id,
    });
    await until(() => selected.status === "failed");
    env.runtime.run = normalRun;
    const retryInput = { requestId: randomUUID(), expectedRevision: 0 };
    const retried = await afterRunSettles(() =>
      env.scheduler.retry(env.workspace.id, selected.id, retryInput),
    );
    await until(() => retried.status === "completed");
    assert.equal(retried.requestedContextCheckpointId, checkpoint.id);
    assert.equal(retried.effectiveContextCheckpointId, checkpoint.id);
    assert.equal(retried.contextState?.status, "compacted");
    assert.equal(
      (await env.scheduler.retry(env.workspace.id, selected.id, retryInput)).id,
      selected.id,
    );
    const regenerateInput = {
      prompt: "修改问题",
      config,
      requestId: randomUUID(),
      expectedRevision: 1,
    };
    const regenerated = await afterRunSettles(() =>
      env.scheduler.regenerate(env.workspace.id, selected.id, regenerateInput),
    );
    await until(() => regenerated.status === "completed");
    assert.equal(regenerated.requestedContextCheckpointId, checkpoint.id);
    assert.equal(regenerated.effectiveContextCheckpointId, checkpoint.id);
    assert.equal(regenerated.contextState?.status, "compacted");
    assert.equal(
      (
        await env.scheduler.regenerate(
          env.workspace.id,
          selected.id,
          regenerateInput,
        )
      ).id,
      selected.id,
    );
    const rawInput = {
      ...regenerateInput,
      contextMode: "raw" as const,
      expectedRevision: 2,
      requestId: randomUUID(),
    };
    const raw = await afterRunSettles(() =>
      env.scheduler.regenerate(env.workspace.id, selected.id, rawInput),
    );
    await until(() => raw.status === "completed");
    assert.equal(raw.requestedContextCheckpointId, undefined);
    assert.equal(raw.effectiveContextCheckpointId, undefined);
    assert.equal(raw.effectiveContextMode, "raw");
    assert.equal(raw.contextAutoCompact, false);
    assert.equal(
      (await env.scheduler.regenerate(env.workspace.id, selected.id, rawInput))
        .id,
      selected.id,
    );
    const rawAgainInput = {
      ...regenerateInput,
      expectedRevision: 3,
      requestId: randomUUID(),
    };
    const rawAgain = await afterRunSettles(() =>
      env.scheduler.regenerate(env.workspace.id, selected.id, rawAgainInput),
    );
    await until(() => rawAgain.status === "completed");
    assert.equal(rawAgain.contextMode, "raw");
    assert.equal(rawAgain.effectiveContextMode, "raw");
    assert.equal(rawAgain.contextState?.status, "full");
  } finally {
    await env.close();
  }
});

test("snapshot keeps each successful manual summary available after replacements and restart", async () => {
  const env = await setup();
  try {
    const parent = completed(
      env.workspace,
      env.workspace.nodes[0].id,
      "saved history ".repeat(400),
    );
    const first = await env.scheduler.compactContext(
      env.workspace.id,
      parent.id,
      { config, expectedRevision: 0, requestId: randomUUID() },
    );
    const second = await env.scheduler.compactContext(
      env.workspace.id,
      parent.id,
      { config, expectedRevision: 0, requestId: randomUUID() },
    );
    assert.ok(first && second);
    const snapshotNode = env.store
      .snapshot()
      .workspaces[0].nodes.find((node) => node.id === parent.id)!;
    assert.deepEqual(
      snapshotNode.preparedCompactions?.map((item) => item.id),
      [first.id, second.id],
    );
    assert.equal(Object.hasOwn(snapshotNode, "preparationRequests"), false);
    const restarted = new Store(env.directory);
    await restarted.init(false);
    assert.deepEqual(
      restarted
        .snapshot()
        .workspaces[0].nodes.find((node) => node.id === parent.id)
        ?.preparedCompactions?.map((item) => item.id),
      [first.id, second.id],
    );
    const oldEntry = await env.scheduler.submit(env.workspace.id, {
      parentId: parent.id,
      prompt: "使用旧圆点",
      config,
      requestId: randomUUID(),
      contextCheckpointId: first.id,
    });
    await until(() => oldEntry.status === "completed");
    assert.equal(oldEntry.effectiveContextCheckpointId, first.id);
  } finally {
    await env.close();
  }
});

test("summary descendants advance to a later automatic checkpoint without resummarizing the same tail", async () => {
  const env = await setup();
  try {
    const parent = completed(
      env.workspace,
      env.workspace.nodes[0].id,
      "original history ".repeat(400),
    );
    const first = await env.scheduler.compactContext(
      env.workspace.id,
      parent.id,
      { config, expectedRevision: 0, requestId: randomUUID() },
    );
    assert.ok(first);
    const run = env.runtime.run.bind(env.runtime);
    env.runtime.run = async (...args) => {
      const result = await run(...args);
      if (args[2] === "生成很长的尾部") {
        result.messages[result.messages.length - 1] = fauxAssistantMessage(
          "new tail evidence ".repeat(5000),
        );
        await args[6]?.onMessages?.(result.messages);
      }
      return result;
    };
    const selected = await env.scheduler.submit(env.workspace.id, {
      parentId: parent.id,
      prompt: "生成很长的尾部",
      config,
      requestId: randomUUID(),
      contextCheckpointId: first.id,
    });
    await until(() => selected.status === "completed");
    const child = await env.scheduler.submit(env.workspace.id, {
      parentId: selected.id,
      prompt: "处理新增历史",
      config,
      requestId: randomUUID(),
    });
    await until(() => ["completed", "failed"].includes(child.status));
    assert.equal(child.status, "completed", child.error);
    const nextId = child.contextState?.checkpointId;
    assert.ok(nextId);
    assert.notEqual(nextId, first.id);
    assert.equal(env.runtime.summaries, 2);
    const next = await env.scheduler.submit(env.workspace.id, {
      parentId: child.id,
      prompt: "继续已有摘要",
      config,
      requestId: randomUUID(),
    });
    await until(() => ["completed", "failed"].includes(next.status));
    assert.equal(next.status, "completed", next.error);
    assert.equal(next.effectiveContextCheckpointId, nextId);
    assert.equal(next.requestedContextCheckpointId, undefined);
    assert.equal(next.contextState?.checkpointId, nextId);
    assert.equal(env.runtime.summaries, 2);
  } finally {
    await env.close();
  }
});

test("regenerating stale summary descendants repairs their context from the updated parent", async () => {
  const env = await setup();
  try {
    const parent = completed(
      env.workspace,
      env.workspace.nodes[0].id,
      "old source ".repeat(400),
    );
    const checkpoint = await env.scheduler.compactContext(
      env.workspace.id,
      parent.id,
      { config, expectedRevision: 0, requestId: randomUUID() },
    );
    assert.ok(checkpoint);
    const child = await env.scheduler.submit(env.workspace.id, {
      parentId: parent.id,
      prompt: "摘要入口",
      config,
      requestId: randomUUID(),
      contextCheckpointId: checkpoint.id,
    });
    await until(() => child.status === "completed");
    const parentInput = {
      prompt: "更新摘要来源",
      config,
      requestId: randomUUID(),
      expectedRevision: 0,
    };
    const newParent = await afterRunSettles(() =>
      env.scheduler.regenerate(env.workspace.id, parent.id, parentInput),
    );
    await until(() => newParent.status === "completed");
    const preservedOrigins = env.store
      .snapshot()
      .workspaces[0].nodes.find(
        (item) => item.id === parent.id,
      )?.preparedCompactions;
    assert.deepEqual(
      preservedOrigins?.map((item) => item.id),
      [checkpoint.id],
    );
    assert.equal(
      preservedOrigins![0].sources.find((item) => item.nodeId === parent.id)
        ?.revision,
      0,
    );
    assert.equal(newParent.revision, 1);
    assert.equal(newParent.preparedCompaction, undefined);
    assert.equal(newParent.preparationRequests, undefined);
    assert.equal(
      newParent.previousRuns?.[0].preparedCompaction?.id,
      checkpoint.id,
    );
    await assert.rejects(
      env.scheduler.submit(env.workspace.id, {
        parentId: parent.id,
        prompt: "旧圆点仅保留历史，不可作为新入口",
        config,
        requestId: randomUUID(),
        contextCheckpointId: checkpoint.id,
      }),
      /失效/,
    );
    assert.equal(
      env.workspace.nodes.find((item) => item.id === child.id)?.contextStale,
      true,
    );
    const childInput = {
      prompt: "根据新父卡片修复",
      config,
      requestId: randomUUID(),
      expectedRevision: 0,
    };
    const repaired = await afterRunSettles(() =>
      env.scheduler.regenerate(env.workspace.id, child.id, childInput),
    );
    await until(() => repaired.status === "completed");
    assert.equal(repaired.contextStale, false);
    assert.equal(repaired.requestedContextCheckpointId, undefined);
    assert.equal(repaired.effectiveContextCheckpointId, undefined);
    assert.equal(repaired.contextState?.status, "full");
    assert.equal(
      (await env.scheduler.regenerate(env.workspace.id, child.id, childInput))
        .id,
      child.id,
    );
    await assert.rejects(
      env.scheduler.regenerate(env.workspace.id, child.id, {
        ...childInput,
        contextCheckpointId: checkpoint.id,
      }),
      /请求 ID/,
    );
    assert.match(JSON.stringify(env.runtime.requests.at(-1)), /更新摘要来源/);
    assert.doesNotMatch(
      JSON.stringify(env.runtime.requests.at(-1)),
      /old source|<summary>/,
    );
  } finally {
    await env.close();
  }
});
