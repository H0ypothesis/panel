import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
  type JsonObject,
  type Message,
} from "@earendil-works/pi-ai";
import type { RunConfig, ToolRequest } from "../shared/types.ts";
import {
  ComputerUse,
  type ComputerDriver,
  type ComputerSession,
} from "./computer-use.ts";
import { PiRuntime, type RunEnvironment } from "./runtime.ts";

const config: RunConfig = { model: "openai/long-task-test", thinking: "off" };
const toolReply = (name: string, args: JsonObject, id?: string) =>
  fauxAssistantMessage(fauxToolCall(name, args, { id }), {
    stopReason: "toolUse",
  });
const webReplies = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    toolReply("web_search", { query: `fixture query ${index}` }),
  );
const finished = () => fauxAssistantMessage("finished all steps");

class FakeDriver implements ComputerDriver {
  calls: string[] = [];
  sessions = 0;
  closedSessions = 0;
  fail = false;
  getStatus() {
    return { installed: true, state: "ready", version: "fixture" };
  }
  async openSession(): Promise<ComputerSession> {
    this.sessions++;
    if (this.fail) throw new Error("fixture native startup failed");
    return {
      id: `fixture-session-${this.sessions}`,
      generation: 1,
      listTools: async () => [
        {
          name: "list_apps",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
      callTool: async (name) => {
        this.calls.push(name);
        return name === "check_permissions"
          ? {
              structuredContent: {
                accessibility: true,
                screen_recording: true,
              },
            }
          : { content: [{ type: "text", text: "fixture applications" }] };
      },
      close: async () => {
        this.closedSessions++;
      },
    };
  }
  async close() {}
}

function fixture(t: TestContext, responses: FauxResponseStep[]) {
  const faux = fauxProvider({
    provider: "openai",
    models: [
      {
        id: "long-task-test",
        input: ["text", "image"],
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
  const runtime = new PiRuntime(
    registry,
    {
      runPlugin: async () => ({ text: "fixture web result", sources: [] }),
    },
    new ComputerUse(driver),
  );
  const controller = new AbortController();
  const authorized = new Set<string>();
  const approvals: string[] = [];
  const executed: string[] = [];
  let messages: Message[] = [];
  let decision = (_name: string) => true;
  let onExecution = (_name: string) => {};
  let terminate = false;
  const environment: RunEnvironment = {
    beforeToolCall: async (call, prepare) => {
      await prepare?.(() => {});
      approvals.push(call.name);
      const allowed = decision(call.name);
      if (allowed) authorized.add(call.id);
      return allowed;
    },
    executeTool: async (call, execute) => {
      assert.equal(
        authorized.delete(call.id),
        true,
        "every execution still requires normal authorization",
      );
      executed.push(call.name);
      onExecution(call.name);
      const result = await execute();
      return terminate && result && typeof result === "object"
        ? { ...result, terminate: true }
        : result;
    },
    onToolUpdate: () => {},
  };
  t.after(async () => {
    controller.abort();
    await runtime.close();
  });
  return {
    faux,
    driver,
    approvals,
    executed,
    controller,
    get messages() {
      return messages;
    },
    deny: (name: string) => {
      decision = (candidate) => candidate !== name;
    },
    afterExecution: (callback: typeof onExecution) => {
      onExecution = callback;
    },
    terminateTools: () => {
      terminate = true;
    },
    run: (
      options: {
        longTask?: boolean;
        requests?: ToolRequest[];
        history?: Message[];
        prompt?: string;
      } = {},
    ) =>
      runtime.run(
        {
          ...config,
          ...(options.longTask !== undefined
            ? { longTask: options.longTask }
            : {}),
        },
        options.history ?? [],
        options.prompt ?? "Complete the fixture steps",
        controller.signal,
        () => {},
        environment,
        {
          autoCompact: false,
          toolRequests: options.requests,
          sources: [
            {
              nodeId: "history",
              revision: 0,
              messageCount: options.history?.length ?? 0,
            },
            { nodeId: "current", revision: 0, messageCount: 0 },
          ],
          onMessages: async (snapshot) => {
            messages = structuredClone(snapshot);
          },
        },
      ),
  };
}

for (const longTask of [undefined, false])
  test(`ordinary tasks retain exactly 40 model replies (${String(longTask)})`, async (t) => {
    const f = fixture(t, [...webReplies(41), finished()]);
    await assert.rejects(f.run({ longTask }), /40 次模型回复/);
    assert.equal(f.faux.state.callCount, 40);
    assert.equal(f.executed.length, 40);
    assert.equal(
      f.messages.filter((message) => message.role === "assistant").length,
      40,
    );
  });

test("manual long task completes beyond reply 40 with approvals unchanged", async (t) => {
  const f = fixture(t, [...webReplies(41), finished()]);
  const result = await f.run({ longTask: true });
  assert.equal(f.faux.state.callCount, 42);
  assert.equal(f.executed.length, 41);
  assert.equal(f.approvals.length, 41);
  assert.equal(result.response, "finished all steps");
});

test("explicit current computer-use selection automatically enables long execution", async (t) => {
  const f = fixture(t, [...webReplies(40), finished()]);
  const result = await f.run({ requests: ["computer_use"] });
  assert.equal(f.faux.state.callCount, 41);
  assert.equal(result.response, "finished all steps");
  assert.deepEqual(f.executed.slice(0, 2), [
    "computer_use_tools",
    "computer_use_call",
  ]);
  assert.ok(f.driver.calls.includes("list_apps"));
});

test("model-triggered CUA discovery on reply 40 lifts the limit before the stop check", async (t) => {
  const f = fixture(t, [
    ...webReplies(39),
    toolReply("computer_use_tools", { group: "core" }),
    toolReply("computer_use_call", { tool: "list_apps", arguments: {} }),
    ...webReplies(1),
    finished(),
  ]);
  const result = await f.run();
  assert.equal(f.faux.state.callCount, 43);
  assert.equal(result.response, "finished all steps");
  assert.ok(f.driver.calls.includes("list_apps"));
});

test("approved CUA capability execution still enables long mode if driver startup fails", async (t) => {
  const f = fixture(t, [
    toolReply("computer_use_tools", { group: "core" }),
    ...webReplies(40),
    finished(),
  ]);
  f.driver.fail = true;
  const result = await f.run();
  assert.equal(f.faux.state.callCount, 42);
  assert.equal(result.response, "finished all steps");
  assert.ok(
    f.messages.some(
      (message) => message.role === "toolResult" && message.isError,
    ),
  );
});

for (const kind of [
  "denied",
  "malformed",
  "unregistered",
  "release_only",
] as const)
  test(`${kind} CUA calls do not count as capability execution`, async (t) => {
    const cua =
      kind === "malformed"
        ? toolReply("computer_use_tools", { group: "not_a_group" })
        : kind === "unregistered"
          ? toolReply("computer_use_unknown", {})
          : kind === "release_only"
            ? toolReply("computer_use_release", {})
            : toolReply("computer_use_tools", { group: "core" });
    const f = fixture(t, [...webReplies(39), cua, finished()]);
    if (kind === "denied") f.deny("computer_use_tools");
    await assert.rejects(f.run(), /40 次模型回复/);
    assert.equal(f.faux.state.callCount, 40);
    assert.equal(f.driver.sessions, 0);
  });

test("CUA mentions and inherited successful CUA history do not enable the current run", async (t) => {
  const historical = toolReply(
    "computer_use_tools",
    { group: "core" },
    "old-cua-call",
  );
  const f = fixture(t, [...webReplies(41), finished()]);
  await assert.rejects(
    f.run({
      prompt: "Only mentioning computer_use; do not use it in this task",
      history: [
        { role: "user", content: "old request", timestamp: 1 },
        historical,
        {
          role: "toolResult",
          toolCallId: "old-cua-call",
          toolName: "computer_use_tools",
          content: [{ type: "text", text: "old successful discovery" }],
          isError: false,
          timestamp: 2,
        },
        finished(),
      ],
    }),
    /40 次模型回复/,
  );
  assert.equal(f.faux.state.callCount, 40);
  assert.equal(f.driver.sessions, 0);
});

test("host-generated web bootstrap does not consume a model reply", async (t) => {
  const f = fixture(t, [...webReplies(41), finished()]);
  await assert.rejects(f.run({ requests: ["web_search"] }), /40 次模型回复/);
  assert.equal(f.faux.state.callCount, 40);
  assert.equal(
    f.executed.length,
    41,
    "one host bootstrap plus forty model tool calls",
  );
  assert.equal(
    f.messages.filter((message) => message.role === "assistant").length,
    41,
  );
});

test("a normal final answer on reply 40 is not reported as a limit failure", async (t) => {
  const f = fixture(t, [...webReplies(39), finished()]);
  const result = await f.run();
  assert.equal(f.faux.state.callCount, 40);
  assert.equal(result.response, "finished all steps");
});

test("non-limit tool-use termination receives no false 40-reply explanation", async (t) => {
  const f = fixture(t, [toolReply("web_search", { query: "fixture" })]);
  f.terminateTools();
  await assert.rejects(f.run(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /模型在工具调用后停止/);
    assert.doesNotMatch(error.message, /40/);
    return true;
  });
  assert.equal(f.faux.state.callCount, 1);
});

test("long tasks still stop immediately on user cancellation after reply 40", async (t) => {
  const f = fixture(t, [...webReplies(45), finished()]);
  f.afterExecution(() => {
    if (f.executed.length === 41)
      f.controller.abort(new Error("user stopped long task"));
  });
  await assert.rejects(f.run({ longTask: true }), /user stopped long task/);
  assert.equal(f.faux.state.callCount, 41);
});

test("long tasks retain provider errors after reply 40", async (t) => {
  const f = fixture(t, [
    ...webReplies(41),
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "fixture provider failure",
    }),
  ]);
  await assert.rejects(f.run({ longTask: true }), /fixture provider failure/);
  assert.equal(f.faux.state.callCount, 42);
});

for (const reason of ["error", "aborted", "length"] as const)
  test(`reply 40 preserves ${reason} instead of reporting the turn limit`, async (t) => {
    const f = fixture(t, [
      ...webReplies(39),
      fauxAssistantMessage("partial reply", {
        stopReason: reason,
        ...(reason === "length" ? {} : { errorMessage: `fixture ${reason}` }),
      }),
      finished(),
    ]);
    await assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        reason === "length" ? /输出限制/ : new RegExp(`fixture ${reason}`),
      );
      assert.doesNotMatch(error.message, /40 次模型回复/);
      return true;
    });
    assert.equal(f.faux.state.callCount, 40);
    assert.equal(f.executed.length, 39);
    assert.equal(f.messages.at(-1)?.role, "assistant");
  });

test("terminating tool batch on reply 40 keeps its original stop cause", async (t) => {
  const f = fixture(t, [...webReplies(40), finished()]);
  f.afterExecution(() => {
    if (f.executed.length === 40) f.terminateTools();
  });
  await assert.rejects(f.run(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /模型在工具调用后停止/);
    assert.doesNotMatch(error.message, /40 次模型回复/);
    return true;
  });
  assert.equal(f.faux.state.callCount, 40);
});
