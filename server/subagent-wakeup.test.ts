import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { RunContextOptions, RunEnvironment, Runtime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import { createWorkspace } from "./seed.ts";

async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Parent did not reach expected state");
}

async function fixture(t: TestContext) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-wake-")),
  );
  const project = join(directory, "project");
  await mkdir(project);
  const store = new Store(join(directory, "state"));
  await store.init(false);
  const workspace = createWorkspace("Wake", "Background continuation");
  workspace.workingDirectory = project;
  store.data.workspaces.push(workspace);
  const runs: {
    history: Message[];
    prompt: string;
    environment: RunEnvironment;
    options?: RunContextOptions;
    finish: () => void;
  }[] = [];
  let active = 0,
    peak = 0;
  const runtime: Runtime = {
    models: () => [
      {
        id: "test/wake",
        name: "test",
        provider: "test",
        providerName: "test",
        available: true,
        demo: false,
        contextWindow: 128000,
        thinkingLevels: ["off"],
      },
    ],
    async run(_config, history, prompt, signal, onText, environment, options) {
      peak = Math.max(peak, ++active);
      let finish!: () => void;
      const wait = new Promise<void>((resolve) => {
        finish = resolve;
      });
      runs.push({
        history,
        prompt,
        environment: environment!,
        options,
        finish,
      });
      signal.addEventListener("abort", finish, { once: true });
      try {
        await wait;
        signal.throwIfAborted();
        const response = runs.length === 1 ? "已派出子代理。" : "已完成汇总。";
        const messages: Message[] = [
          { role: "user", content: prompt, timestamp: Date.now() },
          fauxAssistantMessage(response),
        ];
        onText(response);
        await options?.onMessages?.(messages);
        return {
          response,
          messages,
          usage: { input: 10, output: 5, total: 15, cost: 1 },
        };
      } finally {
        active--;
      }
    },
  };
  const scheduler = new Scheduler(store, runtime);
  const node = await scheduler.submit(workspace.id, {
    parentId: workspace.nodes[0].id,
    prompt: "研究原任务",
    requestId: "wake-test",
    config: { model: "test/wake", thinking: "off" },
    toolRequests: ["subagents"],
  });
  await until(() => runs.length === 1);
  const notify = (content: string, triggerTurn = true, kind = "message") =>
    runs[0].environment.onSubagentNotice!({
      kind,
      createdAt: Date.now(),
      value: {
        message: { customType: "subagent-notify", content },
        options: { triggerTurn },
      },
    });
  t.after(async () => {
    scheduler.shutdown();
    for (const run of runs) run.finish();
    await until(() => active === 0);
    await delay(20);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    store,
    workspace,
    scheduler,
    runtime,
    node,
    runs,
    notify,
    peak: () => peak,
  };
}

test("idle parent resumes once with existing history, without repeating explicit tools", async (t) => {
  const env = await fixture(t);
  env.runs[0].environment.onSubagentsEnabled!();
  env.runs[0].finish();
  await until(() => env.node.status === "completed");
  env.notify("incremental progress", false);
  env.notify("async complete event", true, "subagent:async-complete");
  await delay(20);
  assert.equal(env.runs.length, 1);
  env.notify("final report");
  await until(() => env.runs.length === 2);
  assert.equal(env.runs[1].history.length, env.runs[0].history.length + 2);
  assert.match(JSON.stringify(env.runs[1].history), /研究原任务/);
  assert.match(env.runs[1].prompt, /final report/);
  assert.doesNotMatch(env.runs[1].prompt, /incremental progress/);
  assert.equal(env.runs[1].options?.toolRequests, undefined);
  assert.equal(env.runs[1].options?.attachments, undefined);
  assert.equal(env.runs[1].environment.subagentsEnabled, true);
  assert.equal(
    env.node.config.longTask,
    undefined,
    "manual preference is unchanged",
  );
  env.runs[1].finish();
  await until(() => env.node.status === "completed");
  assert.equal(env.node.messages?.length, 4);
  assert.equal(env.node.contextSources?.at(-1)?.messageCount, 4);
  assert.equal(env.node.response, "已派出子代理。\n\n已完成汇总。");
  assert.equal(env.node.usage?.total, 30);
  assert.equal(env.peak(), 1);
});

test("completion during parent generation batches notices and wakes after it settles", async (t) => {
  const env = await fixture(t);
  env.notify("report A");
  env.notify("failed B: authentication rejected");
  await delay(20);
  assert.equal(env.runs.length, 1);
  env.runs[0].finish();
  await until(() => env.runs.length === 2);
  assert.match(env.runs[1].prompt, /report A/);
  assert.match(env.runs[1].prompt, /failed B/);
  // A later completion while the follow-up is running must not be dropped.
  env.notify("report C");
  env.runs[1].finish();
  await until(() => env.runs.length === 3);
  assert.match(env.runs[2].prompt, /report C/);
  assert.doesNotMatch(env.runs[2].prompt, /report A/);
  env.runs[2].finish();
  await until(() => env.node.status === "completed");
  assert.equal(env.node.messages?.length, 6);
  assert.equal(env.peak(), 1);
});

for (const state of ["running", "completed"] as const)
  test(`cancelling a ${state} parent suppresses pending and late wakeups`, async (t) => {
    const env = await fixture(t);
    if (state === "completed") {
      env.runs[0].finish();
      await until(() => env.node.status === "completed");
    } else env.notify("pending result");
    await env.scheduler.cancel(env.workspace.id, env.node.id);
    env.notify("late result");
    await delay(30);
    assert.equal(env.runs.length, 1);
  });

test("old revision and deleted card notifications do not wake the parent", async (t) => {
  const env = await fixture(t);
  env.runs[0].finish();
  await until(() => env.node.status === "completed");
  env.node.revision = (env.node.revision ?? 0) + 1;
  env.notify("old revision");
  env.workspace.nodes = env.workspace.nodes.filter((node) => node !== env.node);
  env.notify("deleted node");
  await delay(30);
  assert.equal(env.runs.length, 1);
});

test("deleting a card fences completion emitted during native host disposal", async (t) => {
  const env = await fixture(t);
  env.runs[0].finish();
  await until(() => env.node.status === "completed");
  await delay(10);
  env.runtime.closeSubagentHost = async () => {
    env.notify("completion raced with deletion");
    await delay(10);
  };
  await env.scheduler.deleteNode(env.workspace.id, env.node.id, {
    expectedRevision: env.node.revision ?? 0,
    expectedNodeIds: [env.node.id],
  });
  await delay(20);
  assert.equal(env.runs.length, 1);
  assert.ok(!env.workspace.nodes.includes(env.node));
});
