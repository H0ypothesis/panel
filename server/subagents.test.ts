import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { SubagentRun } from "../shared/types.ts";
import { Subagents } from "./subagents.ts";
import { createToolRequestBootstrap } from "./tool-request-bootstrap.ts";
import { fauxProvider } from "@earendil-works/pi-ai";
import { validateToolRequests, toolRequestPrompt } from "./tool-requests.ts";

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

test("installed nicobailon engine executes independent children, caps parallelism at three and returns each result", async () => {
  let active = 0;
  let peak = 0;
  const updates = new Map<string, SubagentRun>();
  const service = new Subagents({
    cwd: process.cwd(),
    model: "openai/panel-test",
    thinking: "off",
    signal: new AbortController().signal,
    onUpdate: (run) => updates.set(run.id, run),
    runChild: async (child) => {
      peak = Math.max(peak, ++active);
      assert.ok(!child.allowedTools.includes("subagent"));
      assert.ok(!child.allowedTools.includes("write"));
      await delay(15);
      const message = fauxAssistantMessage(`result ${child.task}`);
      child.onText(`result ${child.task}`);
      child.onEvent({ type: "message_end", message });
      active--;
      return { usage: { input: 2, output: 3, total: 5, cost: 0 } };
    },
  });
  try {
    const result = await service
      .tools()[1]
      .execute("batch", {
        tasks: Array.from({ length: 7 }, (_, i) => ({
          agent: "scout",
          task: `task-${i}`,
        })),
      });
    assert.equal(peak, 3);
    assert.equal(updates.size, 7);
    for (const run of updates.values()) {
      assert.equal(run.status, "completed", run.error);
      assert.match(run.response, /result Task: task-/);
    }
    assert.match(JSON.stringify(result.content), /task-6/);
    assert.equal(service.usage().total, 35);
  } finally {
    await service.close();
  }
});

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
    runChild: async (child) => {
      started++;
      if (started === 3) controller.abort();
      try {
        await delay(10000, undefined, { signal: child.signal });
      } finally {
        cleaned++;
      }
      return {};
    },
  });
  const running = service
    .tools()[1]
    .execute("batch", {
      tasks: Array.from({ length: 5 }, () => ({
        agent: "worker",
        task: "wait",
      })),
    });
  await assert.rejects(running);
  await service.close();
  assert.equal(started, 3);
  assert.equal(cleaned, 3);
  assert.equal(updates.size, 5);
  assert.ok([...updates.values()].every((run) => run.status === "cancelled"));
});
