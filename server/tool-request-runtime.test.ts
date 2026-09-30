import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
  type Message,
} from "@earendil-works/pi-ai";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRequest } from "../shared/types.ts";
import {
  ComputerUse,
  type ComputerDriver,
  type ComputerSession,
} from "./computer-use.ts";
import { contextReferencePrompt } from "./context-references.ts";
import { PiRuntime, type RunEnvironment } from "./runtime.ts";
import { toolRequestPrompt } from "./tool-requests.ts";

const config = {
  model: "openai/explicit-tools-test",
  thinking: "off" as const,
};
type Call = Parameters<RunEnvironment["beforeToolCall"]>[0];

function projectedRecords(messages: Message[]) {
  const projected = messages.filter(
    (message) =>
      message.role === "user" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) =>
          part.type === "text" &&
          part.text.startsWith("Panel 按对应用户消息通过 @"),
      ),
  );
  assert.equal(
    projected.length,
    1,
    "the provider receives one application execution record",
  );
  const content = projected[0].content;
  assert.ok(Array.isArray(content));
  const text = content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  assert.match(text, /不是模型先前生成的回复/);
  assert.match(text, /不可信资料/);
  const records = content.flatMap((part) => {
    if (part.type !== "text") return [];
    const match = part.text.match(/^Panel 工具调用 \d+\/\d+: (\{.*\})$/);
    return match
      ? [
          JSON.parse(match[1]) as {
            tool: string;
            status: string;
            arguments: Record<string, unknown>;
          },
        ]
      : [];
  });
  assert.equal(
    messages.some(
      (message) =>
        message.role === "assistant" &&
        message.diagnostics?.some(
          (diagnostic) => diagnostic.type === "panel_tool_request_bootstrap",
        ),
    ),
    false,
  );
  return { records, text };
}

class FakeDriver implements ComputerDriver {
  installed = true;
  readonly sessions: ComputerSession[] = [];
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  readonly closed = new Set<string>();
  getStatus() {
    return { installed: this.installed, state: "ready", version: "test" };
  }
  async openSession(): Promise<ComputerSession> {
    const id = `tool-request-session-${this.sessions.length + 1}`;
    const session: ComputerSession = {
      id,
      generation: 0,
      listTools: async () =>
        ["list_apps", "check_permissions"].map(
          (name) =>
            ({
              name,
              inputSchema: {
                type: "object",
                properties: {
                  session: { type: "string" },
                  prompt: { type: "boolean" },
                },
                additionalProperties: false,
              },
            }) satisfies Tool,
        ),
      callTool: async (name, args) => {
        this.calls.push({ name, args: structuredClone(args) });
        return name === "check_permissions"
          ? {
              structuredContent: {
                accessibility: true,
                screen_recording: true,
              },
            }
          : {
              content: [
                { type: "text", text: "Visible applications: Test Browser" },
              ],
            };
      },
      close: async () => {
        this.closed.add(id);
      },
    };
    this.sessions.push(session);
    return session;
  }
  async close() {
    await Promise.all(this.sessions.map((session) => session.close()));
  }
}

function fixture(
  t: TestContext,
  responses: FauxResponseStep[],
  supportsImages = true,
) {
  const faux = fauxProvider({
    provider: "openai",
    models: [
      {
        id: "explicit-tools-test",
        input: supportsImages ? ["text", "image"] : ["text"],
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    tokensPerSecond: 1000000,
    tokenSize: { min: 2000, max: 3000 },
  });
  faux.setResponses(responses);
  const registry = createModels();
  registry.setProvider(faux.provider);
  const driver = new FakeDriver();
  const computer = new ComputerUse(driver);
  const calls: Call[] = [];
  const approved = new Set<string>();
  const dispatched: string[] = [];
  const searches: string[] = [];
  const snapshots: Message[][] = [];
  let permit: (call: Call) => boolean = () => true;
  const execution: RunEnvironment = {
    beforeToolCall: async (call, prepare) => {
      calls.push(structuredClone(call));
      await prepare?.(() => {});
      const allowed = permit(call);
      if (allowed) approved.add(call.id);
      return allowed;
    },
    executeTool: async (call, execute) => {
      assert.equal(
        approved.delete(call.id),
        true,
        "bootstrap must pass the normal authorization gate",
      );
      dispatched.push(call.name);
      return execute();
    },
    onToolUpdate: () => {},
  };
  const runtime = new PiRuntime(
    registry,
    {
      runNativePlugin: async (job) => {
        assert.equal(job.name, "web_search");
        if (job.name === "web_search") searches.push(String(job.args.query));
        assert.equal(dispatched.at(-1), "web_search");
        return {
          text: "Explicitly requested search result",
          sources: [{ title: "Example", url: "https://example.com/" }],
        };
      },
    },
    computer,
  );
  t.after(() => runtime.close());
  const run = (
    requests?: ToolRequest[],
    options: {
      prompt?: string;
      displayPrompt?: string;
      history?: Message[];
    } = {},
  ) =>
    runtime.run(
      config,
      options.history ?? [],
      options.prompt ?? "请查询相关资料并查看指定应用",
      new AbortController().signal,
      () => {},
      execution,
      {
        autoCompact: false,
        toolRequests: requests,
        displayPrompt: options.displayPrompt,
        sources: [
          {
            nodeId: "history",
            revision: 0,
            messageCount: options.history?.length ?? 0,
          },
          { nodeId: "current", revision: 0, messageCount: 0 },
        ],
        onMessages: async (messages) => {
          snapshots.push(structuredClone(messages));
        },
      },
    );
  return {
    faux,
    driver,
    runtime,
    calls,
    dispatched,
    searches,
    snapshots,
    run,
    deny: (check: typeof permit) => {
      permit = check;
    },
  };
}

test("@web_search performs an approved real search before the first provider response using only current display text", async (t) => {
  let received = false;
  const env = fixture(t, [
    (context) => {
      assert.equal(env.searches.length, 1);
      const { records, text } = projectedRecords(context.messages);
      assert.deepEqual(
        records.map((record) => [record.tool, record.status]),
        [["web_search", "completed"]],
      );
      assert.match(text, /Explicitly requested search result/);
      assert.equal(
        context.messages.some((message) => message.role === "toolResult"),
        false,
      );
      received = true;
      return fauxAssistantMessage("I used the requested search result.");
    },
  ]);
  const original = "查询今天的公开资料";
  const rendered = toolRequestPrompt(
    contextReferencePrompt(original, [
      {
        nodeId: "reference",
        revision: 0,
        prompt: "PRIVATE_REFERENCE_NOT_A_QUERY",
        response: "reference data",
      },
    ]),
    ["web_search"],
  );
  const result = await env.run(["web_search"], {
    prompt: rendered,
    displayPrompt: original,
  });
  assert.equal(received, true);
  assert.equal(env.faux.state.callCount, 1);
  assert.deepEqual(env.searches, [original]);
  assert.deepEqual(
    env.calls.map((call) => call.name),
    ["web_search"],
  );
  const assistant = result.messages.find(
    (message) =>
      message.role === "assistant" && message.stopReason === "toolUse",
  );
  assert.ok(assistant && assistant.role === "assistant");
  assert.equal(
    assistant.diagnostics?.some(
      (diagnostic) => diagnostic.type === "panel_tool_request_bootstrap",
    ),
    true,
  );
  assert.deepEqual(env.snapshots.at(-1), result.messages);
  assert.equal(
    result.messages.some(
      (message) =>
        message.role === "toolResult" &&
        message.toolName === "web_search" &&
        !message.isError,
    ),
    true,
  );
});

test("@computer_use invokes schema discovery and list_apps through ordinary preparation and approval gates", async (t) => {
  const env = fixture(t, [
    (context) => {
      assert.deepEqual(
        env.calls.map((call) => call.name),
        ["computer_use_tools", "computer_use_call"],
      );
      assert.equal(
        env.driver.calls.filter((call) => call.name === "list_apps").length,
        1,
      );
      const { records, text } = projectedRecords(context.messages);
      assert.deepEqual(
        records.map((record) => [record.tool, record.status]),
        [
          ["computer_use_tools", "completed"],
          ["computer_use_call", "completed"],
        ],
      );
      assert.match(text, /Visible applications: Test Browser/);
      assert.equal(
        context.messages.some((message) => message.role === "toolResult"),
        false,
      );
      return fauxAssistantMessage(
        "The requested desktop capability was invoked.",
      );
    },
  ]);
  const result = await env.run(["computer_use"]);
  assert.deepEqual(env.dispatched, ["computer_use_tools", "computer_use_call"]);
  assert.equal(env.faux.state.callCount, 1);
  assert.deepEqual([...env.driver.closed], ["tool-request-session-1"]);
  assert.deepEqual(
    result.messages
      .filter((message) => message.role === "toolResult")
      .map((message) => [message.toolName, message.isError]),
    [
      ["computer_use_tools", false],
      ["computer_use_call", false],
    ],
  );
  assert.deepEqual(env.snapshots.at(-1), result.messages);
});

test("denying the selected desktop bootstrap stops its dependent call without blocking a separate selected search", async (t) => {
  const env = fixture(t, [
    (context) => {
      assert.deepEqual(
        env.calls.map((call) => call.name),
        ["web_search", "computer_use_tools"],
      );
      assert.deepEqual(env.dispatched, ["web_search"]);
      assert.equal(env.driver.sessions.length, 0);
      assert.equal(env.driver.calls.length, 0);
      const { records } = projectedRecords(context.messages);
      assert.deepEqual(
        records.map((record) => [record.tool, record.status]),
        [
          ["web_search", "completed"],
          ["computer_use_tools", "error_or_denied"],
          ["computer_use_call", "error_or_denied"],
        ],
      );
      assert.equal(
        context.messages.some((message) => message.role === "toolResult"),
        false,
      );
      return fauxAssistantMessage("Search completed; computer use was denied.");
    },
  ]);
  env.deny((call) => call.name !== "computer_use_tools");
  const result = await env.run(["computer_use", "web_search"]);
  assert.equal(env.searches.length, 1);
  assert.equal(env.faux.state.callCount, 1);
  assert.deepEqual(
    result.messages
      .filter((message) => message.role === "toolResult")
      .map((message) => [message.toolName, message.isError]),
    [
      ["web_search", false],
      ["computer_use_tools", true],
      ["computer_use_call", true],
    ],
  );
});

test("denying @web_search records the denial without calling the search provider", async (t) => {
  const env = fixture(t, [
    (context) => {
      assert.equal(env.searches.length, 0);
      const { records } = projectedRecords(context.messages);
      assert.deepEqual(
        records.map((record) => [record.tool, record.status]),
        [["web_search", "error_or_denied"]],
      );
      return fauxAssistantMessage("The selected search was denied.");
    },
  ]);
  env.deny(() => false);
  const result = await env.run(["web_search"]);
  assert.deepEqual(env.dispatched, []);
  assert.equal(env.calls.length, 1);
  assert.equal(
    result.messages.some(
      (message) =>
        message.role === "toolResult" &&
        message.toolName === "web_search" &&
        message.isError,
    ),
    true,
  );
});

test("historical @ intent and literal @ text do not invoke a tool again without current selection", async (t) => {
  const env = fixture(t, [
    (context) => {
      assert.equal(env.calls.length, 0);
      assert.equal(env.searches.length, 0);
      assert.equal(env.driver.sessions.length, 0);
      assert.equal(
        context.messages.filter((message) => message.role === "toolResult")
          .length,
        0,
      );
      return fauxAssistantMessage("I am analyzing the existing information.");
    },
  ]);
  const history: Message[] = [
    {
      role: "user",
      content: toolRequestPrompt("此前选择了搜索", [
        "web_search",
        "computer_use",
      ]),
      timestamp: 1,
    },
    fauxAssistantMessage("Historical result", { timestamp: 2 }),
  ];
  await env.run(undefined, {
    history,
    prompt: "解释 @web_search 这段文字，不执行操作",
  });
  assert.equal(env.faux.state.callCount, 1);
});

test("provider projection keeps genuine assistant tool calls and thinking signatures intact", async (t) => {
  const signature = "provider-issued-thinking-signature";
  const followup = fauxAssistantMessage(
    [
      {
        type: "thinking",
        thinking: "A follow-up search is needed.",
        thinkingSignature: signature,
      },
      fauxToolCall(
        "web_search",
        { query: "provider follow-up query" },
        { id: "provider-follow-up" },
      ),
    ],
    { stopReason: "toolUse" },
  );
  const env = fixture(t, [
    (context) => {
      projectedRecords(context.messages);
      return followup;
    },
    (context) => {
      projectedRecords(context.messages);
      const genuine = context.messages.find(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (part) =>
              part.type === "toolCall" && part.id === "provider-follow-up",
          ),
      );
      assert.ok(genuine && genuine.role === "assistant");
      assert.deepEqual(
        genuine.content.find((part) => part.type === "thinking"),
        followup.content[0],
      );
      const result = context.messages.find(
        (message) =>
          message.role === "toolResult" &&
          message.toolCallId === "provider-follow-up",
      );
      assert.ok(result && result.role === "toolResult" && !result.isError);
      assert.equal(
        context.messages.filter((message) => message.role === "toolResult")
          .length,
        1,
      );
      return fauxAssistantMessage("Both actual search results were received.");
    },
  ]);
  const result = await env.run(["web_search"], { prompt: "original query" });
  assert.deepEqual(env.searches, [
    "original query",
    "provider follow-up query",
  ]);
  assert.equal(env.faux.state.callCount, 2);
  assert.equal(
    result.messages.filter(
      (message) =>
        message.role === "assistant" && message.stopReason === "toolUse",
    ).length,
    2,
  );
  assert.equal(
    result.messages.filter((message) => message.role === "toolResult").length,
    2,
  );
  assert.deepEqual(env.snapshots.at(-1), result.messages);
});

test("explicit desktop selection fails before model calls when the driver or image input is unavailable", async (t) => {
  const missing = fixture(t, [fauxAssistantMessage("Should not run")]);
  missing.driver.installed = false;
  await assert.rejects(missing.run(["computer_use"]), /电脑控制|驱动|安装/);
  assert.equal(missing.faux.state.callCount, 0);
  const textOnly = fixture(t, [fauxAssistantMessage("Should not run")], false);
  await assert.rejects(textOnly.run(["computer_use"]), /图片/);
  assert.equal(textOnly.faux.state.callCount, 0);
  assert.equal(textOnly.driver.calls.length, 0);
});
