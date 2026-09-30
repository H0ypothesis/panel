import assert from "node:assert/strict";
import test from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import type { RunInput } from "../shared/types.ts";
import { PiRuntime, type RunEnvironment } from "./runtime.ts";

const input = (id: string, mode: RunInput["mode"]): RunInput => ({
  id,
  mode,
  text: id,
  status: "queued",
  createdAt: 2,
});

test("native steering waits for the entire tool batch and follow-up waits for the final answer", async (t) => {
  const faux = fauxProvider({
    provider: "openai",
    models: [{ id: "input-fixture", contextWindow: 128000, maxTokens: 4096 }],
    tokensPerSecond: 1000000,
    tokenSize: { min: 2000, max: 3000 },
  });
  const registry = createModels();
  registry.setProvider(faux.provider);
  const runtime = new PiRuntime(registry, {
    runNativePlugin: async () => ({ text: "tool result", sources: [] }),
  });
  t.after(() => runtime.close());
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const toolsStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const executions: string[] = [],
    approvals: string[] = [],
    delivered: string[] = [];
  const snapshots: Message[][] = [];
  let send: ((message: RunInput) => void) | undefined;
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("web_search", { query: "first" }, { id: "first" }),
        fauxToolCall("web_search", { query: "second" }, { id: "second" }),
      ],
      { stopReason: "toolUse" },
    ),
    (context) => {
      assert.deepEqual(executions, ["first", "second"]);
      assert.match(JSON.stringify(context.messages), /steering-input/);
      assert.doesNotMatch(JSON.stringify(context.messages), /followup-input/);
      assert.equal(
        context.messages.filter((message) => message.role === "toolResult")
          .length,
        2,
      );
      return fauxAssistantMessage("redirected answer");
    },
    (context) => {
      assert.match(JSON.stringify(context.messages), /redirected answer/);
      assert.match(JSON.stringify(context.messages), /followup-input/);
      return fauxAssistantMessage("follow-up answer");
    },
  ]);
  const environment: RunEnvironment = {
    beforeToolCall: async (call) => {
      approvals.push(call.id);
      return true;
    },
    executeTool: async (call, execute) => {
      started();
      await gate;
      executions.push(call.id);
      return execute();
    },
    onToolUpdate: () => {},
  };
  const running = runtime.run(
    { model: "openai/input-fixture", thinking: "off" },
    [],
    "original task",
    new AbortController().signal,
    () => {},
    environment,
    {
      autoCompact: false,
      sources: [{ nodeId: "current", revision: 0, messageCount: 0 }],
      onRunInputReady: (handler) => {
        send = handler;
      },
      onRunInputDelivered: (id) => {
        delivered.push(id);
      },
      onMessages: async (messages) => {
        snapshots.push(structuredClone(messages));
      },
    },
  );
  await toolsStarted;
  assert.ok(send);
  send(input("steering-input", "steer"));
  send(input("followup-input", "followUp"));
  assert.deepEqual(delivered, []);
  release();
  const result = await running;
  assert.deepEqual(approvals, ["first", "second"]);
  assert.deepEqual(delivered, ["steering-input", "followup-input"]);
  assert.equal(result.response, "redirected answer\n\nfollow-up answer");
  assert.equal(send, undefined);
  assert.equal(
    result.messages.filter((message) => message.role === "user").length,
    3,
  );
  assert.ok(snapshots.some((messages) => messages.at(-1)?.role === "user"));
});

test("input during text streaming guides the next request and abort leaves undelivered queues unused", async (t) => {
  for (const abort of ["none", "streaming", "delivery"] as const) {
    const faux = fauxProvider({
      provider: "openai",
      models: [{ id: "text-input", contextWindow: 128000, maxTokens: 4096 }],
      tokensPerSecond: 1000000,
      tokenSize: { min: 4, max: 9 },
    });
    const registry = createModels();
    registry.setProvider(faux.provider);
    const runtime = new PiRuntime(registry);
    t.after(() => runtime.close());
    const controller = new AbortController();
    let send: ((message: RunInput) => void) | undefined;
    let sent = false;
    const delivered: string[] = [];
    let messages: Message[] = [];
    faux.setResponses([
      fauxAssistantMessage("original streamed answer"),
      (context) => {
        assert.match(JSON.stringify(context.messages), /streamed guidance/);
        return fauxAssistantMessage("revised answer");
      },
    ]);
    const running = runtime.run(
      { model: "openai/text-input", thinking: "off" },
      [],
      "task",
      controller.signal,
      () => {},
      undefined,
      {
        autoCompact: false,
        sources: [{ nodeId: "current", revision: 0, messageCount: 0 }],
        onRunInputReady: (handler) => {
          send = handler;
        },
        onRunInputDelivered: (id) => {
          delivered.push(id);
        },
        onMessages: async (snapshot) => {
          messages = snapshot;
        },
        onAgentEvent: (event) => {
          if (
            !sent &&
            event.type === "message_update" &&
            event.assistantMessageEvent.type === "text_delta"
          ) {
            sent = true;
            send!(input("streamed guidance", "steer"));
            if (abort === "streaming") controller.abort();
          }
          if (
            abort === "delivery" &&
            event.type === "message_start" &&
            event.message.role === "user" &&
            event.message.content === "streamed guidance"
          )
            controller.abort();
        },
      },
    );
    if (abort !== "none") {
      await assert.rejects(running);
      assert.deepEqual(delivered, []);
      assert.equal(faux.state.callCount, 1);
      assert.equal(
        messages.filter(
          (message) =>
            message.role === "user" && message.content === "streamed guidance",
        ).length,
        0,
      );
    } else {
      const result = await running;
      assert.deepEqual(delivered, ["streamed guidance"]);
      assert.equal(
        result.response,
        "original streamed answer\n\nrevised answer",
      );
    }
    assert.equal(send, undefined);
  }
});
