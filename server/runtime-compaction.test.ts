import assert from "node:assert/strict";
import test from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
  type Message,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
  ContextCheckpoint,
  ContextRequestUsage,
  ContextSource,
  ContextState,
} from "../shared/types.ts";
import {
  PiRuntime,
  type RunContextOptions,
  type RunEnvironment,
} from "./runtime.ts";

const config = { model: "openai/context-test", thinking: "medium" as const };
const summary =
  "SUMMARY: preserve the user's goal, completed work, and remaining steps.";
const signal = () => new AbortController().signal;
const user = (content: string): Message => ({
  role: "user",
  content,
  timestamp: 1,
});
const text = (context: TranscriptContext) => JSON.stringify(context.messages);

function historyFixture() {
  const messages: Message[] = [user("ROOT PROJECT GOAL")];
  const sources: ContextSource[] = [
    { nodeId: "root", revision: 0, messageCount: 1 },
  ];
  for (let index = 0; index < 10; index++) {
    messages.push(user(`OLD QUESTION ${index}: ${"old detail ".repeat(150)}`));
    messages.push(
      fauxAssistantMessage(`OLD ANSWER ${index}: ${"past work ".repeat(150)}`),
    );
    sources.push({ nodeId: `turn-${index}`, revision: 0, messageCount: 2 });
  }
  return { messages, sources };
}

function fixture(contextWindow = 8000, tokenSize = { min: 2000, max: 3000 }) {
  const faux = fauxProvider({
    provider: "openai",
    models: [
      { id: "context-test", reasoning: true, contextWindow, maxTokens: 65536 },
    ],
    tokensPerSecond: 1000000,
    tokenSize,
  });
  const registry = createModels();
  registry.setProvider(faux.provider);
  const runtime = new PiRuntime(registry, {
    async runPlugin() {
      return {
        text: `BIG TOOL RESULT ${"source details ".repeat(2000)}`,
        sources: [],
      };
    },
  });
  return { faux, runtime };
}

function callbacks(sources: ContextSource[]) {
  const states: ContextState[] = [];
  const checkpoints: ContextCheckpoint[] = [];
  const snapshots: Message[][] = [];
  const requestUsages: ContextRequestUsage[] = [];
  const options: RunContextOptions = {
    autoCompact: true,
    sources: [...sources, { nodeId: "current", revision: 0, messageCount: 0 }],
    async onState(state) {
      states.push(structuredClone(state));
    },
    async onCheckpoint(checkpoint) {
      checkpoints.push(structuredClone(checkpoint));
    },
    async onMessages(messages) {
      snapshots.push(structuredClone(messages));
    },
    onRequestUsage(usage) {
      requestUsages.push(structuredClone(usage));
    },
  };
  return { options, states, checkpoints, snapshots, requestUsages };
}

test("runtime compacts only model input, preserves raw transcripts, and separates summary usage", async () => {
  const { faux, runtime } = fixture();
  const history = historyFixture();
  const original = structuredClone(history.messages);
  const observed = callbacks(history.sources);
  let replyUsage = 0;
  faux.setResponses([
    (context, options, _state, model) => {
      assert.equal(model.id, "context-test");
      assert.equal(options?.reasoning, "medium");
      assert.equal(options?.maxTokens, 1600);
      assert.equal(options?.maxRetries, 0);
      assert.equal(options?.timeoutMs, 60000);
      assert.equal(context.messages[0].role, "system");
      const system = context.messages[0];
      if (system.role === "system")
        assert.equal(system.toolsAdded?.length ?? 0, 0);
      assert.match(text(context), /OLD QUESTION 0/);
      assert.equal(observed.snapshots.at(-1)?.[0].role, "user");
      assert.equal(observed.requestUsages.length, 0);
      return fauxAssistantMessage(summary);
    },
    (context, options) => {
      assert.equal(options?.maxTokens, 2000);
      assert.match(text(context), /SUMMARY:/);
      assert.match(text(context), /ROOT PROJECT GOAL/);
      assert.match(text(context), /CURRENT EXACT REQUEST/);
      assert.doesNotMatch(text(context), /OLD QUESTION 0/);
      return fauxAssistantMessage("FINAL RESPONSE");
    },
  ]);
  const result = await runtime.run(
    config,
    history.messages,
    "CURRENT EXACT REQUEST",
    signal(),
    () => {},
    undefined,
    observed.options,
  );
  assert.deepEqual(history.messages, original);
  assert.deepEqual(
    result.messages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.doesNotMatch(JSON.stringify(result.messages), /SUMMARY:/);
  assert.deepEqual(observed.snapshots.at(-1), result.messages);
  const reply = result.messages.at(-1);
  if (reply?.role === "assistant") replyUsage = reply.usage.totalTokens;
  assert.equal(result.usage?.total, replyUsage);
  assert.equal(observed.checkpoints.length, 1);
  assert.ok((observed.checkpoints[0].usage?.total ?? 0) > 0);
  assert.ok(observed.states.some((state) => state.status === "compacting"));
  assert.equal(observed.states.at(-1)?.status, "compacted");
  assert.equal(faux.state.callCount, 2);
  assert.equal(
    observed.requestUsages.at(-1)?.outputTokens,
    reply?.role === "assistant" ? reply.usage.output : undefined,
  );
});

test("runtime enables automatic compaction when no context options are supplied", async () => {
  const { faux, runtime } = fixture();
  faux.setResponses([
    fauxAssistantMessage(summary),
    (context) => {
      assert.match(text(context), /SUMMARY:/);
      return fauxAssistantMessage("done");
    },
  ]);
  const result = await runtime.run(
    config,
    historyFixture().messages,
    "continue",
    signal(),
    () => {},
  );
  assert.equal(result.response, "done");
  assert.equal(faux.state.callCount, 2);
});

test("request usage grows with streamed thinking and text, then uses final provider counts", async () => {
  const { faux, runtime } = fixture(128000, { min: 4, max: 4 });
  const observed = callbacks([
    { nodeId: "root", revision: 0, messageCount: 1 },
  ]);
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxThinking("Reason about the exact user request. ".repeat(8)),
        { type: "text", text: "This is the current answer. ".repeat(12) },
      ],
      { timestamp: 1 },
    ),
  ]);
  const result = await runtime.run(
    config,
    [user("ROOT")],
    "ANSWER WITH REASONING",
    signal(),
    () => {},
    undefined,
    observed.options,
  );
  const streamed = observed.requestUsages.filter((usage) => usage.estimated);
  assert.ok(streamed.length > 5);
  assert.equal(streamed[0].outputTokens, 0);
  assert.ok(new Set(streamed.map((usage) => usage.outputTokens)).size > 5);
  for (let index = 1; index < streamed.length; index++) {
    assert.ok(streamed[index].outputTokens >= streamed[index - 1].outputTokens);
  }
  const lastMessage = result.messages.at(-1);
  assert.ok(lastMessage?.role === "assistant");
  const final = observed.requestUsages.at(-1)!;
  assert.equal(final.estimated, undefined);
  assert.equal(
    final.inputTokens,
    lastMessage.usage.input +
      lastMessage.usage.cacheRead +
      lastMessage.usage.cacheWrite,
  );
  assert.equal(final.outputTokens, lastMessage.usage.output);
  assert.ok(final.outputTokens > Math.ceil(result.response.length / 4));
  assert.ok(
    observed.requestUsages.every(
      (usage) => usage.timestamp >= observed.states.at(-1)!.updatedAt,
    ),
  );
});

test("each tool follow-up resets generated tokens instead of adding prior responses again", async () => {
  const { faux, runtime } = fixture(128000, { min: 8, max: 8 });
  const observed = callbacks([
    { nodeId: "root", revision: 0, messageCount: 1 },
  ]);
  const environment: RunEnvironment = {
    async beforeToolCall() {
      return true;
    },
    async executeTool(_call, execute) {
      return execute();
    },
    onToolUpdate() {},
  };
  let resetIndex = -1;
  // A future timestamp exercises logical ordering when subsequent preparation
  // happens no later than the previous provider message's timestamp.
  const providerTimestamp = Date.now() + 60_000;
  faux.setResponses([
    fauxAssistantMessage(
      [
        { type: "text", text: "I will fetch the source first. ".repeat(20) },
        fauxToolCall(
          "web_fetch",
          { url: "https://example.com" },
          { id: "usage-web" },
        ),
      ],
      { stopReason: "toolUse", timestamp: providerTimestamp },
    ),
    () => {
      resetIndex = observed.requestUsages.length - 1;
      return fauxAssistantMessage("Done.", { timestamp: providerTimestamp });
    },
  ]);
  const result = await runtime.run(
    config,
    [user("ROOT")],
    "FETCH THE SOURCE",
    signal(),
    () => {},
    environment,
    observed.options,
  );
  assert.ok(resetIndex > 0);
  const previous = observed.requestUsages[resetIndex - 1];
  const reset = observed.requestUsages[resetIndex];
  assert.equal(previous.estimated, undefined);
  assert.ok(previous.outputTokens > 100);
  assert.equal(reset.outputTokens, 0);
  assert.equal(reset.inputTokens, observed.states.at(-1)?.inputTokens);
  assert.ok(reset.timestamp > previous.timestamp);
  assert.ok(
    observed.requestUsages
      .slice(resetIndex)
      .every((usage) => usage.outputTokens <= 2),
  );
  const final = observed.requestUsages.at(-1)!;
  assert.equal(final.estimated, undefined);
  assert.equal(final.outputTokens, 2);
  assert.ok((result.usage?.output ?? 0) > final.outputTokens);
});

test("runtime rechecks after a complete tool batch while retaining all original tool messages", async () => {
  const { faux, runtime } = fixture(6000);
  const observed = callbacks([
    { nodeId: "root", revision: 0, messageCount: 1 },
  ]);
  const environment: RunEnvironment = {
    async beforeToolCall() {
      return true;
    },
    async executeTool(_call, execute) {
      return execute();
    },
    onToolUpdate() {},
  };
  let beforeSummaryUsageCount = 0;
  let compactedResetIndex = -1;
  faux.setResponses([
    (context) => {
      assert.doesNotMatch(text(context), /SUMMARY:/);
      return fauxAssistantMessage(
        fauxToolCall(
          "web_fetch",
          { url: "https://example.com" },
          { id: "web-1" },
        ),
        { stopReason: "toolUse" },
      );
    },
    (context) => {
      assert.match(text(context), /BIG TOOL RESULT/);
      beforeSummaryUsageCount = observed.requestUsages.length;
      assert.match(text(context), /web_fetch/);
      const saved = observed.snapshots.at(-1) ?? [];
      assert.deepEqual(
        saved.map((message) => message.role),
        ["user", "assistant", "toolResult"],
      );
      return fauxAssistantMessage(summary);
    },
    (context) => {
      // Only the actual provider request emits a reset. The summary itself
      // must not be mistaken for output added to the active conversation.
      assert.equal(observed.requestUsages.length, beforeSummaryUsageCount + 1);
      compactedResetIndex = observed.requestUsages.length - 1;
      const reset = observed.requestUsages[compactedResetIndex];
      assert.equal(reset.outputTokens, 0);
      assert.equal(reset.inputTokens, observed.states.at(-1)?.inputTokens);
      assert.equal(observed.states.at(-1)?.status, "compacted");
      assert.match(text(context), /SUMMARY:/);
      assert.match(text(context), /FETCH EXACT REQUEST/);
      const toolCalls = new Set(
        context.messages.flatMap((message) =>
          message.role === "assistant"
            ? message.content
                .filter((part) => part.type === "toolCall")
                .map((part) => part.id)
            : [],
        ),
      );
      for (const message of context.messages)
        if (message.role === "toolResult")
          assert.ok(toolCalls.has(message.toolCallId));
      return fauxAssistantMessage("finished reading");
    },
  ]);
  const result = await runtime.run(
    config,
    [user("ROOT PROJECT GOAL")],
    "FETCH EXACT REQUEST",
    signal(),
    () => {},
    environment,
    observed.options,
  );
  assert.deepEqual(
    result.messages.map((message) => message.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
  assert.match(JSON.stringify(result.messages), /BIG TOOL RESULT/);
  assert.deepEqual(observed.snapshots.at(-1), result.messages);
  assert.equal(observed.checkpoints.length, 1);
  assert.equal(faux.state.callCount, 3);
  const postCompaction = observed.requestUsages.slice(compactedResetIndex);
  assert.ok(
    postCompaction.every(
      (usage) => usage.timestamp >= observed.states.at(-1)!.updatedAt,
    ),
  );
  assert.ok(postCompaction.some((usage) => usage.outputTokens > 0));
  assert.equal(
    postCompaction.at(-1)?.outputTokens,
    Math.ceil("finished reading".length / 4),
  );
});

test("a truncated summary fails explicitly and still persists the original current prompt", async () => {
  const { faux, runtime } = fixture();
  const history = historyFixture();
  const observed = callbacks(history.sources);
  faux.setResponses([
    fauxAssistantMessage("unfinished summary", { stopReason: "length" }),
  ]);
  await assert.rejects(
    runtime.run(
      config,
      history.messages,
      "PRESERVE ME",
      signal(),
      () => {},
      undefined,
      observed.options,
    ),
    /摘要超过输出限制/,
  );
  assert.equal(observed.checkpoints.length, 0);
  assert.equal(faux.state.callCount, 1);
  assert.match(JSON.stringify(observed.snapshots.at(-1)), /PRESERVE ME/);
  assert.doesNotMatch(
    JSON.stringify(observed.snapshots.at(-1)),
    /unfinished summary/,
  );
});

test("cancelling a summary settles promptly without persisting its late result", async () => {
  const { faux, runtime } = fixture();
  const history = historyFixture();
  const observed = callbacks(history.sources);
  const controller = new AbortController();
  let started!: () => void;
  const summaryStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (result: ReturnType<typeof fauxAssistantMessage>) => void;
  faux.setResponses([
    async () => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  ]);
  const pending = runtime.run(
    config,
    history.messages,
    "PRESERVE CANCELLED PROMPT",
    controller.signal,
    () => {},
    undefined,
    observed.options,
  );
  await summaryStarted;
  controller.abort(new Error("user cancelled"));
  await assert.rejects(pending, /user cancelled/);
  finish(fauxAssistantMessage(summary));
  assert.equal(observed.checkpoints.length, 0);
  assert.match(
    JSON.stringify(observed.snapshots.at(-1)),
    /PRESERVE CANCELLED PROMPT/,
  );
});

test("manual context preparation creates only a summary, even below the automatic threshold", async () => {
  const { faux, runtime } = fixture(128000);
  const history = historyFixture();
  const original = structuredClone(history.messages);
  const observed = callbacks(history.sources);
  faux.setResponses([
    (context) => {
      assert.match(text(context), /conversation/);
      const system = context.messages[0];
      if (system.role === "system")
        assert.equal(system.toolsAdded?.length ?? 0, 0);
      return fauxAssistantMessage(summary);
    },
  ]);
  const checkpoint = await runtime.prepareContext(
    config,
    history.messages,
    signal(),
    observed.options,
  );
  assert.ok(checkpoint);
  assert.equal(checkpoint.id, observed.checkpoints[0]?.id);
  assert.equal(checkpoint.summary, summary);
  assert.equal(faux.state.callCount, 1);
  assert.equal(observed.snapshots.length, 0);
  assert.equal(observed.requestUsages.length, 0);
  assert.deepEqual(history.messages, original);
  await assert.rejects(
    runtime.prepareContext(
      { ...config, model: "demo/pi-demo" },
      history.messages,
      signal(),
      observed.options,
    ),
    /演示模型.*真实/,
  );
});

test("a standalone runtime with no ancestor history preserves its first user request", async () => {
  const { faux, runtime } = fixture();
  const observed = callbacks([]);
  faux.setResponses([
    (context) => {
      assert.match(text(context), /FIRST EXACT REQUEST/);
      return fauxAssistantMessage("done");
    },
  ]);
  const result = await runtime.run(
    config,
    [],
    "FIRST EXACT REQUEST",
    signal(),
    () => {},
    undefined,
    observed.options,
  );
  assert.equal(result.response, "done");
  assert.equal(observed.states.at(-1)?.status, "full");
  assert.deepEqual(observed.snapshots.at(-1), result.messages);
  assert.equal(faux.state.callCount, 1);
});

test("provider failure after tools still flushes the complete original tool transcript", async () => {
  const { faux, runtime } = fixture(128000);
  const observed = callbacks([
    { nodeId: "root", revision: 0, messageCount: 1 },
  ]);
  const environment: RunEnvironment = {
    async beforeToolCall() {
      return true;
    },
    async executeTool(_call, execute) {
      return execute();
    },
    onToolUpdate() {},
  };
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        "web_fetch",
        { url: "https://example.com" },
        { id: "failed-web" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("partial answer", {
      stopReason: "error",
      errorMessage: "upstream unavailable",
    }),
  ]);
  await assert.rejects(
    runtime.run(
      config,
      [user("ROOT")],
      "FETCH BEFORE FAILURE",
      signal(),
      () => {},
      environment,
      observed.options,
    ),
    /upstream unavailable/,
  );
  const persisted = observed.snapshots.at(-1) ?? [];
  assert.deepEqual(
    persisted.map((message) => message.role),
    ["user", "assistant", "toolResult", "assistant"],
  );
  assert.match(JSON.stringify(persisted), /BIG TOOL RESULT/);
  assert.match(JSON.stringify(persisted), /FETCH BEFORE FAILURE/);
});

test("an oversized summary request fails before calling the provider", async () => {
  const { faux, runtime } = fixture();
  const messages = [
    user("ROOT"),
    user("x".repeat(50000)),
    fauxAssistantMessage("y".repeat(50000)),
  ];
  const observed = callbacks([
    { nodeId: "root", revision: 0, messageCount: 1 },
    { nodeId: "old-turn", revision: 0, messageCount: 2 },
  ]);
  await assert.rejects(
    runtime.prepareContext(config, messages, signal(), observed.options),
    /待摘要内容超过此模型容量/,
  );
  assert.equal(observed.checkpoints.length, 0);
  assert.equal(faux.state.callCount, 0);
});
