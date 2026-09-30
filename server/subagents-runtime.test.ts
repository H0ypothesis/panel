import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  type FauxResponseFactory,
  type JsonObject,
} from "@earendil-works/pi-ai";
import type {
  RunConfig,
  SafetyReviewRequest,
  ToolRequest,
} from "../shared/types.ts";
import { PiRuntime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store } from "./store.ts";
import { importWorkspace } from "./workspace-import.ts";

const config: RunConfig = { model: "openai/subagent-test", thinking: "off" };
const replyTool = (name: string, args: JsonObject, id = "same-provider-id") =>
  fauxAssistantMessage(fauxToolCall(name, args, { id }), {
    stopReason: "toolUse",
  });
async function until(check: () => boolean) {
  for (let i = 0; i < 2000; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for subagent state");
}

async function fixture(
  t: TestContext,
  response: FauxResponseFactory,
  mode: "ask" | "auto" = "ask",
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-subagents-")),
  );
  const project = join(directory, "project");
  await mkdir(project);
  const store = new Store(join(directory, "state"));
  await store.init(false);
  const workspace = createWorkspace("Subagents", "Integration test");
  workspace.workingDirectory = project;
  workspace.approvalMode = mode;
  workspace.safetyModel = config.model;
  store.data.workspaces.push(workspace);
  const faux = fauxProvider({
    provider: "openai",
    models: [{ id: "subagent-test", contextWindow: 128000 }],
    tokensPerSecond: 1000000,
    tokenSize: { min: 3000, max: 5000 },
  });
  faux.setResponses(Array.from({ length: 30 }, () => response));
  const registry = createModels();
  registry.setProvider(faux.provider);
  const reviews: SafetyReviewRequest[] = [];
  class TestRuntime extends PiRuntime {
    override models() {
      return super.models().map((model) => ({ ...model, available: true }));
    }
    override async reviewTool(request: SafetyReviewRequest) {
      reviews.push(request);
      return {
        decision: "approve" as const,
        reason: "Approved test operation",
      };
    }
  }
  const runtime = new TestRuntime(registry);
  const scheduler = new Scheduler(store, runtime);
  const submit = (requests?: ToolRequest[]) =>
    scheduler.submit(workspace.id, {
      parentId: workspace.nodes[0].id,
      prompt: "PARENT_PRIVATE_CONTEXT: delegate independent work",
      config,
      requestId: randomUUID(),
      toolRequests: requests,
    });
  t.after(async () => {
    scheduler.shutdown();
    await until(() =>
      workspace.nodes.every(
        (node) =>
          !node.subagents?.some(
            (run) => run.status === "running" || run.status === "queued",
          ),
      ),
    );
    await runtime.close();
    await delay(30);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, project, store, workspace, scheduler, submit, reviews };
}

for (const explicit of [false, true]) {
  test(`${explicit ? "@subagents" : "automatic model delegation"} runs real nicobailon children through Panel authorization and persistence`, async (t) => {
    let children = 0;
    const env = await fixture(
      t,
      (context) => {
        const system = context.messages.find(
          (message) => message.role === "system",
        );
        const tools = getCurrentTools(context.messages);
        const child = !tools?.some((tool) => tool.name === "subagent");
        const results = context.messages.filter(
          (message) => message.role === "toolResult",
        );
        if (child) {
          assert.doesNotMatch(
            JSON.stringify(context.messages),
            /PARENT_PRIVATE_CONTEXT/,
          );
          assert.ok(
            !tools?.some((tool) => tool.name.startsWith("computer_use")),
          );
          const prompt = JSON.stringify(
            context.messages.find((message) => message.role === "user")
              ?.content,
          );
          if (!results.length) {
            children++;
            const path = prompt.includes("file-a") ? "a.txt" : "b.txt";
            return replyTool("write", { path, content: path });
          }
          assert.ok(
            results.every((result) => !result.isError),
            JSON.stringify(results),
          );
          return fauxAssistantMessage("child completed the assigned file");
        }
        if (!results.some((result) => result.toolName === "subagent")) {
          if (explicit)
            assert.match(JSON.stringify(context.messages), /subagents_enable/);
          assert.match(JSON.stringify(system), /自主调用 subagent/);
          return replyTool("subagent", {
            tasks: [
              { agent: "worker", task: "write file-a" },
              { agent: "worker", task: "write file-b" },
            ],
          });
        }
        assert.match(
          JSON.stringify(results),
          /child completed the assigned file/,
        );
        return fauxAssistantMessage("parent synthesis");
      },
      "auto",
    );
    const node = await env.submit(explicit ? ["subagents"] : undefined);
    await until(() => node.status === "completed" || node.status === "failed");
    assert.equal(node.status, "completed", node.error);
    assert.equal(children, 2);
    assert.equal(node.subagentsEnabled, true);
    assert.equal(node.subagents?.length, 2);
    assert.ok(
      node.subagents?.every((run) => run.status === "completed"),
      JSON.stringify(node.subagents),
    );
    assert.equal(await readFile(join(env.project, "a.txt"), "utf8"), "a.txt");
    assert.equal(await readFile(join(env.project, "b.txt"), "utf8"), "b.txt");
    assert.deepEqual(
      env.reviews.map((review) => review.tool.name),
      ["write", "write"],
    );
    const childCalls = node.toolCalls!.filter((call) => call.subagentId);
    assert.equal(
      new Set(childCalls.map((call) => call.id)).size,
      2,
      "duplicate provider IDs across children are namespaced",
    );
    assert.ok(
      childCalls.every(
        (call) =>
          call.approval === "safety_model" && call.authorization?.consumedAt,
      ),
    );
    assert.ok(
      node
        .toolCalls!.filter((call) => !call.subagentId)
        .every((call) => call.approval === "policy"),
    );
    assert.ok(node.subagents!.every((run) => run.usage && run.usage.total > 0));
    assert.ok(
      node.usage!.total >=
        node.subagents!.reduce((sum, run) => sum + run.usage!.total, 0),
    );
    assert.equal(
      node
        .messages!.filter((message) => message.role === "toolResult")
        .some((message) => message.toolName === "write"),
      false,
      "child transcript stays out of parent history",
    );
    await env.store.save();
    const restored = new Store(join(env.directory, "state"));
    await restored.init(false);
    assert.deepEqual(
      restored
        .workspace(env.workspace.id)
        .nodes.find((item) => item.id === node.id)!.subagents,
      JSON.parse(JSON.stringify(node.subagents)),
    );
    const imported = importWorkspace({ version: 1, workspace: env.workspace });
    assert.deepEqual(
      imported.nodes[1].subagents?.map((run) => run.response),
      node.subagents?.map((run) => run.response),
    );
    assert.equal(
      imported.nodes[1].toolCalls?.filter((call) => call.subagentId).length,
      2,
    );
  });
}

for (const cancel of [false, true]) {
  test(`child write ${cancel ? "cancellation" : "denial"} never modifies disk or loses child identity`, async (t) => {
    const env = await fixture(t, (context) => {
      const child = !getCurrentTools(context.messages).some(
        (tool) => tool.name === "subagent",
      );
      const results = context.messages.filter(
        (message) => message.role === "toolResult",
      );
      if (!results.length)
        return child
          ? replyTool("write", {
              path: "denied.txt",
              content: "must not execute",
            })
          : replyTool("subagent", { agent: "worker", task: "attempt write" });
      return fauxAssistantMessage(
        child ? "child reports the denied operation" : "parent reports result",
      );
    });
    const node = await env.submit();
    await until(
      () =>
        node.toolCalls?.some(
          (call) => call.subagentId && call.status === "awaiting_approval",
        ) === true,
    );
    const call = node.toolCalls!.find((call) => call.subagentId)!;
    if (cancel) await env.scheduler.cancel(env.workspace.id, node.id);
    else
      await env.scheduler.approve(
        env.workspace.id,
        node.id,
        call.id,
        "deny",
        node.revision ?? 0,
      );
    await until(
      () =>
        node.subagents?.every(
          (run) => run.status === "cancelled" || run.status === "completed",
        ) === true,
    );
    await until(
      () => node.status === "cancelled" || node.status === "completed",
    );
    assert.equal(call.status, cancel ? "cancelled" : "denied");
    assert.equal(node.subagents![0].status, cancel ? "cancelled" : "completed");
    assert.ok(!call.authorization?.consumedAt);
    await assert.rejects(readFile(join(env.project, "denied.txt")), {
      code: "ENOENT",
    });
  });
}

test("restarts and imports cancel unfinished child records without dispatching work", async (t) => {
  const env = await fixture(t, () => fauxAssistantMessage("no child needed"));
  const node = await env.submit();
  await until(() => node.status === "completed");
  node.subagentsEnabled = true;
  node.subagents = [
    {
      id: "unfinished",
      agent: "scout",
      task: "inspect",
      model: config.model,
      status: "running",
      response: "partial",
      thinking: { text: "partial thinking", active: true },
      createdAt: 1,
    },
  ];
  const imported = importWorkspace({ version: 1, workspace: env.workspace });
  assert.equal(imported.nodes[1].subagents![0].status, "cancelled");
  assert.equal(imported.nodes[1].subagents![0].thinking!.active, false);
  await env.store.save();
  const restored = new Store(join(env.directory, "state"));
  await restored.init(false);
  const record = restored.workspace(env.workspace.id).nodes[1].subagents![0];
  assert.equal(record.status, "cancelled");
  assert.equal(record.response, "partial");
  assert.equal(record.thinking!.active, false);
  node.subagents[0].status = "cancelled";
});
