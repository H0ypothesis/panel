import assert from "node:assert/strict";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, Type } from "@earendil-works/pi-ai";
import { atriaProvider } from "./atria.ts";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { test } from "node:test";
import { PiRuntime, safeError } from "./runtime.ts";

const envNames = [
  "ATRIA_API_KEY",
  "ATRIA_BASE_URL",
  "ATRIA_MODEL",
  "PANEL_DEFAULT_MODEL",
] as const;

test("Atria streams Dawn Preview with Messages routing and server-side API key auth", async (t) => {
  const modelId = "Atria-Dawn-Preview";
  const configId = `atria/${modelId}`;
  const dummyKey = "atr_panel-local-mock-key";
  const previousEnv = new Map(
    envNames.map((name) => [name, process.env[name]]),
  );
  const originalFetch = globalThis.fetch;
  const requests: {
    method?: string;
    url?: string;
    headers: IncomingHttpHeaders;
    body: Record<string, unknown>;
  }[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(body),
      });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const events = [
        {
          type: "message_start",
          message: {
            id: "msg_atria_local_mock",
            type: "message",
            role: "assistant",
            model: modelId,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 7, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        ...["Hello", " from Atria"].map((text) => ({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text },
        })),
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 },
        },
        { type: "message_stop" },
      ];
      for (const event of events)
        response.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      response.end();
    } catch {
      response.writeHead(500);
      response.end("Invalid mock request");
    }
  });
  t.after(async () => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = (input, options) => {
    const url = input instanceof Request ? input.url : String(input);
    assert.equal(
      new URL(url).origin,
      origin,
      "Only the local mock may be called",
    );
    return originalFetch(input, options);
  };
  process.env.ATRIA_API_KEY = dummyKey;
  process.env.ATRIA_BASE_URL = `${origin}/`;
  delete process.env.ATRIA_MODEL;
  process.env.PANEL_DEFAULT_MODEL = "paperbypass/openai/gpt-5.6-luna-pro";

  const runtime = new PiRuntime();
  const models = runtime.models();
  const model = models.find((item) => item.id === configId);
  assert.ok(model?.available);
  assert.equal(model.default, false);
  assert.equal(model.contextWindow, 256000);
  assert.equal(model.envVar, "ATRIA_API_KEY");
  assert.deepEqual(model.thinkingLevels, ["off"]);
  assert.equal(
    models.find((item) => item.id === process.env.PANEL_DEFAULT_MODEL)?.default,
    true,
  );
  assert.equal(JSON.stringify(models).includes(dummyKey), false);
  assert.equal(
    safeError(new Error(`Unauthorized ${dummyKey}; token ${dummyKey}`)),
    "Unauthorized [redacted]; token [redacted]",
  );

  const updates: string[] = [];
  const result = await runtime.run(
    { model: configId, thinking: "off" },
    [],
    "Say hello",
    AbortSignal.timeout(10000),
    (text) => updates.push(text),
  );
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.method, "POST");
  assert.equal(new URL(request.url!, origin).pathname, "/v1/messages");
  assert.equal(request.headers["x-api-key"], dummyKey);
  assert.equal(request.headers.authorization, undefined);
  assert.equal(request.body.model, modelId);
  assert.equal(request.body.stream, true);
  assert.equal(typeof request.body.max_tokens, "number");
  assert.equal(request.body.thinking, undefined);
  assert.equal(request.body.reasoning_effort, undefined);
  assert.equal(JSON.stringify(request.body).includes(dummyKey), false);
  assert.deepEqual(updates, ["Hello", "Hello from Atria"]);
  assert.equal(result.response, "Hello from Atria");
  assert.equal(result.messages.at(-1)?.role, "assistant");
  assert.equal(result.usage?.input, 7);
  assert.equal(result.usage?.output, 5);
  assert.equal(result.usage?.cost, undefined);
});

test("Atria remains listed but unavailable without a nonblank API key", (t) => {
  const previousEnv = new Map(
    envNames.map((name) => [name, process.env[name]]),
  );
  t.after(() => {
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  delete process.env.ATRIA_BASE_URL;
  delete process.env.ATRIA_MODEL;
  for (const key of [undefined, "   "]) {
    if (key === undefined) delete process.env.ATRIA_API_KEY;
    else process.env.ATRIA_API_KEY = key;
    const model = new PiRuntime()
      .models()
      .find((item) => item.id === "atria/Atria-Dawn-Preview");
    assert.ok(model);
    assert.equal(model.available, false);
    assert.equal(model.envVar, "ATRIA_API_KEY");
  }
});

test(
  "Atria preserves streamed tool calls and results through the Pi agent loop",
  { timeout: 10000 },
  async (t) => {
    const modelId = "Atria-Dawn-Preview";
    const names = ["ATRIA_API_KEY", "ATRIA_BASE_URL", "ATRIA_MODEL"] as const;
    const previousEnv = new Map(names.map((name) => [name, process.env[name]]));
    const originalFetch = globalThis.fetch;
    const requests: Record<string, any>[] = [];
    const readArguments = { path: "src/你好.ts" };
    const bashArguments = { command: "printf 'first\nsecond'" };
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      requests.push(JSON.parse(body));
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (event: Record<string, unknown>) =>
        response.write(
          `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      send({
        type: "message_start",
        message: {
          id: `msg_tool_${requests.length}`,
          type: "message",
          role: "assistant",
          model: modelId,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 9, output_tokens: 0 },
        },
      });
      if (requests.length <= 2) {
        const name = requests.length === 1 ? "read" : "bash";
        const args = requests.length === 1 ? readArguments : bashArguments;
        send({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: `tool_${name}`,
            name,
            input: {},
          },
        });
        // Deliberately split every JSON token, including escaped characters.
        for (const fragment of JSON.stringify(args)) {
          send({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: fragment },
          });
        }
      } else {
        send({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        send({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Read complete; command denied." },
        });
      }
      send({ type: "content_block_stop", index: 0 });
      send({
        type: "message_delta",
        delta: {
          stop_reason: requests.length <= 2 ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: 4 },
      });
      send({ type: "message_stop" });
      response.end();
    });
    t.after(async () => {
      globalThis.fetch = originalFetch;
      for (const [name, value] of previousEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    globalThis.fetch = (input, options) => {
      const url = input instanceof Request ? input.url : String(input);
      assert.equal(
        new URL(url).origin,
        origin,
        "Only the local mock may be called",
      );
      return originalFetch(input, options);
    };
    process.env.ATRIA_API_KEY = "mock-local-tools-key";
    process.env.ATRIA_BASE_URL = `${origin}/`;
    process.env.ATRIA_MODEL = modelId;
    const registry = createModels();
    registry.setProvider(atriaProvider());
    const model = registry.getModel("atria", modelId);
    assert.ok(model);
    const executed: { name: string; args: unknown }[] = [];
    const agent = new Agent({
      initialState: {
        model,
        thinkingLevel: "off",
        systemPrompt: "Use the available tools.",
        tools: [
          {
            name: "read",
            label: "Read file",
            description: "Read a file in the selected directory.",
            parameters: Type.Object({ path: Type.String() }),
            execute: async (_id, args) => {
              executed.push({ name: "read", args });
              return {
                content: [{ type: "text", text: "export const answer = 42;" }],
                details: {},
              };
            },
          },
          {
            name: "bash",
            label: "Run command",
            description: "Run a command in the selected directory.",
            parameters: Type.Object({ command: Type.String() }),
            execute: async (_id, args) => {
              executed.push({ name: "bash", args });
              throw new Error("User denied command approval");
            },
          },
        ],
      },
      streamFn: registry.streamSimple.bind(registry),
    });
    t.after(() => agent.abort());
    await agent.prompt("Read the source and run the check.");
    assert.deepEqual(executed, [
      { name: "read", args: readArguments },
      { name: "bash", args: bashArguments },
    ]);
    assert.equal(requests.length, 3);
    const declarations = requests[0].tools;
    assert.deepEqual(
      declarations.map((tool: Record<string, unknown>) => tool.name),
      ["read", "bash"],
    );
    assert.equal(declarations[0].input_schema.type, "object");
    assert.deepEqual(declarations[0].input_schema.required, ["path"]);
    assert.deepEqual(declarations[0].input_schema.properties, {
      path: { type: "string" },
    });
    for (const request of requests)
      assert.deepEqual(request.tools, declarations);
    const secondMessages = requests[1].messages;
    const readCall = secondMessages
      .flatMap((message: any) =>
        Array.isArray(message.content) ? message.content : [],
      )
      .find((block: any) => block.type === "tool_use");
    assert.deepEqual(readCall, {
      type: "tool_use",
      id: "tool_read",
      name: "read",
      input: readArguments,
    });
    const finalBlocks = requests[2].messages.flatMap((message: any) =>
      Array.isArray(message.content) ? message.content : [],
    );
    const results = finalBlocks.filter(
      (block: any) => block.type === "tool_result",
    );
    assert.equal(
      results.length,
      2,
      "Earlier results remain in context across multiple tool turns",
    );
    assert.equal(results[0].tool_use_id, "tool_read");
    assert.equal(results[0].content, "export const answer = 42;");
    assert.equal(results[0].is_error, false);
    assert.equal(results[1].tool_use_id, "tool_bash");
    assert.equal(results[1].is_error, true);
    assert.match(
      JSON.stringify(results[1].content),
      /User denied command approval/,
    );
    const assistants = agent.state.messages.filter(
      (message) => message.role === "assistant",
    );
    assert.deepEqual(
      assistants.map((message) => message.stopReason),
      ["toolUse", "toolUse", "stop"],
    );
    assert.deepEqual(assistants.at(-1)?.content, [
      { type: "text", text: "Read complete; command denied." },
    ]);
  },
);
