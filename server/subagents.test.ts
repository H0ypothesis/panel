import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { SubagentRun } from "../shared/types.ts";
import type { ChildSession, ChildSessionLaunch } from "./nicobailon-engine.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Subagents } from "./subagents.ts";
import { createToolRequestBootstrap } from "./tool-request-bootstrap.ts";
import { fauxProvider } from "@earendil-works/pi-ai";
import { validateToolRequests, toolRequestPrompt } from "./tool-requests.ts";

function scriptedChild(
  run: (
    task: string,
    signal: AbortSignal,
    launch: ChildSessionLaunch,
  ) => Promise<string>,
) {
  return async (
    id: string,
    launch: ChildSessionLaunch,
  ): Promise<ChildSession> => {
    const listeners = new Set<
      (event: { type: string; [key: string]: unknown }) => void
    >();
    const messages: AgentMessage[] = [];
    const controller = new AbortController();
    let pending: Promise<void> | undefined;
    return {
      sessionId: id,
      sessionFile: undefined,
      modelId: "panel-test",
      messages,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      prompt(task) {
        pending = (async () => {
          try {
            const text = await run(task, controller.signal, launch);
            const message = fauxAssistantMessage(text);
            message.usage = {
              ...message.usage,
              input: 2,
              output: 3,
              totalTokens: 5,
            };
            messages.push(message);
            for (const listener of listeners)
              listener({ type: "message_end", message });
          } finally {
            for (const listener of listeners)
              listener({ type: "agent_settled" });
          }
        })();
        return pending;
      },
      async steer() {},
      async followUp() {},
      async abort() {
        controller.abort();
      },
      async dispose() {
        controller.abort();
        await pending?.catch(() => {});
      },
    };
  };
}

test("@subagents bootstraps capability without inventing delegated work", async () => {
  assert.deepEqual(
    validateToolRequests(["subagents", "web_search", "computer_use"]),
    ["web_search", "computer_use", "subagents"],
  );
  const model = fauxProvider({ models: [{ id: "test" }] }).getModel();
  const message = await createToolRequestBootstrap(
    ["subagents"],
    "inspect",
    model,
  )!.result();
  assert.deepEqual(
    message.content.map((part) => part.type === "toolCall" && part.name),
    ["subagents_enable"],
  );
  assert.match(
    toolRequestPrompt("inspect", ["subagents"]),
    /实际调用 subagent/,
  );
});

for (const concurrency of [undefined, 1, 2, 6, 8]) {
  test(`installed nicobailon engine respects concurrency ${concurrency ?? "default (4)"} and returns queued results`, async () => {
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const timer = setTimeout(release, 10000);
    const updates = new Map<string, SubagentRun>();
    const service = new Subagents({
      maxConcurrentSubagents: concurrency,
      cwd: process.cwd(),
      model: "openai/panel-test",
      thinking: "off",
      signal: new AbortController().signal,
      onUpdate: (run) => updates.set(run.id, run),
      persistOutput: async () => {},
      createChildSession: scriptedChild(async (task, _signal, launch) => {
        peak = Math.max(peak, ++active);
        if (active === (concurrency ?? 4)) {
          clearTimeout(timer);
          release();
        }
        assert.ok(!launch.tools?.includes("subagent"));
        assert.ok(
          launch.tools?.includes("write"),
          "native scout can write context files",
        );
        await gate;
        await delay(1);
        active--;
        return `result ${task}`;
      }),
    });
    try {
      const result = await service.tools()[1].execute("batch", {
        tasks: Array.from({ length: 8 }, (_, i) => ({
          agent: "scout",
          task: `task-${i}`,
        })),
      });
      assert.equal(peak, concurrency ?? 4);
      assert.equal(updates.size, 8);
      for (const run of updates.values()) {
        assert.equal(run.status, "completed", run.error);
        assert.match(run.response, /task-/);
      }
      assert.match(JSON.stringify(result.content), /task-6/);
      assert.equal(service.usage().total, 40);
    } finally {
      clearTimeout(timer);
      release();
      await service.close();
    }
  });
}

test("cancellation settles both active and queued children and waits for their cleanup", async () => {
  const controller = new AbortController();
  const updates = new Map<string, SubagentRun>();
  let cleaned = 0;
  let started = 0;
  const service = new Subagents({
    cwd: process.cwd(),
    model: "openai/panel-test",
    thinking: "off",
    signal: controller.signal,
    onUpdate: (run) => updates.set(run.id, run),
    persistOutput: async () => {},
    createChildSession: scriptedChild(async (_task, signal) => {
      started++;
      if (started === 4) controller.abort();
      try {
        await delay(10000, undefined, { signal });
      } finally {
        cleaned++;
      }
      return "";
    }),
  });
  const running = service.tools()[1].execute("batch", {
    tasks: Array.from({ length: 5 }, () => ({
      agent: "worker",
      task: "wait",
    })),
  });
  await assert.rejects(running);
  await service.close();
  assert.equal(started, 4);
  assert.equal(cleaned, 4);
  assert.equal(updates.size, 5);
  assert.ok([...updates.values()].every((run) => run.status === "cancelled"));
});
