import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelThinkingSettings } from "../shared/provider-settings.ts";
import type { RunConfig } from "../shared/types.ts";
import { ModelProviderSettings } from "./provider-settings.ts";
import { modelThinkingControls, runThinkingOptions } from "./model-thinking.ts";
import { probeThinking, thinkingProbeContext } from "./thinking-probe.ts";

const base = {
  baseUrl: "https://probe.invalid/api",
  apiKey: "probe-test-secret",
  model: "test-model",
};
async function fixture(t: TestContext, thinking?: ModelThinkingSettings) {
  const directory = await mkdtemp(join(tmpdir(), "panel-controls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new ModelProviderSettings(directory);
  await settings.init();
  await settings.save("paperbypass", { ...base, thinking });
  const registry = settings.currentRegistry();
  const model = registry.getModel("paperbypass", base.model)!;
  return { settings, registry, model };
}
function response() {
  const events = [
    {
      type: "message_start",
      message: {
        id: "probe",
        type: "message",
        role: "assistant",
        model: base.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "323" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
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

for (const format of [
  "reasoning-effort",
  "reasoning-object",
  "anthropic-effort",
  "none",
] as const) {
  test(`${format}: independent toggle, default and effort survive the production serializer`, async (t) => {
    const { registry, model } = await fixture(t, {
      format,
      toggle: "thinking-type",
      levels: format === "none" ? [] : ["low", "high"],
    });
    assert.deepEqual(modelThinkingControls(model), {
      toggle: "supported",
      efforts: format === "none" ? [] : ["low", "high"],
    });
    for (const mode of ["enabled", "disabled", "default"] as const) {
      for (const effort of format === "none"
        ? (["default"] as const)
        : (["default", "high"] as const)) {
        let captured: any;
        const config: RunConfig = {
          model: "paperbypass/test-model",
          thinking: mode === "disabled" ? "off" : "high",
          thinkingMode: mode,
          effort,
        };
        const result = await registry.completeSimple(
          model,
          thinkingProbeContext,
          runThinkingOptions(model, config, {
            maxTokens: 256,
            maxRetries: 0,
            fetch: async (input, init) => {
              captured = await new Request(input, init).json();
              return response();
            },
          }),
        );
        assert.equal(result.stopReason, "stop", result.errorMessage);
        assert.deepEqual(
          captured.thinking,
          mode === "default" ? undefined : { type: mode },
        );
        const expected = effort !== "default" ? "high" : undefined;
        assert.equal(
          captured.reasoning_effort,
          format === "reasoning-effort" ? expected : undefined,
        );
        assert.equal(
          captured.reasoning?.effort,
          format === "reasoning-object" ? expected : undefined,
        );
        assert.equal(
          captured.output_config?.effort,
          format === "anthropic-effort" ? expected : undefined,
        );
      }
    }
  });
}

test("effort-none has an explicit off and reenabling default supplies a valid positive effort", async (t) => {
  const { registry, model } = await fixture(t, {
    format: "reasoning-object",
    toggle: "effort-none",
    levels: ["low", "high"],
  });
  for (const mode of ["disabled", "enabled", "default"] as const) {
    let body: any;
    await registry.completeSimple(
      model,
      thinkingProbeContext,
      runThinkingOptions(
        model,
        { model: "x", thinking: "high", thinkingMode: mode, effort: "default" },
        {
          maxRetries: 0,
          fetch: async (input, init) => {
            body = await new Request(input, init).json();
            return response();
          },
        },
      ),
    );
    assert.equal(
      body.reasoning?.effort,
      mode === "disabled" ? "none" : mode === "enabled" ? "low" : undefined,
    );
    assert.equal(body.thinking, undefined);
  }
  assert.equal(modelThinkingControls(model).effortRequiresThinking, true);
  assert.throws(
    () =>
      runThinkingOptions(model, {
        model: "x",
        thinking: "off",
        thinkingMode: "disabled",
        effort: "high",
      }),
    /无法同时设置关闭思考和独立 effort/,
  );
});

test("native adaptive Claude preserves disabled thinking and separately maps effort", async (t) => {
  const { registry } = await fixture(t);
  const model = registry
    .getModels()
    .find(
      (candidate) =>
        candidate.provider === "anthropic" &&
        !modelThinkingControls(candidate).effortRequiresThinking &&
        modelThinkingControls(candidate).toggle === "supported",
    );
  assert.ok(model, "Expected a native adaptive Claude model that supports off");
  for (const effort of ["low", "high"] as const) {
    let body: any;
    let callbackCount = 0;
    const result = await registry.completeSimple(
      model,
      thinkingProbeContext,
      runThinkingOptions(
        model,
        {
          model: model.id,
          thinking: "off",
          thinkingMode: "disabled",
          effort,
        },
        {
          apiKey: "local-test-key",
          maxRetries: 0,
          onPayload: (payload) => {
            callbackCount++;
            assert.deepEqual((payload as any).thinking, { type: "disabled" });
          },
          fetch: async (input, init) => {
            body = await new Request(input, init).json();
            return response();
          },
        },
      ),
    );
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.output_config.effort, effort);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(callbackCount, 1);
  }
});

test("native compatible Chat adapters retain the off switch and mapped effort", async (t) => {
  const { settings } = await fixture(t);
  await settings.save("openai", { ...base, protocol: "openai-completions" });
  const registry = settings.currentRegistry();
  for (const thinkingFormat of [
    "deepseek",
    "zai",
    "qwen",
    "together",
  ] as const) {
    const model: Model<"openai-completions"> = {
      ...registry.getModel("openai", base.model)!,
      api: "openai-completions",
      reasoning: true,
      thinkingLevelMap: { off: "off", high: "medium" },
      compat: { thinkingFormat, supportsReasoningEffort: true },
    };
    let body: any;
    const result = await registry.completeSimple(
      model,
      thinkingProbeContext,
      runThinkingOptions(
        model,
        {
          model: model.id,
          thinking: "off",
          thinkingMode: "disabled",
          effort: "high",
        },
        {
          maxRetries: 0,
          fetch: async (input, init) => {
            body = await new Request(input, init).json();
            const chunk = {
              id: "mock",
              choices: [
                { index: 0, delta: { content: "323" }, finish_reason: "stop" },
              ],
            };
            return new Response(
              `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
              {
                headers: { "Content-Type": "text/event-stream" },
              },
            );
          },
        },
      ),
    );
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(body.reasoning_effort, "medium");
    if (thinkingFormat === "together")
      assert.equal(body.reasoning.enabled, false);
    else if (thinkingFormat === "qwen")
      assert.equal(body.enable_thinking, false);
    else assert.deepEqual(body.thinking, { type: "disabled" });
  }
});

test("native effort-only and budget adapters reject off plus effort before dispatch", async (t) => {
  const { registry } = await fixture(t);
  for (const provider of ["openai", "google", "anthropic"]) {
    const model = registry
      .getModels()
      .find(
        (candidate) =>
          candidate.provider === provider &&
          modelThinkingControls(candidate).toggle === "supported" &&
          modelThinkingControls(candidate).effortRequiresThinking &&
          modelThinkingControls(candidate).efforts.includes("high"),
      );
    assert.ok(model, `Expected a coupled ${provider} model`);
    assert.throws(
      () =>
        runThinkingOptions(model, {
          model: model.id,
          thinking: "off",
          thinkingMode: "disabled",
          effort: "high",
        }),
      /无法同时设置关闭思考和独立 effort/,
    );
    assert.doesNotThrow(() =>
      runThinkingOptions(model, {
        model: model.id,
        thinking: "off",
        thinkingMode: "disabled",
        effort: "default",
      }),
    );
  }
});

test("probe uses fixed content, bounded requests and negative controls through the real Messages adapter", async (t) => {
  const { registry, model } = await fixture(t);
  const bodies: any[] = [];
  const result = await probeThinking(
    model,
    "reasoning-effort",
    (options) => registry.completeSimple(model, thinkingProbeContext, options),
    undefined,
    async (input, init) => {
      const request = new Request(input, init);
      assert.equal(new URL(request.url).pathname, "/api/v1/messages");
      assert.equal(
        request.headers.get("Authorization"),
        `Bearer ${base.apiKey}`,
      );
      assert.equal(init?.redirect, "error");
      const body: any = await request.json();
      bodies.push(body);
      assert.equal(body.max_tokens, 256);
      assert.equal(body.tools, undefined);
      assert.match(JSON.stringify(body.messages), /Calculate 17 \* 19/);
      const rejected =
        body.thinking?.type === "panel_invalid_probe_value" ||
        body.reasoning_effort === "panel_invalid_probe_value" ||
        body.reasoning_effort === "max";
      return rejected
        ? new Response(
            JSON.stringify({
              error: { message: base.apiKey, type: "invalid_request_error" },
            }),
            { status: 400 },
          )
        : response();
    },
  );
  assert.equal(bodies.length, 12);
  assert.equal(result.requests, 12);
  assert.equal(
    result.rows.find((row) => row.option === "invalid-toggle")?.status,
    "rejected",
  );
  assert.equal(
    result.rows.find((row) => row.option === "invalid-effort")?.status,
    "rejected",
  );
  assert.equal(
    result.rows.find((row) => row.option === "max")?.status,
    "rejected",
  );
  assert.equal(
    result.rows.find((row) => row.option === "low")?.status,
    "accepted",
  );
  assert.equal(JSON.stringify(result).includes(base.apiKey), false);
});

test("baseline authentication failure stops detection and does not pretend parameters are unsupported", async (t) => {
  const { registry, model } = await fixture(t);
  const result = await probeThinking(
    model,
    "reasoning-object",
    (options) => registry.completeSimple(model, thinkingProbeContext, options),
    undefined,
    async () =>
      new Response('{"error":{"message":"bad key"}}', { status: 401 }),
  );
  assert.equal(result.requests, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].status, "inconclusive");
});

test("draft detection scopes credentials to the endpoint and never saves model or key", async (t) => {
  const { settings } = await fixture(t);
  const before = settings.currentRegistry();
  const original = settings.list();
  await assert.rejects(
    settings.probe("paperbypass", {
      ...base,
      baseUrl: "https://other.invalid",
      apiKey: undefined,
      format: "none",
    }),
    /API URL 已改变/,
  );
  let request: Request | undefined;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      request = new Request(input, init);
      return new Response('{"error":{"message":"baseline unavailable"}}', {
        status: 503,
      });
    },
  );
  const result = await settings.probe("paperbypass", {
    ...base,
    baseUrl: "https://other.invalid",
    model: "draft-only",
    apiKey: "draft-only-secret",
    format: "none",
  });
  assert.equal(result.requests, 1);
  assert.equal(
    new URL(request!.url).origin + new URL(request!.url).pathname,
    "https://other.invalid/v1/messages",
  );
  assert.equal(
    request?.headers.get("Authorization"),
    "Bearer draft-only-secret",
  );
  assert.equal(settings.currentRegistry(), before);
  assert.deepEqual(settings.list(), original);
});

test("cancelled probe stops before scheduling more calls", async (t) => {
  const { registry, model } = await fixture(t);
  const controller = new AbortController();
  const result = await probeThinking(
    model,
    "reasoning-effort",
    (options) => registry.completeSimple(model, thinkingProbeContext, options),
    controller.signal,
    async () => {
      controller.abort();
      throw new Error("abort");
    },
  );
  assert.equal(result.requests, 1);
  assert.equal(result.rows[0].status, "inconclusive");
});

test("probe cancellation settles even when an adapter ignores its signal", async (t) => {
  const { model } = await fixture(t);
  const controller = new AbortController();
  const pending = probeThinking(
    model,
    "none",
    async () => new Promise(() => {}),
    controller.signal,
  );
  controller.abort();
  const result = await pending;
  assert.equal(result.requests, 0);
  assert.equal(result.rows[0].status, "inconclusive");
});
