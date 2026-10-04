import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createModels,
  getSupportedThinkingLevels,
  type Context,
  type Models,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { paperbypassProvider } from "./paperbypass.ts";
import { reviewSafetyTool } from "./safety-review.ts";
import { PiRuntime } from "./runtime.ts";

const context: Context = {
  messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
};

function response(model: string, text: string, truncated = false) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_thinking_mock",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "thinking_delta",
        thinking: "Check the requested action.",
      },
    },
    { type: "content_block_stop", index: 0 },
    ...(!truncated
      ? [
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text },
          },
          { type: "content_block_stop", index: 1 },
        ]
      : []),
    {
      type: "message_delta",
      delta: { stop_reason: truncated ? "max_tokens" : "end_turn" },
      usage: { output_tokens: truncated ? 1024 : 2048 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

function setup(text = "Hello", simulateThinkingBudget = false) {
  const registry = createModels();
  registry.setProvider(paperbypassProvider());
  const requests: Record<string, unknown>[] = [];
  const options: SimpleStreamOptions = {
    env: { PAPERBYPASS_API_KEY: "local-test-key" },
    headers: { Authorization: "Bearer local-test-key" },
    maxTokens: 8192,
    maxRetries: 0,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const body = (await request.json()) as Record<string, unknown>;
      requests.push(body);
      assert.equal(new URL(request.url).pathname, "/api/v1/messages");
      assert.equal(
        body.thinking,
        undefined,
        "Gateway rejects Anthropic thinking controls",
      );
      if (body.model === "anthropic/claude-opus-5.5") {
        assert.equal(body.reasoning_effort, undefined);
        assert.ok(
          ["low", "medium", "high", "xhigh", "max"].includes(
            String((body.output_config as { effort: string })?.effort),
          ),
        );
      } else {
        assert.equal(body.output_config, undefined);
        assert.ok(
          ["low", "high", "max"].includes(String(body.reasoning_effort)),
        );
      }
      return response(
        String(body.model),
        text,
        simulateThinkingBudget && Number(body.max_tokens) < 2048,
      );
    },
  };
  return { registry, requests, options };
}

for (const id of ["z-ai/glm-5.3-flash", "z-ai/glm-5.3"]) {
  test(`${id} maps supported and legacy efforts without Claude thinking budgets`, async () => {
    const { registry, requests, options } = setup();
    const model = registry.getModel("paperbypass", id);
    assert.ok(model);
    assert.deepEqual(getSupportedThinkingLevels(model), ["low", "high", "max"]);
    for (const [reasoning, expected] of [
      [undefined, "low"],
      ["minimal", "low"],
      ["low", "low"],
      ["medium", "high"],
      ["high", "high"],
      ["xhigh", "max"],
      ["max", "max"],
    ] as const) {
      const result = await registry.completeSimple(model, context, {
        ...options,
        reasoning,
      });
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.deepEqual(
        result.content.map((part) => part.type),
        ["thinking", "text"],
      );
      assert.equal(requests.at(-1)?.reasoning_effort, expected);
      assert.equal(
        requests.at(-1)?.max_tokens,
        8192,
        "Effort must not expand the caller's output cap",
      );
    }
  });
}

test("GLM direct Messages requests preserve payload hooks and use native effort", async () => {
  const { registry, requests, options } = setup();
  const model = registry.getModel("paperbypass", "z-ai/glm-5.3-flash");
  assert.ok(model);
  let callbacks = 0;
  const result = await registry.complete(model, context, {
    ...options,
    thinkingEnabled: false,
    effort: "max",
    onPayload: async (payload, callbackModel) => {
      callbacks++;
      assert.equal(callbackModel.reasoning, true);
      assert.ok(payload && typeof payload === "object");
      assert.equal(
        "reasoning_effort" in payload && payload.reasoning_effort,
        "max",
      );
      return { ...payload, metadata: { user_id: "local-trace" } };
    },
  });
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(callbacks, 1);
  assert.equal(requests[0].reasoning_effort, "max");
  assert.deepEqual(requests[0].metadata, { user_id: "local-trace" });
});

test("Paperbypass Opus 5.5 supports five effort levels and its reviewer independently uses low", async () => {
  const { registry, requests, options } = setup(
    '{"decision":"approve","reason":"符合用户要求。"}',
  );
  const model = registry.getModel("paperbypass", "anthropic/claude-opus-5.5")!;
  const levels = ["low", "medium", "high", "xhigh", "max"] as const;
  assert.deepEqual(getSupportedThinkingLevels(model), levels);
  for (const reasoning of levels) {
    const result = await registry.completeSimple(model, context, {
      ...options,
      reasoning,
    });
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(
      (requests.at(-1)?.output_config as { effort: string }).effort,
      reasoning,
    );
  }
  const verdict = await reviewSafetyTool(
    {
      completeSimple: (selected, context, received) =>
        registry.completeSimple(selected, context, { ...options, ...received }),
    },
    model,
    {
      model: `paperbypass/${model.id}`,
      workspaceTitle: "test",
      workspaceDescription: "",
      userRequest: "查看窗口",
      ancestry: [],
      tool: {
        id: "observe",
        name: "computer_use_call",
        arguments: { tool: "get_window_state" },
      },
    },
    AbortSignal.timeout(10000),
  );
  assert.equal(verdict.decision, "approve");
  assert.equal(
    (requests.at(-1)?.output_config as { effort: string }).effort,
    "low",
  );
  assert.equal(requests.at(-1)?.max_tokens, 8192);
});

test("main conversation effort reaches GLM while each operation review independently stays low", async () => {
  const { registry, requests, options } = setup(
    '{"decision":"approve","reason":"符合用户要求。"}',
  );
  const stream = registry.streamSimple.bind(registry);
  registry.streamSimple = (model, context, received) =>
    stream(model, context, {
      ...options,
      ...received,
    });
  const runtime = new PiRuntime(registry);
  const model = registry.getModel("paperbypass", "z-ai/glm-5.3-flash");
  assert.ok(model);
  for (const thinking of ["low", "high", "max"] as const) {
    await runtime.run(
      {
        model: `paperbypass/${model.id}`,
        thinking,
        thinkingMode: "enabled",
        effort: thinking,
      },
      [],
      "Say hello",
      AbortSignal.timeout(10000),
      () => {},
    );
    assert.equal(requests.at(-1)?.reasoning_effort, thinking);
    const verdict = await reviewSafetyTool(
      registry,
      model,
      {
        model: `paperbypass/${model.id}`,
        workspaceTitle: "test",
        workspaceDescription: "",
        userRequest: "查看窗口",
        ancestry: [],
        tool: {
          id: "observe",
          name: "computer_use_call",
          arguments: { tool: "get_window_state" },
        },
      },
      AbortSignal.timeout(10000),
    );
    assert.equal(verdict.decision, "approve");
    assert.equal(requests.at(-1)?.reasoning_effort, "low");
    assert.equal(requests.at(-1)?.max_tokens, 8192);
  }
});

test("forced GLM review has room for thinking and a complete verdict, while truncation still fails", async () => {
  const { registry, requests, options } = setup(
    '{"decision":"approve","reason":"查看窗口符合用户要求。"}',
    true,
  );
  const model = registry.getModel("paperbypass", "z-ai/glm-5.3-flash");
  assert.ok(model);
  const reviewer: Pick<Models, "completeSimple"> = {
    completeSimple: (selected, context, received) =>
      registry.completeSimple(selected, context, {
        ...options,
        ...received,
      }),
  };
  const request = {
    model: `paperbypass/${model.id}`,
    workspaceTitle: "cua",
    workspaceDescription: "",
    userRequest: "查看浏览器窗口",
    ancestry: [],
    tool: {
      id: "window-state",
      name: "computer_use_call",
      arguments: { tool: "get_window_state" },
    },
  };
  assert.equal(
    (
      await reviewSafetyTool(
        reviewer,
        model,
        request,
        AbortSignal.timeout(10000),
      )
    ).decision,
    "approve",
  );
  assert.equal(requests[0].reasoning_effort, "low");
  assert.equal(requests[0].max_tokens, 8192);
  await assert.rejects(
    reviewSafetyTool(
      reviewer,
      { ...model, maxTokens: 1024 },
      request,
      AbortSignal.timeout(10000),
    ),
    /没有完成有效审核/,
  );
  assert.equal(requests[1].max_tokens, 1024);
});
