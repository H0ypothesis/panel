import assert from "node:assert/strict";
import test from "node:test";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  normalizeContext,
  Type,
  type AssistantMessage,
  type Message,
  type Model,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { stream as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import {
  createToolRequestBootstrap,
  projectToolRequestBootstraps,
} from "./tool-request-bootstrap.ts";
import { createWebTools } from "./web-tools.ts";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const model = fauxProvider({
  provider: "bootstrap-fixture",
  models: [{ id: "fixture" }],
}).getModel();

test("only validated current-turn metadata starts explicit tool calls", async () => {
  assert.equal(
    createToolRequestBootstrap(
      [],
      "@web_search appears in quoted material",
      model,
    ),
    undefined,
  );
  assert.throws(
    () => createToolRequestBootstrap(["bash" as never], "text", model),
    /工具调用选择无效/,
  );
  assert.throws(
    () => createToolRequestBootstrap(["web_search"], " \n ", model),
    /搜索内容/,
  );
  const stream = createToolRequestBootstrap(["computer_use"], "", model)!;
  const result = await stream.result();
  assert.deepEqual(
    result.content.map((part) =>
      part.type === "toolCall"
        ? { name: part.name, args: part.arguments }
        : part,
    ),
    [
      { name: "computer_use_tools", args: { group: "core" } },
      { name: "computer_use_call", args: { tool: "list_apps", arguments: {} } },
    ],
  );
});

test("bootstrap has real selected-model metadata, zero billed usage, and explicit UI provenance", async () => {
  const stream = createToolRequestBootstrap(
    ["computer_use", "web_search"],
    "  exact user query  ",
    model,
  )!;
  const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "done");
  const result = await stream.result();
  assert.equal(result.api, model.api);
  assert.equal(result.provider, model.provider);
  assert.equal(result.model, model.id);
  assert.equal(result.usage.totalTokens, 0);
  assert.equal(result.usage.cost.total, 0);
  assert.equal(result.diagnostics?.[0].details?.source, "user_tool_selection");
  assert.deepEqual(
    result.content.map((part) =>
      part.type === "toolCall" ? part.name : part.type,
    ),
    ["web_search", "computer_use_tools", "computer_use_call"],
  );
  assert.equal(
    result.content[0].type === "toolCall" && result.content[0].arguments.query,
    "exact user query",
  );
  assert.ok(
    result.content.every(
      (part) => part.type === "toolCall" && part.id.startsWith("panel-intent-"),
    ),
  );
});

test("bootstrap search query obeys the actual tool schema without splitting Unicode", async () => {
  const text = "a".repeat(1999) + "😀" + "end";
  const result = await createToolRequestBootstrap(
    ["web_search"],
    text,
    model,
  )!.result();
  assert.equal(result.content[0].type, "toolCall");
  const args =
    result.content[0].type === "toolCall" ? result.content[0].arguments : {};
  assert.equal(args.query, "a".repeat(1999));
  const tool = createWebTools().find((tool) => tool.name === "web_search")!;
  const validation = new AjvJsonSchemaValidator().getValidator(tool.parameters)(
    args,
  );
  assert.equal(validation.valid, true);
});

for (const deny of [false, true])
  test(`real Pi loop preserves per-tool approval (${deny ? "denied" : "allowed"})`, async () => {
    const authorized: string[] = [];
    const executed: string[] = [];
    const updates: string[] = [];
    let turns = 0;
    let bootstrap = createToolRequestBootstrap(
      ["web_search", "computer_use"],
      "only user query",
      model,
    );
    const tools: AgentTool[] = [
      "web_search",
      "computer_use_tools",
      "computer_use_call",
    ].map((name) => ({
      name,
      label: name,
      description: "fixture",
      parameters: Type.Record(Type.String(), Type.Unknown()),
      execute: async () => {
        executed.push(name);
        return {
          content: [{ type: "text" as const, text: "executed fixture" }],
          details: {},
        };
      },
    }));
    const agent = new Agent({
      initialState: { model, tools },
      toolExecution: "sequential",
      beforeToolCall: async ({ toolCall }) => {
        authorized.push(toolCall.name);
        return deny ? { block: true, reason: "user denied" } : undefined;
      },
      streamFn: () => {
        turns++;
        if (bootstrap) {
          const initial = bootstrap;
          bootstrap = undefined;
          return initial;
        }
        const stream = createAssistantMessageEventStream();
        const message = fauxAssistantMessage("done");
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
        return stream;
      },
    });
    agent.subscribe((event) => {
      if (event.type === "tool_execution_end") updates.push(event.toolName);
    });
    await agent.prompt("original prompt with unrelated private branch context");
    assert.equal(turns, 2);
    assert.deepEqual(authorized, [
      "web_search",
      "computer_use_tools",
      "computer_use_call",
    ]);
    assert.deepEqual(executed, deny ? [] : authorized);
    assert.deepEqual(updates, authorized);
    const results = agent.state.messages.filter(
      (message) => message.role === "toolResult",
    );
    assert.equal(results.length, 3);
    assert.ok(results.every((result) => result.isError === deny));
  });

function resultFor(
  call: ToolCall,
  text = "fixture result",
  isError = false,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  };
}

test("provider projection preserves actual results, images, denial, and all genuine signed messages", async () => {
  const bootstrap = await createToolRequestBootstrap(
    ["web_search", "computer_use"],
    "search text",
    model,
  )!.result();
  const calls = bootstrap.content as ToolCall[];
  const results = calls.map((call, index) =>
    resultFor(
      call,
      index === 1 ? "user denied" : "untrusted fixture",
      index === 1,
    ),
  );
  const image = {
    type: "image" as const,
    data: "aW1hZ2U=",
    mimeType: "image/png",
  };
  results[2].content.push(image);
  const genuine = fauxAssistantMessage("provider response");
  genuine.content.unshift({
    type: "thinking",
    thinking: "provider reasoning",
    thinkingSignature: "actual-provider-signature",
  });
  const user: Message = {
    role: "user",
    content: "original user",
    timestamp: 1,
  };
  const raw: Message[] = [user, bootstrap, ...results, genuine];
  const snapshot = structuredClone(raw);
  const projection = projectToolRequestBootstraps(raw);
  assert.equal(projection.length, 3);
  assert.equal(projection[0], user);
  assert.equal(projection[2], genuine);
  assert.equal(projection[1].role, "user");
  const projected = projection[1];
  assert.ok(projected.role === "user" && Array.isArray(projected.content));
  const text = projected.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  assert.match(text, /正常的工具审批流程/);
  assert.match(text, /不可信资料/);
  assert.match(text, /"query":"search text"/);
  assert.match(text, /"status":"completed"/);
  assert.match(text, /"status":"error_or_denied"/);
  assert.match(text, /user denied/);
  assert.ok(projected.content.includes(image));
  assert.ok(projected.content.includes(results[0].content[0]));
  assert.deepEqual(raw, snapshot);
  // The provider view is safe to project again; raw persisted messages retain
  // their provenance and are projected on every future provider request.
  assert.equal(projectToolRequestBootstraps(projection), projection);
  assert.deepEqual(
    projectToolRequestBootstraps(structuredClone(raw)),
    projection,
  );
});

test("only exact marked host batches are projected, never ordinary provider tool turns", async () => {
  const bootstrap = await createToolRequestBootstrap(
    ["web_search"],
    "query",
    model,
  )!.result();
  const variants: AssistantMessage[] = [
    { ...bootstrap, diagnostics: undefined },
    {
      ...bootstrap,
      diagnostics: [
        {
          type: "other",
          timestamp: 1,
          details: { source: "user_tool_selection" },
        },
      ],
    },
    {
      ...bootstrap,
      diagnostics: [
        {
          type: "panel_tool_request_bootstrap",
          timestamp: 1,
          details: { source: "other" },
        },
      ],
    },
    {
      ...bootstrap,
      content: [{ ...(bootstrap.content[0] as ToolCall), id: "provider-id" }],
    },
    {
      ...bootstrap,
      content: [{ ...(bootstrap.content[0] as ToolCall), name: "bash" }],
    },
    {
      ...bootstrap,
      content: [...bootstrap.content, { type: "text", text: "genuine reply" }],
    },
    { ...bootstrap, content: [bootstrap.content[0], bootstrap.content[0]] },
  ];
  for (const variant of variants) {
    const messages: Message[] = [variant];
    assert.equal(projectToolRequestBootstraps(messages), messages);
    assert.equal(projectToolRequestBootstraps(messages)[0], variant);
  }
});

test("interrupted bootstrap projects missing results explicitly and does not absorb later turns", async () => {
  const bootstrap = await createToolRequestBootstrap(
    ["computer_use"],
    "",
    model,
  )!.result();
  const firstResult = resultFor(bootstrap.content[0] as ToolCall);
  const laterUser: Message = {
    role: "user",
    content: "cancelled, new request",
    timestamp: 2,
  };
  const raw: Message[] = [bootstrap, firstResult, laterUser];
  const projection = projectToolRequestBootstraps(raw);
  assert.equal(projection.length, 2);
  assert.equal(projection[1], laterUser);
  assert.equal(projection[0].role, "user");
  assert.match(JSON.stringify(projection[0]), /interrupted_or_not_recorded/);
  assert.match(JSON.stringify(projection[0]), /不能视为执行成功/);
  assert.ok(projection.every((message) => message.role !== "toolResult"));
  const empty = projectToolRequestBootstraps([bootstrap]);
  assert.equal(empty.length, 1);
  assert.match(JSON.stringify(empty[0]), /interrupted_or_not_recorded/);
});

test("Anthropic thinking payload receives host results as user data without unsigned tool_use", async () => {
  const anthropicModel: Model<"anthropic-messages"> = {
    ...model,
    api: "anthropic-messages",
    provider: "anthropic",
    id: "claude-sonnet-4-20250514",
    baseUrl: "https://example.invalid",
    reasoning: true,
  };
  const bootstrap = await createToolRequestBootstrap(
    ["web_search"],
    "query",
    anthropicModel,
  )!.result();
  let payload: unknown;
  const stream = streamAnthropic(
    anthropicModel,
    normalizeContext({
      messages: projectToolRequestBootstraps([
        bootstrap,
        resultFor(bootstrap.content[0] as ToolCall),
      ]),
    }),
    {
      apiKey: "fixture-key",
      thinkingEnabled: true,
      thinkingBudgetTokens: 1024,
      maxTokens: 2048,
      onPayload: (value) => {
        payload = value;
        throw new Error("fixture stops before any network request");
      },
    },
  );
  const stopped = await stream.result();
  assert.match(stopped.errorMessage ?? "", /fixture stops/);
  const params = payload as {
    thinking: { type: string };
    messages: { role: string }[];
  };
  assert.equal(params.thinking.type, "enabled");
  assert.deepEqual(
    params.messages.map((message) => message.role),
    ["user"],
  );
  assert.doesNotMatch(
    JSON.stringify(params.messages),
    /"type":"tool_use"|"type":"tool_result"|"signature":/,
  );
  assert.match(JSON.stringify(params.messages), /fixture result/);
});

test("Gemini thinking payload receives host results without unsigned functionCall", async () => {
  const googleModel: Model<"google-generative-ai"> = {
    ...model,
    api: "google-generative-ai",
    provider: "google",
    id: "gemini-3-pro-preview",
    baseUrl: "https://example.invalid",
    reasoning: true,
  };
  const bootstrap = await createToolRequestBootstrap(
    ["web_search"],
    "query",
    googleModel,
  )!.result();
  let payload: unknown;
  const stream = streamGoogle(
    googleModel,
    normalizeContext({
      messages: projectToolRequestBootstraps([
        bootstrap,
        resultFor(bootstrap.content[0] as ToolCall),
      ]),
    }),
    {
      apiKey: "fixture-key",
      thinking: { enabled: true, level: "HIGH" },
      onPayload: (value) => {
        payload = value;
        throw new Error("fixture stops before any network request");
      },
    },
  );
  const stopped = await stream.result();
  assert.match(stopped.errorMessage ?? "", /fixture stops/);
  const params = payload as { contents: { role: string }[] };
  assert.deepEqual(
    params.contents.map((message) => message.role),
    ["user"],
  );
  assert.doesNotMatch(
    JSON.stringify(params.contents),
    /"functionCall":|"functionResponse":|"thoughtSignature":/,
  );
  assert.match(JSON.stringify(params.contents), /fixture result/);
});
