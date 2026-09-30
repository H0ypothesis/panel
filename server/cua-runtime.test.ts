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
import type { ToolCall } from "../shared/types.ts";
import {
  ComputerUse,
  type ComputerDriver,
  type ComputerSession,
  type ComputerUseRun,
} from "./computer-use.ts";
import { PiRuntime, type RunEnvironment } from "./runtime.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5d8AAAAASUVORK5CYII=";
const config = { model: "openai/cua-runtime-test", thinking: "off" as const };
const target = { kind: "window" as const, pid: 100, windowId: 1 };
type Result = Awaited<ReturnType<ComputerSession["callTool"]>>;
type Call = Pick<ToolCall, "id" | "name" | "arguments">;

const observe = (id = "observe") =>
  fauxAssistantMessage(
    fauxToolCall(
      "computer_use_call",
      { tool: "get_window_state", target },
      { id },
    ),
    { stopReason: "toolUse" },
  );
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

class FakeDriver implements ComputerDriver {
  installed = true;
  readonly sessions: ComputerSession[] = [];
  readonly closed = new Set<string>();
  readonly calls: {
    sessionId: string;
    name: string;
    args: Record<string, unknown>;
  }[] = [];
  handler?: (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Result | Promise<Result>;
  getStatus() {
    return { installed: this.installed, state: "ready", version: "test" };
  }
  async openSession(): Promise<ComputerSession> {
    const id = `session-${this.sessions.length + 1}`;
    const pending = new Set<Promise<Result>>();
    const session: ComputerSession = {
      id,
      generation: 0,
      listTools: async () => [
        {
          name: "get_window_state",
          inputSchema: {
            type: "object",
            properties: {
              session: { type: "string" },
              pid: { type: "integer" },
              window_id: { type: "integer" },
            },
            required: ["session", "pid", "window_id"],
            additionalProperties: false,
          },
        } satisfies Tool,
      ],
      callTool: async (name, args, signal) => {
        this.calls.push({ sessionId: id, name, args: structuredClone(args) });
        if (name === "check_permissions")
          return {
            structuredContent: { accessibility: true, screen_recording: true },
          };
        const result = (async () => {
          const result = this.handler
            ? await this.handler(name, args, signal)
            : {
                content: [
                  { type: "text", text: "Visible target window" },
                  { type: "image", mimeType: "image/png", data: png },
                ],
                structuredContent: { elements: [{ id: "e1", role: "button" }] },
              };
          // A canceled in-flight driver operation is drained before rejection.
          signal?.throwIfAborted();
          return result;
        })();
        pending.add(result);
        try {
          return await result;
        } finally {
          pending.delete(result);
        }
      },
      close: async () => {
        await Promise.allSettled([...pending]);
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

class TrackedComputerUse extends ComputerUse {
  readonly runs: ComputerUseRun[] = [];
  override newRun(supportsImages: boolean) {
    const run = super.newRun(supportsImages);
    this.runs.push(run);
    return run;
  }
}

function fixture(t: TestContext, responses: FauxResponseStep[]) {
  const faux = fauxProvider({
    provider: "openai",
    models: [
      {
        id: "cua-runtime-test",
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    tokensPerSecond: 1000000,
    tokenSize: { min: 2000, max: 3000 },
  });
  const first = responses[0];
  const needsDiscovery =
    typeof first !== "function" &&
    first?.content.some(
      (part) => part.type === "toolCall" && part.name === "computer_use_call",
    );
  faux.setResponses(
    needsDiscovery
      ? [
          fauxAssistantMessage(
            fauxToolCall(
              "computer_use_tools",
              { group: "core" },
              { id: "catalog" },
            ),
            { stopReason: "toolUse" },
          ),
          ...responses,
        ]
      : responses,
  );
  const registry = createModels();
  registry.setProvider(faux.provider);
  const driver = new FakeDriver();
  const computer = new TrackedComputerUse(driver);
  const runtime = new PiRuntime(registry, undefined, computer);
  const snapshots: Message[][] = [];
  const prepared: string[] = [];
  const approved = new Set<string>();
  const updates: {
    id: string;
    update: Parameters<RunEnvironment["onToolUpdate"]>[1];
  }[] = [];
  let decision: (call: Call) => boolean | Promise<boolean> = () => true;
  const execution: RunEnvironment = {
    beforeToolCall: async (call, prepare) => {
      if (call.name === "computer_use_call") {
        assert.ok(
          prepare,
          "runtime must supply target preparation before approval",
        );
        await prepare(() => {});
        prepared.push(call.id);
        assert.ok(computer.locks.getTarget(computer.runs.at(-1)!.id));
      } else assert.equal(prepare, undefined);
      const allow = await decision(call);
      if (allow) approved.add(call.id);
      return allow;
    },
    executeTool: async (call, execute) => {
      assert.equal(
        approved.delete(call.id),
        true,
        "only independently approved calls may execute",
      );
      return execute();
    },
    onToolUpdate: (id, update) => {
      updates.push({ id, update: structuredClone(update) });
    },
  };
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await runtime.close();
  });
  const run = () =>
    runtime.run(
      config,
      [],
      "Inspect the requested window",
      controller.signal,
      () => {},
      execution,
      {
        autoCompact: false,
        sources: [{ nodeId: "current", revision: 0, messageCount: 0 }],
        onMessages: async (messages) => {
          snapshots.push(structuredClone(messages));
        },
      },
    );
  return {
    faux,
    driver,
    computer,
    runtime,
    snapshots,
    prepared,
    updates,
    execution,
    controller,
    run,
    setDecision: (value: typeof decision) => {
      decision = value;
    },
  };
}

test("PiRuntime advertises CUA wrappers alongside web tools only when the driver is installed", async (t) => {
  for (const installed of [true, false]) {
    await t.test(installed ? "installed" : "not installed", async (t) => {
      let inspected = false;
      const env = fixture(t, [
        (context) => {
          const names = context.messages
            .flatMap((message) =>
              message.role === "system" ? (message.toolsAdded ?? []) : [],
            )
            .map((tool) => tool.name);
          assert.deepEqual(
            names,
            installed
              ? [
                  "web_search",
                  "fetch_content",
                  "get_search_content",
                  "source_check",
                  "subagents_enable",
                  "subagent",
                  "computer_use_tools",
                  "computer_use_call",
                  "computer_use_release",
                ]
              : [
                  "web_search",
                  "fetch_content",
                  "get_search_content",
                  "source_check",
                  "subagents_enable",
                  "subagent",
                ],
          );
          inspected = true;
          return fauxAssistantMessage("Tools are available.");
        },
      ]);
      env.driver.installed = installed;
      await env.run();
      assert.equal(inspected, true);
      assert.equal(env.driver.calls.length, 0);
      assert.equal(env.driver.sessions.length, 0);
    });
  }
});

test("PiRuntime prepares and approves the target before dispatch and retains native screenshots in model context and messages", async (t) => {
  let sawImage = false;
  const env = fixture(t, [
    observe(),
    (context) => {
      const result = context.messages.find(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "computer_use_call",
      );
      assert.ok(result && result.role === "toolResult");
      assert.equal(result.isError, false);
      assert.deepEqual(
        result.content.find((part) => part.type === "image"),
        { type: "image", mimeType: "image/png", data: png },
      );
      sawImage = true;
      return fauxAssistantMessage("The target window is visible.");
    },
  ]);
  const result = await env.run();
  assert.equal(sawImage, true);
  assert.deepEqual(env.prepared, ["observe"]);
  const observations = env.driver.calls.filter(
    (call) => call.name === "get_window_state",
  );
  assert.equal(observations.length, 1);
  assert.deepEqual(observations[0].args, {
    pid: 100,
    window_id: 1,
    session: "session-1",
  });
  assert.deepEqual(env.computer.status().permissions, {
    accessibility: true,
    screenRecording: true,
  });
  assert.deepEqual(
    env.driver.calls
      .filter((call) => call.name === "check_permissions")
      .map((call) => call.args),
    [{ prompt: false }],
  );
  assert.equal(env.updates.at(-1)?.update.status, "completed");
  assert.ok(
    env.snapshots.some((messages) =>
      messages.some(
        (message) =>
          message.role === "toolResult" &&
          message.content.some(
            (part) => part.type === "image" && part.data === png,
          ),
      ),
    ),
  );
  assert.deepEqual(env.snapshots.at(-1), result.messages);
  assert.equal(
    env.computer.locks.getTarget(env.computer.runs[0].id),
    undefined,
  );
  assert.deepEqual([...env.driver.closed], ["session-1"]);
});

test("driver error results become failed tool events and failed model tool results", async (t) => {
  const env = fixture(t, [
    observe(),
    (context) => {
      const result = context.messages.find(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "computer_use_call",
      );
      assert.ok(result && result.role === "toolResult" && result.isError);
      assert.match(
        result.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("\n"),
        /fake driver rejected target/,
      );
      return fauxAssistantMessage("The desktop operation failed.");
    },
  ]);
  env.driver.handler = async () => ({
    isError: true,
    content: [{ type: "text", text: "fake driver rejected target" }],
  });
  await env.run();
  const update = env.updates.at(-1)!.update;
  assert.equal(update.status, "failed");
  assert.match(update.error!, /fake driver rejected target/);
  assert.equal(
    env.computer.locks.getTarget(env.computer.runs[0].id),
    undefined,
  );
  assert.deepEqual([...env.driver.closed], ["session-1"]);
});

for (const denial of ["denied", "approval-error"] as const) {
  test(`PiRuntime releases the prepared target when approval is ${denial}`, async (t) => {
    const env = fixture(t, [
      observe(),
      async (context) => {
        assert.equal(
          env.computer.locks.getTarget(env.computer.runs[0].id),
          undefined,
        );
        await env.computer.locks.acquireTarget("other-run", target);
        env.computer.locks.releaseOwner("other-run");
        assert.equal(
          context.messages.some(
            (message) => message.role === "toolResult" && message.isError,
          ),
          true,
        );
        return fauxAssistantMessage("The requested action did not run.");
      },
    ]);
    env.setDecision((call) => {
      if (call.name !== "computer_use_call") return true;
      if (denial === "approval-error") throw new Error("approval unavailable");
      return false;
    });
    await env.run();
    assert.deepEqual(env.prepared, ["observe"]);
    assert.equal(
      env.driver.calls.some((call) => call.name === "get_window_state"),
      false,
    );
    assert.equal(env.driver.sessions.length, 1);
  });
}

test("cancellation drains an active native call before per-run cleanup releases its target", async (t) => {
  const env = fixture(t, [
    observe(),
    fauxAssistantMessage("Should be canceled"),
  ]);
  const started = gate<void>();
  const finish = gate<Result>();
  env.driver.handler = async () => {
    started.resolve();
    return finish.promise;
  };
  const running = env.run();
  const rejected = assert.rejects(running, /cancel runtime/);
  await started.promise;
  const owner = env.computer.runs[0].id;
  env.controller.abort(new Error("cancel runtime"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(env.computer.locks.getTarget(owner));
  assert.equal(env.driver.closed.size, 0);
  finish.resolve({ content: [{ type: "text", text: "operation settled" }] });
  await rejected;
  assert.equal(env.computer.locks.getTarget(owner), undefined);
  assert.deepEqual([...env.driver.closed], ["session-1"]);
  assert.ok(env.snapshots.length > 0);
});

test("a later model failure still closes the CUA session, releases the target, and persists its screenshot", async (t) => {
  const env = fixture(t, [
    observe(),
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "provider failed after observation",
    }),
  ]);
  await assert.rejects(env.run(), /provider failed after observation/);
  assert.equal(
    env.computer.locks.getTarget(env.computer.runs[0].id),
    undefined,
  );
  assert.deepEqual([...env.driver.closed], ["session-1"]);
  const snapshot = env.snapshots.at(-1)!;
  assert.equal(
    snapshot.some(
      (message) =>
        message.role === "toolResult" &&
        message.content.some(
          (part) => part.type === "image" && part.data === png,
        ),
    ),
    true,
  );
  assert.equal(snapshot.at(-1)?.role, "assistant");
});
