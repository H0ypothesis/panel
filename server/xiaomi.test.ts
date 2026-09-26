import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, Type } from "@earendil-works/pi-ai";
import { PiRuntime, safeError } from "./runtime.ts";
import { xiaomiTokenPlanProvider } from "./xiaomi.ts";

const modelIds = ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro"];
const envNames = [
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_BASE_URL",
  "PANEL_DEFAULT_MODEL",
] as const;
const dummyKey = "tp-panel-local-test-key";

interface ChatRequest {
  model: string;
  stream: boolean;
  max_completion_tokens?: number;
  thinking?: { type: string };
  reasoning_effort?: string;
  messages: {
    role: string;
    content: unknown;
    reasoning_content?: string;
    tool_call_id?: string;
    tool_calls?: {
      id: string;
      function: { name: string; arguments: string };
    }[];
  }[];
  tools?: { function: { name: string; parameters: unknown } }[];
}

function restoreEnv(t: TestContext) {
  const previous = new Map(envNames.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function mockXiaomi(
  t: TestContext,
  modelId: string,
  respond: (
    body: ChatRequest,
    index: number,
  ) => {
    deltas: Record<string, unknown>[];
    finishReason: "stop" | "tool_calls";
  },
) {
  restoreEnv(t);
  process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY = ` ${dummyKey} `;
  process.env.XIAOMI_TOKEN_PLAN_CN_BASE_URL = "https://xiaomi.invalid/v1/";
  process.env.PANEL_DEFAULT_MODEL = `xiaomi-token-plan-cn/${modelId}`;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests: ChatRequest[] = [];
  globalThis.fetch = async (input, options) => {
    const request = new Request(input, options);
    assert.equal(request.url, "https://xiaomi.invalid/v1/chat/completions");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("authorization"), `Bearer ${dummyKey}`);
    const body = (await request.json()) as ChatRequest;
    assert.equal(body.model, modelId);
    assert.equal(body.stream, true);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.messages[0].role, "system");
    assert.equal(JSON.stringify(body).includes(dummyKey), false);
    requests.push(body);
    const { deltas, finishReason } = respond(body, requests.length);
    const chunk = (delta: Record<string, unknown>, reason: string | null) => ({
      id: "chatcmpl-local-test",
      object: "chat.completion.chunk",
      created: 1,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: reason }],
    });
    const chunks = [
      ...deltas.map((delta) => chunk(delta, null)),
      chunk({}, finishReason),
      {
        ...chunk({}, null),
        choices: [],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      },
    ];
    return new Response(
      chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") +
        "data: [DONE]\n\n",
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  return requests;
}

for (const modelId of modelIds) {
  test(`Xiaomi ${modelId} streams with Token Plan auth and thinking on/off`, async (t) => {
    const requests = mockXiaomi(t, modelId, (body) => ({
      deltas: [
        { role: "assistant" },
        ...(body.thinking?.type === "enabled"
          ? [{ reasoning_content: "Think" }, { reasoning_content: " first." }]
          : []),
        { content: "Hello" },
        { content: " MiMo" },
      ],
      finishReason: "stop",
    }));
    const runtime = new PiRuntime();
    const models = runtime.models();
    const configId = `xiaomi-token-plan-cn/${modelId}`;
    const model = models.find((item) => item.id === configId);
    assert.ok(model?.available);
    assert.equal(model.default, true);
    assert.equal(model.envVar, "XIAOMI_TOKEN_PLAN_CN_API_KEY");
    assert.equal(model.contextWindow, 1048576);
    assert.equal(model.supportsImages, modelId !== "mimo-v2.5-pro");
    assert.deepEqual(model.thinkingLevels, ["off", "high"]);
    assert.equal(JSON.stringify(models).includes(dummyKey), false);
    assert.equal(
      safeError(
        new Error(`Failed ${process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY}`),
      ),
      "Failed [redacted]",
    );
    for (const thinking of ["off", "high"] as const) {
      const updates: string[] = [];
      const result = await runtime.run(
        { model: configId, thinking },
        [],
        "Say hello",
        AbortSignal.timeout(10000),
        (text) => updates.push(text),
      );
      const request = requests.at(-1)!;
      assert.deepEqual(request.thinking, {
        type: thinking === "off" ? "disabled" : "enabled",
      });
      assert.equal(request.max_completion_tokens, 16384);
      assert.equal(result.response, "Hello MiMo");
      assert.deepEqual(
        result.thinking,
        thinking === "high"
          ? { text: "Think first.", active: false }
          : undefined,
      );
      assert.deepEqual(updates, ["Hello", "Hello MiMo"]);
      assert.equal(result.usage?.input, 12);
      assert.equal(result.usage?.output, 4);
      assert.equal(result.usage?.cost, undefined);
    }
    assert.equal(requests.length, 2);
  });

  test(`Xiaomi ${modelId} preserves thinking and tool results in follow-up requests`, async (t) => {
    const args = { path: "src/你好.ts" };
    const reasoning = "Read the requested file.";
    const requests = mockXiaomi(t, modelId, (_body, index) =>
      index === 1
        ? {
            deltas: [
              { role: "assistant", reasoning_content: reasoning },
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_read",
                    type: "function",
                    function: { name: "read", arguments: "" },
                  },
                ],
              },
              ...Array.from(JSON.stringify(args), (fragment) => ({
                tool_calls: [{ index: 0, function: { arguments: fragment } }],
              })),
            ],
            finishReason: "tool_calls",
          }
        : {
            deltas: [{ role: "assistant", content: "Read complete." }],
            finishReason: "stop",
          },
    );
    const registry = createModels();
    registry.setProvider(xiaomiTokenPlanProvider());
    const model = registry.getModel("xiaomi-token-plan-cn", modelId);
    assert.ok(model);
    const executed: unknown[] = [];
    const agent = new Agent({
      initialState: {
        model,
        thinkingLevel: "high",
        systemPrompt: "Use the read tool.",
        tools: [
          {
            name: "read",
            label: "Read",
            description: "Read a file.",
            parameters: Type.Object({ path: Type.String() }),
            execute: async (_id, value) => {
              executed.push(value);
              return {
                content: [{ type: "text", text: "file contents" }],
                details: {},
              };
            },
          },
        ],
      },
      streamFn: registry.streamSimple.bind(registry),
    });
    t.after(() => agent.abort());
    await agent.prompt("Read the file.");
    assert.deepEqual(executed, [args]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].tools?.[0].function.name, "read");
    assert.deepEqual(requests[1].tools, requests[0].tools);
    const assistant = requests[1].messages.find(
      (message) => message.role === "assistant",
    );
    assert.equal(assistant?.reasoning_content, reasoning);
    assert.equal(assistant?.tool_calls?.[0].id, "call_read");
    assert.deepEqual(
      JSON.parse(assistant!.tool_calls![0].function.arguments),
      args,
    );
    const result = requests[1].messages.find(
      (message) => message.role === "tool",
    );
    assert.equal(result?.tool_call_id, "call_read");
    assert.equal(result?.content, "file contents");
    const final = agent.state.messages.at(-1);
    assert.equal(final?.role, "assistant");
    if (final?.role === "assistant") assert.equal(final.stopReason, "stop");
  });
}

test("Xiaomi models stay visible but unavailable without a nonblank Token Plan key", (t) => {
  restoreEnv(t);
  for (const key of [undefined, "   "]) {
    if (key === undefined) delete process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY;
    else process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY = key;
    const models = new PiRuntime()
      .models()
      .filter((model) => model.provider === "xiaomi-token-plan-cn");
    assert.deepEqual(
      models.map((model) => model.id.split("/")[1]).sort(),
      [...modelIds].sort(),
    );
    assert.ok(models.every((model) => !model.available));
  }
});
