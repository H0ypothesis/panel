import assert from "node:assert/strict";
import test from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
  type Message,
} from "@earendil-works/pi-ai";
import { PiRuntime } from "./runtime.ts";
import { providerOutputLimit } from "./generation-policy.ts";

function fixture(responses: FauxResponseStep[]) {
  const faux = fauxProvider({
    provider: "openai",
    models: [{ id: "generation", contextWindow: 1000000, maxTokens: 8192 }],
    tokensPerSecond: 1000000,
  });
  faux.setResponses(responses);
  const registry = createModels();
  registry.setProvider(faux.provider);
  const runtime = new PiRuntime(registry);
  const controller = new AbortController();
  let messages: Message[] = [];
  const run = () =>
    runtime.run(
      { model: "openai/generation", thinking: "off" },
      [],
      "finish the task",
      controller.signal,
      () => {},
      undefined,
      {
        autoCompact: true,
        sources: [{ nodeId: "current", revision: 0, messageCount: 0 }],
        onMessages: async (value) => {
          messages = value;
        },
      },
    );
  return { faux, registry, runtime, controller, run, messages: () => messages };
}

test("answer ceiling follows context while metadata and context preparation remain intact", async () => {
  const f = fixture([
    (context, options, _state, model) => {
      assert.equal(options?.maxTokens, 1000000);
      assert.equal(model.maxTokens, 1000000);
      assert.match(JSON.stringify(context), /finish the task/);
      return fauxAssistantMessage("complete");
    },
  ]);
  try {
    assert.equal((await f.run()).response, "complete");
    assert.equal(f.registry.getModel("openai", "generation")!.maxTokens, 8192);
  } finally {
    await f.runtime.close();
  }
});

test("length stops continue in place and preserve every partial reply and original transcript", async () => {
  const f = fixture([
    fauxAssistantMessage("part one; ", { stopReason: "length" }),
    (context) => {
      assert.match(JSON.stringify(context), /part one/);
      assert.match(JSON.stringify(context), /Panel 自动续写/);
      return fauxAssistantMessage("part two; ", { stopReason: "length" });
    },
    fauxAssistantMessage("complete"),
  ]);
  try {
    const result = await f.run();
    assert.equal(result.response, "part one; part two; complete");
    assert.equal(
      result.messages.filter((message) => message.role === "assistant").length,
      3,
    );
    assert.deepEqual(f.messages(), result.messages);
    assert.equal(f.faux.state.callCount, 3);
  } finally {
    await f.runtime.close();
  }
});

test("length recovery stops after three continuations and retains the fourth partial reply", async () => {
  const f = fixture(
    Array.from({ length: 5 }, (_, index) =>
      fauxAssistantMessage(`part ${index}`, { stopReason: "length" }),
    ),
  );
  try {
    await assert.rejects(f.run(), /输出未完成.*已自动续写 3 次/);
    assert.equal(f.faux.state.callCount, 4);
    assert.match(JSON.stringify(f.messages()), /part 3/);
  } finally {
    await f.runtime.close();
  }
});

test("repeated partial output stops instead of looping", async () => {
  const f = fixture(
    Array.from({ length: 5 }, () =>
      fauxAssistantMessage("same partial", { stopReason: "length" }),
    ),
  );
  try {
    await assert.rejects(f.run(), /自动续写没有产生新内容/);
    assert.equal(f.faux.state.callCount, 2);
  } finally {
    await f.runtime.close();
  }
});

test("truncated tool arguments are failed, never executed, before continuing", async () => {
  const f = fixture([
    fauxAssistantMessage(
      fauxToolCall(
        "write",
        { path: "must-not-exist", content: "partial" },
        { id: "truncated-write" },
      ),
      { stopReason: "length" },
    ),
    (context) => {
      const result = context.messages.find(
        (message) =>
          message.role === "toolResult" &&
          message.toolCallId === "truncated-write",
      );
      assert.equal(result?.role === "toolResult" && result.isError, true);
      return fauxAssistantMessage("recovered without writing");
    },
  ]);
  try {
    assert.equal((await f.run()).response, "recovered without writing");
  } finally {
    await f.runtime.close();
  }
});

test("output-parameter rejection retries only the server's explicit smaller ceiling", async () => {
  const f = fixture([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "max_tokens must be less than or equal to 128000",
    }),
    (_context, options, _state, model) => {
      assert.equal(options?.maxTokens, 128000);
      assert.equal(model.maxTokens, 128000);
      return fauxAssistantMessage("accepted");
    },
  ]);
  try {
    assert.equal((await f.run()).response, "accepted");
    assert.equal(f.faux.state.callCount, 2);
  } finally {
    await f.runtime.close();
  }
});

test("input overflow is not treated as an output bound or retried", async () => {
  assert.equal(
    providerOutputLimit(
      "maximum context length is 128000 tokens; input tokens 130000",
    ),
    undefined,
  );
  const f = fixture([
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "maximum context length exceeded",
    }),
  ]);
  try {
    await assert.rejects(f.run(), /输入上下文超限/);
    assert.equal(f.faux.state.callCount, 1);
  } finally {
    await f.runtime.close();
  }
});

test("provider output bounds are parsed from explicit gateway and provider errors", () => {
  for (const error of [
    "max_tokens: 995904 > 128000, which is the maximum allowed number of output tokens",
    "max_completion_tokens must be between 1 and 128000",
    "The maximum number of output tokens is 128000",
    "This model supports at most 128,000 completion tokens",
  ])
    assert.equal(providerOutputLimit(error), 128000, error);
  assert.equal(
    providerOutputLimit(
      "Input 120000 plus max_tokens 1000000 exceeds context length 1000000",
    ),
    undefined,
  );
});
