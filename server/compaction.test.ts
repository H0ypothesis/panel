import assert from "node:assert/strict";
import test from "node:test";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import type {
  ContextCheckpoint,
  ContextSource,
  ContextState,
} from "../shared/types.ts";
import {
  checkpointMatches,
  ContextCompactor,
  contextBudget,
  contextSourceHash,
  estimateContextInputTokens,
  type ContextCompactorOptions,
} from "./compaction.ts";

const user = (content: string, timestamp = 0): Message => ({
  role: "user",
  content,
  timestamp,
});
const assistant = (content: string, timestamp = 0): Message =>
  fauxAssistantMessage(content, { timestamp });
const toolResult = (id: string, text: string): Message => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 0,
});
const signal = () => new AbortController().signal;

function history(): Message[] {
  return [
    user("ROOT: preserve this exact instruction"),
    ...Array.from({ length: 10 }, (_, index) =>
      index % 2 === 0
        ? user(`question-${index}: ${"a".repeat(2000)}`, index)
        : assistant(`answer-${index}: ${"b".repeat(2000)}`, index),
    ),
    user("CURRENT: preserve the exact question", 12),
  ];
}
function provenance(messages: Message[]): ContextSource[] {
  return [
    { nodeId: "root", revision: 0, messageCount: 1 },
    { nodeId: "ancestor", revision: 2, messageCount: messages.length - 2 },
    { nodeId: "current", revision: 0, messageCount: 0 },
  ];
}
function setup(
  messages: Message[],
  overrides: Partial<ContextCompactorOptions> = {},
) {
  const checkpoints: ContextCheckpoint[] = [];
  const states: ContextState[] = [];
  const summaries: { messages: Message[]; previous?: string }[] = [];
  const options: ContextCompactorOptions = {
    model: "faux/model",
    thinking: "off",
    contextWindow: 4096,
    maxOutputTokens: 512,
    systemPrompt: "System instructions",
    tools: [],
    sources: provenance(messages),
    currentPromptIndex: messages.length - 1,
    autoCompact: true,
    summarize: async (input, previous) => {
      summaries.push({ messages: structuredClone(input), previous });
      return {
        text: `Checkpoint ${summaries.length}: goal, decisions and remaining work.`,
      };
    },
    onState: async (state) => {
      states.push(state);
    },
    onCheckpoint: async (checkpoint) => {
      checkpoints.push(checkpoint);
    },
    ...overrides,
  };
  return {
    compactor: new ContextCompactor(options),
    options,
    checkpoints,
    states,
    summaries,
  };
}

test("automatic compaction preserves root, current question and the original transcript", async () => {
  const messages = history();
  const original = structuredClone(messages);
  const run = setup(messages);
  const projected = await run.compactor.prepare(messages, signal());
  assert.deepEqual(messages, original);
  assert.deepEqual(projected[0], messages[0]);
  assert.deepEqual(projected.at(-1), messages.at(-1));
  assert.equal(run.summaries.length, 1);
  assert.equal(run.checkpoints.length, 1);
  assert.equal(run.states.at(-1)?.status, "compacted");
  const checkpoint = run.checkpoints[0];
  assert.equal(
    checkpointMatches(checkpoint, messages, run.options.sources),
    true,
  );
  assert.equal(
    checkpoint.sources.reduce(
      (total, source) => total + source.messageCount,
      0,
    ),
    checkpoint.messageCount,
  );
  assert.ok(checkpoint.tokensAfter < checkpoint.tokensBefore);
  assert.ok(
    estimateContextInputTokens(projected, run.options.systemPrompt) + 512 <=
      4096,
  );
  assert.deepEqual(
    run.summaries[0].messages,
    messages.slice(1, checkpoint.messageCount),
  );
});

test("a sibling below its threshold uses all raw messages despite a matching cached prefix", async () => {
  const messages = history();
  const first = setup(messages);
  await first.compactor.prepare(messages, signal());
  const sibling = setup(messages, {
    contextWindow: 65536,
    checkpoints: first.checkpoints,
    sources: provenance(messages).map((source) =>
      source.nodeId === "current" ? { ...source, nodeId: "sibling" } : source,
    ),
  });
  assert.equal(
    checkpointMatches(first.checkpoints[0], messages, sibling.options.sources),
    true,
  );
  assert.deepEqual(
    await sibling.compactor.prepare(messages, signal()),
    messages,
  );
  assert.equal(sibling.summaries.length, 0);
  assert.equal(sibling.states.at(-1)?.status, "full");
});

test("a matching prefix is reused only when needed or explicitly requested", async () => {
  const messages = history();
  const first = setup(messages);
  const expected = await first.compactor.prepare(messages, signal());
  const repeated = setup(messages, { checkpoints: first.checkpoints });
  assert.deepEqual(
    await repeated.compactor.prepare(messages, signal()),
    expected,
  );
  assert.equal(repeated.summaries.length, 0);
  assert.equal(
    repeated.checkpoints.length,
    1,
    "first adoption records checkpoint provenance",
  );
  const requested = setup(messages, {
    contextWindow: 65536,
    checkpoints: first.checkpoints,
    requestedCheckpointId: first.checkpoints[0].id,
    autoCompact: false,
  });
  assert.deepEqual(
    await requested.compactor.prepare(messages, signal()),
    expected,
  );
  assert.equal(requested.states.at(-1)?.checkpointId, first.checkpoints[0].id);
  const historicalSources = first.checkpoints[0].sources;
  assert.equal(
    checkpointMatches(
      first.checkpoints[0],
      messages.slice(0, first.checkpoints[0].messageCount),
      historicalSources,
    ),
    true,
  );
});

test("source revision, node identity and exact prefix changes invalidate checkpoints", async () => {
  const messages = history();
  const first = setup(messages);
  await first.compactor.prepare(messages, signal());
  const checkpoint = first.checkpoints[0];
  const changedSources = structuredClone(first.options.sources);
  changedSources[1].revision++;
  assert.equal(checkpointMatches(checkpoint, messages, changedSources), false);
  changedSources[1].revision--;
  changedSources[1].nodeId = "different-branch";
  assert.equal(checkpointMatches(checkpoint, messages, changedSources), false);
  const changedMessages = structuredClone(messages);
  changedMessages[1] = user("edited ancestor");
  assert.equal(
    checkpointMatches(checkpoint, changedMessages, first.options.sources),
    false,
  );
  const invalid = setup(changedMessages, {
    contextWindow: 65536,
    checkpoints: [checkpoint],
    requestedCheckpointId: checkpoint.id,
  });
  await assert.rejects(
    invalid.compactor.prepare(changedMessages, signal()),
    /过期|当前路径/,
  );
  assert.equal(invalid.summaries.length, 0);
  assert.equal(invalid.checkpoints.length, 0);
  assert.equal(invalid.states.at(-1)?.status, "failed");
});

test("hashing binds actual prefix and clipped provenance while ignoring later appended messages", () => {
  const messages = history();
  const sources = provenance(messages);
  const hash = contextSourceHash(messages, sources, 5);
  assert.equal(
    hash,
    contextSourceHash([...messages, assistant("later")], sources, 5),
  );
  assert.notEqual(
    hash,
    contextSourceHash([user("changed root"), ...messages.slice(1)], sources, 5),
  );
  assert.notEqual(hash, contextSourceHash(messages, sources, 6));
});

test("tool batches are summarized or retained as complete call/result groups", async () => {
  const messages: Message[] = [
    user("root"),
    user("old question " + "x".repeat(12000)),
    fauxAssistantMessage(
      [
        fauxToolCall("read", { path: "a" }, { id: "a" }),
        fauxToolCall("read", { path: "b" }, { id: "b" }),
      ],
      { timestamp: 0, stopReason: "toolUse" },
    ),
    toolResult("a", "x".repeat(7000)),
    toolResult("b", "y".repeat(7000)),
    user("current"),
  ];
  const run = setup(messages);
  const projected = await run.compactor.prepare(messages, signal());
  const cut = run.checkpoints[0].messageCount;
  assert.ok(cut <= 2 || cut >= 5, `cut ${cut} splits a batch`);
  assert.equal(
    projected.filter((message) => message.role === "toolResult").length,
    cut <= 2 ? 2 : 0,
  );
});

test("an unfinished tool batch cannot be compacted or published", async () => {
  const messages: Message[] = [
    user("root"),
    user("old ".repeat(5000)),
    fauxAssistantMessage(
      [
        fauxToolCall("read", { path: "a" }, { id: "a" }),
        fauxToolCall("read", { path: "b" }, { id: "b" }),
      ],
      { timestamp: 0, stopReason: "toolUse" },
    ),
    toolResult("a", "done"),
  ];
  const run = setup(messages, { currentPromptIndex: 1 });
  await assert.rejects(
    run.compactor.prepare(messages, signal(), true),
    /批次尚未完成/,
  );
  assert.equal(run.summaries.length, 0);
  assert.equal(run.checkpoints.length, 0);
});

test("growing tool history incrementally updates a local checkpoint and preserves the current prompt", async () => {
  const messages = history();
  const run = setup(messages);
  const first = await run.compactor.prepare(messages, signal());
  const checkpoint = run.checkpoints[0];
  assert.deepEqual(await run.compactor.prepare(messages, signal()), first);
  assert.equal(
    run.summaries.length,
    1,
    "old provider usage cannot trigger repeat compaction",
  );
  const growing = [
    ...messages,
    fauxAssistantMessage(
      fauxToolCall("read", { path: "large" }, { id: "large" }),
      { timestamp: 20, stopReason: "toolUse" },
    ),
    toolResult("large", "large output ".repeat(3000)),
  ];
  const original = structuredClone(growing);
  const projected = await run.compactor.prepare(growing, signal());
  assert.equal(run.summaries.length, 2);
  assert.equal(run.summaries[1].previous, checkpoint.summary);
  assert.ok(run.checkpoints[1].messageCount > checkpoint.messageCount);
  assert.deepEqual(
    run.summaries[1].messages,
    growing.slice(checkpoint.messageCount, run.checkpoints[1].messageCount),
  );
  assert.equal(
    projected.filter(
      (message) => JSON.stringify(message) === JSON.stringify(messages.at(-1)),
    ).length,
    1,
  );
  assert.deepEqual(projected[0], messages[0]);
  assert.deepEqual(growing, original);
});

test("automatic failure falls back only when the intact input fits the actual output budget", async () => {
  const messages = [user("root"), user("a".repeat(12600)), user("current")];
  const failure = async () => {
    throw new Error("summary service unavailable");
  };
  const safe = setup(messages, { maxOutputTokens: 128, summarize: failure });
  assert.deepEqual(await safe.compactor.prepare(messages, signal()), messages);
  assert.equal(safe.states.at(-1)?.status, "failed");
  assert.match(safe.states.at(-1)?.error ?? "", /summary service unavailable/);
  assert.equal(safe.checkpoints.length, 0);
  const tooLarge = history();
  const unsafe = setup(tooLarge, { summarize: failure });
  await assert.rejects(
    unsafe.compactor.prepare(tooLarge, signal()),
    /summary service unavailable/,
  );
  assert.equal(unsafe.checkpoints.length, 0);
  const manual = setup(messages, { summarize: failure });
  await assert.rejects(
    manual.compactor.prepare(messages, signal(), true),
    /summary service unavailable/,
  );
});

test("empty, expanding and still oversized summaries never become checkpoints", async () => {
  for (const text of ["", "z".repeat(100000)]) {
    const messages = history();
    const run = setup(messages, { summarize: async () => ({ text }) });
    await assert.rejects(
      run.compactor.prepare(messages, signal(), true),
      /有效摘要|没有变小|超过/,
    );
    assert.equal(run.checkpoints.length, 0);
  }
  const messages = [
    user("root ".repeat(3500)),
    user("history ".repeat(10000)),
    user("current"),
  ];
  const run = setup(messages);
  await assert.rejects(
    run.compactor.prepare(messages, signal(), true),
    /压缩后仍超过/,
  );
  assert.equal(run.checkpoints.length, 0);
});

test("cancellation after summarization leaves raw messages and publishes no checkpoint", async () => {
  const messages = history();
  const original = structuredClone(messages);
  const controller = new AbortController();
  const run = setup(messages, {
    summarize: async (input) => {
      input[0] = user("a summarizer must not mutate raw input");
      controller.abort(new Error("cancelled by user"));
      return { text: "should not publish" };
    },
  });
  await assert.rejects(
    run.compactor.prepare(messages, controller.signal),
    /cancelled by user/,
  );
  assert.equal(run.checkpoints.length, 0);
  assert.equal(run.states.at(-1)?.status, "cancelled");
  assert.deepEqual(messages, original);
});

test("budgets include tool schemas and system text and scale down for smaller models", () => {
  const small = contextBudget({
    contextWindow: 4096,
    maxOutputTokens: 512,
    systemPrompt: "s".repeat(400),
    tools: [{ name: "read", parameters: "p".repeat(400) }],
  });
  const large = contextBudget({
    contextWindow: 128000,
    maxOutputTokens: 8192,
    systemPrompt: "",
    tools: [],
  });
  assert.equal(small.reservedTokens, 1024);
  assert.equal(large.reservedTokens, 16384);
  assert.equal(large.keepRecentTokens, 20000);
  assert.ok(small.keepRecentTokens < 20000);
  assert.ok(small.overheadTokens > 200);
  assert.ok(estimateContextInputTokens([user("中文".repeat(100))]) > 240);
});

test("an empty-history runtime preserves its first user prompt without treating it as compressible history", async () => {
  const messages = [user("the first prompt")];
  const run = setup(messages, {
    currentPromptIndex: 0,
    sources: [{ nodeId: "current", revision: 0, messageCount: 0 }],
  });
  assert.deepEqual(await run.compactor.prepare(messages, signal()), messages);
  assert.equal(run.states.at(-1)?.status, "full");
  assert.equal(run.checkpoints.length, 0);
});

test("a cached prefix that no longer fits a smaller model is not published before successful recompression", async () => {
  const messages = history();
  const first = setup(messages);
  await first.compactor.prepare(messages, signal());
  const checkpoint = first.checkpoints[0];
  checkpoint.summary = "previous summary ".repeat(80);
  const run = setup(messages, {
    contextWindow: 512,
    maxOutputTokens: 64,
    checkpoints: [checkpoint],
    requestedCheckpointId: checkpoint.id,
    summarize: async () => {
      throw new Error("summary failed");
    },
  });
  await assert.rejects(
    run.compactor.prepare(messages, signal()),
    /summary failed/,
  );
  assert.equal(run.checkpoints.length, 0);
});

test("checkpoint and state persistence failures cannot fall back into a model request", async () => {
  const messages = [user("root"), user("a".repeat(12600)), user("current")];
  const checkpointFailure = setup(messages, {
    maxOutputTokens: 128,
    onCheckpoint: async () => {
      throw new Error("checkpoint disk failure");
    },
  });
  await assert.rejects(
    checkpointFailure.compactor.prepare(messages, signal()),
    /checkpoint disk failure/,
  );
  assert.equal(checkpointFailure.states.at(-1)?.status, "failed");
  const stateFailure = setup([user("root"), user("current")], {
    onState: async (state) => {
      if (state.status !== "failed") throw new Error("state disk failure");
    },
  });
  await assert.rejects(
    stateFailure.compactor.prepare([user("root"), user("current")], signal()),
    /state disk failure/,
  );
});

test("provider usage calibrates only the response to this compactor's own previous projection", async () => {
  const messages = [
    user("root"),
    user("history ".repeat(200)),
    user("current"),
  ];
  const run = setup(messages);
  assert.deepEqual(await run.compactor.prepare(messages, signal()), messages);
  const response = fauxAssistantMessage("done", { timestamp: 20 });
  response.provider = "faux";
  response.model = "model";
  response.usage = {
    ...response.usage,
    input: 2000,
    cacheRead: 1100,
    cacheWrite: 50,
    totalTokens: 3150,
  };
  const grown = [...messages, response];
  const projected = await run.compactor.prepare(grown, signal());
  assert.equal(
    run.summaries.length,
    1,
    "measured input should trigger compaction despite a small character estimate",
  );
  const expectedBefore =
    3150 +
    estimateContextInputTokens(grown) -
    estimateContextInputTokens(messages);
  assert.equal(run.checkpoints[0].tokensBefore, expectedBefore);
  assert.ok(run.checkpoints[0].tokensAfter < 1000);
  assert.deepEqual(await run.compactor.prepare(grown, signal()), projected);
  assert.equal(
    run.summaries.length,
    1,
    "usage measured before compression must not apply to the new checkpoint",
  );
});

test("ancestor, other-model and zero usage never override this projection's token estimate", async () => {
  const ancestor = fauxAssistantMessage("history", { timestamp: 0 });
  ancestor.provider = "faux";
  ancestor.model = "model";
  ancestor.usage = { ...ancestor.usage, input: 1000000, totalTokens: 1000000 };
  const messages = [user("root"), ancestor, user("current")];
  const run = setup(messages);
  assert.deepEqual(await run.compactor.prepare(messages, signal()), messages);
  const other = structuredClone(ancestor);
  other.model = "other-model";
  assert.deepEqual(
    await run.compactor.prepare([...messages, other], signal()),
    [...messages, other],
  );
  const zero = fauxAssistantMessage("next", { timestamp: 20 });
  zero.provider = "faux";
  zero.model = "model";
  zero.usage = {
    ...zero.usage,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };
  assert.deepEqual(
    await run.compactor.prepare([...messages, other, zero], signal()),
    [...messages, other, zero],
  );
  assert.equal(run.summaries.length, 0);
  assert.equal(run.states.at(-1)?.status, "full");
});

test("manual force generates a fresh summary using the chosen model even with a matching ancestor cache", async () => {
  const messages = history();
  const first = setup(messages);
  await first.compactor.prepare(messages, signal());
  const manual = setup(messages, {
    model: "chosen/model-b",
    thinking: "high",
    contextWindow: 65536,
    checkpoints: first.checkpoints,
    currentPromptIndex: undefined,
  });
  await manual.compactor.prepare(messages, signal(), true);
  assert.equal(manual.summaries.length, 1);
  assert.equal(manual.checkpoints.length, 1);
  assert.notEqual(manual.checkpoints[0].id, first.checkpoints[0].id);
  assert.equal(manual.checkpoints[0].model, "chosen/model-b");
  assert.equal(manual.checkpoints[0].thinking, "high");
  await manual.compactor.prepare(messages, signal(), true);
  assert.equal(
    manual.summaries.length,
    2,
    "forcing an already active instance also generates a new summary",
  );
  assert.notEqual(manual.checkpoints[1].id, manual.checkpoints[0].id);
});

test("manual preparation summarizes a completed short path as a whole question-answer turn", async () => {
  const messages = [
    user("root"),
    user("请分析"),
    assistant("original evidence ".repeat(400)),
  ];
  for (const contextWindow of [4096, 128000]) {
    const run = setup(messages, {
      contextWindow,
      currentPromptIndex: undefined,
      sources: [
        { nodeId: "root", revision: 0, messageCount: 1 },
        { nodeId: "completed", revision: 0, messageCount: 2 },
      ],
    });
    const projected = await run.compactor.prepare(messages, signal(), true);
    assert.deepEqual(run.summaries[0].messages, messages.slice(1));
    assert.equal(run.checkpoints[0].messageCount, messages.length);
    assert.equal(projected.length, 2);
    assert.deepEqual(projected[0], messages[0]);
    assert.ok(run.checkpoints[0].tokensAfter < run.checkpoints[0].tokensBefore);
  }
});
