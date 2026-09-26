import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ThinkingContent } from "../shared/types.ts";
import { PiRuntime, type Runtime } from "./runtime.ts";
import { snapshotThinking } from "./thinking.ts";
import { Scheduler } from "./scheduler.ts";
import { Store, type StoredNode } from "./store.ts";
import { createWorkspace } from "./seed.ts";
import { importWorkspace } from "./workspace-import.ts";

test("PiRuntime streams native thinking across tool rounds without mixing it into answers", async () => {
  const faux = fauxProvider({
    provider: "openai",
    models: [
      {
        id: "thinking-test",
        reasoning: true,
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    tokensPerSecond: 1000000,
    tokenSize: { min: 1, max: 2 },
  });
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxThinking("先检索相关资料并核对条件。"),
        { type: "text", text: "开始。" },
        fauxToolCall("web_search", { query: "test" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([
      fauxThinking("再核对。"),
      { type: "text", text: "完成。" },
    ]),
  ]);
  const registry = createModels();
  registry.setProvider(faux.provider);
  const runtime = new PiRuntime(registry, {
    async runPlugin() {
      return { text: "Search result", sources: [] };
    },
  });
  const thoughts: ThinkingContent[] = [];
  const answers: string[] = [];
  const result = await runtime.run(
    { model: "openai/thinking-test", thinking: "high" },
    [],
    "Search",
    AbortSignal.timeout(10000),
    (text) => answers.push(text),
    {
      beforeToolCall: async () => true,
      executeTool: async (_call, execute) => execute(),
      onToolUpdate() {},
    },
    {
      autoCompact: false,
      sources: [{ nodeId: "current", revision: 0, messageCount: 0 }],
      onThinking: (thinking) => thoughts.push(thinking),
    },
  );
  assert.ok(
    thoughts.some(
      (item) =>
        item.active && item.text.length < "先检索相关资料并核对条件。".length,
    ),
  );
  assert.deepEqual(thoughts.at(-1), {
    text: "先检索相关资料并核对条件。\n\n再核对。",
    active: false,
  });
  assert.deepEqual(result.thinking, thoughts.at(-1));
  assert.equal(result.response, "开始。完成。");
  assert.ok(
    answers.every(
      (answer) => !answer.includes("检索") && !answer.includes("核对"),
    ),
  );
  assert.equal(faux.state.callCount, 2);
});

test("older transcripts expose readable thinking without exposing provider signatures", () => {
  const message = fauxAssistantMessage([
    {
      type: "thinking",
      thinking: "可阅读内容",
      thinkingSignature: "private-signature",
    },
    { type: "text", text: "答案" },
    { type: "thinking", thinking: "", thinkingSignature: "encrypted-only" },
  ]);
  assert.deepEqual(snapshotThinking({ status: "completed" }, [message]), {
    text: "可阅读内容",
    active: false,
  });
  assert.equal(
    snapshotThinking({ status: "completed" }, [
      fauxAssistantMessage("没有思考"),
    ]),
    undefined,
  );
});

test("scheduler persists thinking independently, restores it, and clears it on regeneration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "panel-thinking-"));
  const store = new Store(directory);
  await store.init(false);
  const workspace = createWorkspace("思考测试", "");
  store.data.workspaces.push(workspace);
  let release!: () => void;
  let runs = 0;
  const runtime: Runtime = {
    models: () => [
      {
        id: "demo/thinking",
        name: "Test",
        provider: "demo",
        providerName: "Test",
        available: true,
        demo: true,
        contextWindow: 128000,
        thinkingLevels: ["high"],
      },
    ],
    async run(
      _config,
      _history,
      _prompt,
      signal,
      onText,
      _environment,
      options,
    ) {
      if (++runs > 1) return { messages: [], response: "新答案" };
      options?.onThinking?.({ text: "保留这段思考", active: true });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      signal.throwIfAborted();
      options?.onThinking?.({ text: "保留这段思考", active: false });
      onText("答案");
      return { messages: [], response: "答案" };
    },
  };
  const scheduler = new Scheduler(store, runtime);
  t.after(async () => {
    release?.();
    scheduler.shutdown();
    await delay(30);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  });
  const node = await scheduler.submit(workspace.id, {
    parentId: workspace.nodes[0].id,
    prompt: "问题",
    config: { model: "demo/thinking", thinking: "high" },
    requestId: "thinking-1",
  });
  for (let i = 0; i < 200 && !release; i++) await delay(5);
  assert.ok(release);
  const streaming = store.snapshot().workspaces[0].nodes[1];
  assert.deepEqual(streaming.thinking, { text: "保留这段思考", active: true });
  assert.equal(streaming.response, "");
  release();
  for (let i = 0; i < 200 && node.status === "running"; i++) await delay(5);
  assert.equal(node.status, "completed");
  await store.save();
  const loaded = new Store(directory);
  await loaded.init(false);
  assert.deepEqual(loaded.snapshot().workspaces[0].nodes[1].thinking, {
    text: "保留这段思考",
    active: false,
  });
  const imported = importWorkspace({ version: 1, workspace });
  assert.deepEqual(imported.nodes[1].thinking, {
    text: "保留这段思考",
    active: false,
  });
  const next = await scheduler.regenerate(workspace.id, node.id, {
    prompt: node.prompt,
    config: node.config,
    expectedRevision: 0,
    requestId: "thinking-2",
  });
  assert.equal(next.thinking, undefined);
  assert.equal(
    (next as StoredNode).previousRuns?.at(-1)?.thinking?.text,
    "保留这段思考",
  );
});
