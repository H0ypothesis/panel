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
  getCurrentSystemPrompt,
  type FauxResponseFactory,
  type JsonObject,
} from "@earendil-works/pi-ai";
import type {
  RunConfig,
  SafetyReviewRequest,
  SafetyReviewResult,
  ToolRequest,
} from "../shared/types.ts";
import { PiRuntime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store } from "./store.ts";
import { importWorkspace } from "./workspace-import.ts";
import type { WebToolOptions } from "./web-tools.ts";

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
  webOptions?: WebToolOptions,
  responseCount = 30,
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
  faux.setResponses(Array.from({ length: responseCount }, () => response));
  const registry = createModels();
  registry.setProvider(faux.provider);
  const reviews: SafetyReviewRequest[] = [];
  class TestRuntime extends PiRuntime {
    override models() {
      return super.models().map((model) => ({ ...model, available: true }));
    }
    override async reviewTool(
      request: SafetyReviewRequest,
    ): Promise<SafetyReviewResult> {
      reviews.push(request);
      return {
        decision: "approve" as const,
        reason: "Approved test operation",
      };
    }
  }
  const runtime = new TestRuntime(registry, webOptions);
  await runtime.initSubagentSettings(join(directory, "state"));
  const scheduler = new Scheduler(store, runtime);
  // Native orchestration can create worktrees, outputs and external runs. Give
  // that boundary its own approval; individual child tools remain under test.
  let approveOrchestration = true;
  const approvalTimer = setInterval(() => {
    for (const node of workspace.nodes)
      for (const call of node.toolCalls ?? [])
        if (
          approveOrchestration &&
          !call.subagentId &&
          call.name === "subagent" &&
          call.status === "awaiting_approval"
        )
          void scheduler
            .approve(workspace.id, node.id, call.id, "approve", node.revision)
            .catch(() => {});
  }, 10);
  t.after(() => clearInterval(approvalTimer));

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
  return {
    setApproveOrchestration: (value: boolean) => {
      approveOrchestration = value;
    },
    directory,
    project,
    store,
    workspace,
    scheduler,
    submit,
    reviews,
    runtime,
  };
}

test("runtime snapshots saved concurrency for a turn and applies changes to the next turn", async (t) => {
  let active = 0;
  let peak = 0;
  const env = await fixture(
    t,
    async (context) => {
      const tools = getCurrentTools(context.messages);
      if (!tools?.some((tool) => tool.name === "subagent")) {
        peak = Math.max(peak, ++active);
        await delay(80);
        active--;
        return fauxAssistantMessage("child result");
      }
      if (
        !context.messages.some(
          (message) =>
            message.role === "toolResult" && message.toolName === "subagent",
        )
      )
        return replyTool("subagent", {
          tasks: Array.from({ length: 4 }, () => ({
            agent: "oracle",
            task: "independent analysis",
          })),
        });
      return fauxAssistantMessage("parent done");
    },
    "auto",
  );
  await env.runtime.saveSubagentSettings({ maxConcurrentSubagents: 1 });
  const first = await env.submit();
  await until(() => active > 0);
  await env.runtime.saveSubagentSettings({ maxConcurrentSubagents: 2 });
  await until(() => first.status === "completed" || first.status === "failed");
  assert.equal(first.status, "completed", first.error);
  assert.equal(peak, 1, "running turns keep their original queue limit");
  peak = 0;
  const second = await env.submit();
  await until(
    () => second.status === "completed" || second.status === "failed",
  );
  assert.equal(second.status, "completed", second.error);
  assert.equal(peak, 2, "next turn receives the saved setting");
});

for (const mode of ["ask", "auto"] as const)
  for (const background of [false, true])
    test(`${mode} approval denial only skips one ${background ? "background" : "foreground"} child call; later work and parent summary continue`, async (t) => {
      let denialSeen = false;
      const env = await fixture(
        t,
        async (context) => {
          const parent = getCurrentTools(context.messages)?.some(
            (tool) => tool.name === "subagent",
          );
          const results = context.messages.filter(
            (message) => message.role === "toolResult",
          );
          if (parent) {
            if (results.some((result) => result.toolName === "subagent"))
              return fauxAssistantMessage("PARENT_SUMMARY_AFTER_DENIAL");
            return replyTool(
              "subagent",
              background
                ? {
                    agent: "worker",
                    task: "DENIAL_TARGET",
                    async: true,
                    output: false,
                  }
                : {
                    tasks: [
                      { agent: "worker", task: "DENIAL_TARGET" },
                      { agent: "worker", task: "SIBLING_TASK" },
                    ],
                  },
            );
          }
          const sibling = context.messages.some(
            (message) =>
              message.role === "user" &&
              JSON.stringify(message.content).includes("SIBLING_TASK"),
          );
          if (!results.length) {
            if (background) await delay(300);
            return replyTool(
              "write",
              { path: sibling ? "sibling.txt" : "denied.txt", content: "test" },
              "first-write",
            );
          }
          if (sibling) return fauxAssistantMessage("SIBLING_COMPLETED");
          const denied = results.find(
            (result) => result.toolCallId === "first-write",
          );
          assert.ok(denied?.isError, JSON.stringify(results));
          assert.match(JSON.stringify(denied.content), /只针对本次调用/);
          denialSeen = true;
          if (results.length === 1)
            return replyTool(
              "write",
              { path: "allowed.txt", content: "CONTINUED_AFTER_DENIAL" },
              "second-write",
            );
          assert.ok(!results.at(-1)!.isError, JSON.stringify(results));
          return fauxAssistantMessage("CHILD_COMPLETED_AFTER_DENIAL");
        },
        mode,
      );
      if (mode === "auto")
        env.runtime.reviewTool = async (request) => {
          env.reviews.push(request);
          return request.tool.arguments.path === "denied.txt"
            ? {
                decision: "deny",
                reason: "Requires user decision for this write",
              }
            : {
                decision: "approve",
                reason: "Other authorized work may proceed",
              };
        };
      const node = await env.submit();
      if (background) await until(() => node.status === "completed");
      await until(
        () =>
          node.toolCalls?.some(
            (call) =>
              call.arguments.path === "denied.txt" &&
              call.status === "awaiting_approval",
          ) === true,
      );
      const deniedCall = node.toolCalls!.find(
        (call) => call.arguments.path === "denied.txt",
      )!;
      assert.ok(deniedCall.subagentId);
      if (mode === "auto") {
        assert.equal(deniedCall.safetyReview?.decision, "deny");
        const review = env.reviews.find(
          (review) => review.tool.id === deniedCall.id,
        )!;
        assert.equal(review.subagent?.id, deniedCall.subagentId);
        assert.equal(review.subagent?.agent, "worker");
        assert.match(review.subagent!.task, /DENIAL_TARGET/);
      }
      await env.scheduler.approve(
        env.workspace.id,
        node.id,
        deniedCall.id,
        "deny",
        node.revision,
      );
      if (mode === "ask") {
        await until(
          () =>
            node.toolCalls?.some(
              (call) =>
                call.arguments.path === "allowed.txt" &&
                call.status === "awaiting_approval",
            ) === true,
        );
        if (!background)
          await until(
            () =>
              node.toolCalls?.some(
                (call) =>
                  call.arguments.path === "sibling.txt" &&
                  call.status === "awaiting_approval",
              ) === true,
          );
        for (const call of node.toolCalls!.filter(
          (call) => call.subagentId && call.status === "awaiting_approval",
        ))
          await env.scheduler.approve(
            env.workspace.id,
            node.id,
            call.id,
            "approve",
            node.revision,
          );
      }
      await until(
        () =>
          node.subagents?.every((run) => run.status === "completed") === true &&
          node.status === "completed",
      );
      if (background)
        await until(
          () =>
            node.messages!.filter(
              (message) =>
                message.role === "assistant" &&
                JSON.stringify(message.content).includes(
                  "PARENT_SUMMARY_AFTER_DENIAL",
                ),
            ).length >= 2,
        );
      assert.ok(denialSeen);
      assert.equal(deniedCall.status, "denied");
      assert.ok(!deniedCall.authorization?.consumedAt);
      await assert.rejects(readFile(join(env.project, "denied.txt")), {
        code: "ENOENT",
      });
      assert.equal(
        await readFile(join(env.project, "allowed.txt"), "utf8"),
        "CONTINUED_AFTER_DENIAL",
      );
      if (!background)
        assert.equal(
          await readFile(join(env.project, "sibling.txt"), "utf8"),
          "test",
        );
      const allowed = node.toolCalls!.find(
        (call) => call.arguments.path === "allowed.txt",
      )!;
      assert.equal(allowed.subagentId, deniedCall.subagentId);
      assert.ok(allowed.authorization?.consumedAt);
      if (mode === "auto") {
        assert.equal(allowed.approval, "safety_model");
        const followup = env.reviews.find(
          (review) => review.tool.id === allowed.id,
        )!;
        assert.ok(
          followup.recentTools?.some(
            (call) =>
              call.subagentId === deniedCall.subagentId &&
              call.status === "denied",
          ),
        );
      }
      assert.match(node.response, /PARENT_SUMMARY_AFTER_DENIAL/);
    });

test("builtin researcher and evidence-auditor use native web contracts through durable Panel approval", async (t) => {
  const names = [
    "web_search",
    "fetch_content",
    "get_search_content",
    "source_check",
  ];
  let dispatched = 0;
  const env = await fixture(
    t,
    (context) => {
      const tools = getCurrentTools(context.messages) ?? [];
      const results = context.messages.filter(
        (message) => message.role === "toolResult",
      );
      if (tools.some((tool) => tool.name === "subagent")) {
        if (!results.some((result) => result.toolName === "subagent"))
          return replyTool("subagent", {
            tasks: [
              {
                agent: "researcher",
                task: "Research the streaming API and report the evidence.",
              },
              {
                agent: "evidence-auditor",
                task: "Audit the streaming API claim with original sources.",
              },
            ],
          });
        return fauxAssistantMessage("research synthesis");
      }
      for (const name of names)
        assert.ok(
          tools.some((tool) => tool.name === name),
          name,
        );
      const prompt = getCurrentSystemPrompt(context.messages);
      assert.match(prompt, /research subagent|evidence-auditing subagent/);
      assert.match(prompt, /缓存仅属于本次执行的当前代理/);
      assert.ok(
        results.every((result) => !result.isError),
        JSON.stringify(results),
      );
      switch (results.length) {
        case 0:
          return replyTool(
            "web_search",
            {
              queries: ["streaming docs", "streaming limitations"],
              workflow: "none",
              numResults: 3,
            },
            "search-step",
          );
        case 1:
          return replyTool(
            "fetch_content",
            { url: "https://example.com/docs" },
            "fetch-step",
          );
        case 2:
          return replyTool(
            "get_search_content",
            {
              responseId: "cached-source",
              urlIndex: 0,
              findText: "streaming",
              findMode: "exact",
            },
            "cache-step",
          );
        case 3:
          return replyTool(
            "source_check",
            { claim: "The API supports streaming.", fetchContent: true },
            "check-step",
          );
        default:
          return fauxAssistantMessage(
            "Research evidence: [official docs](https://example.com/docs).",
          );
      }
    },
    "auto",
    {
      async runNativePlugin(request, signal) {
        signal?.throwIfAborted();
        dispatched++;
        const node = env.workspace.nodes[1];
        assert.ok(
          node.toolCalls?.some(
            (call) =>
              call.subagentId &&
              call.name === request.name &&
              call.authorization?.consumedAt,
          ),
          "native tool cannot bypass approval",
        );
        return {
          text: "Verified streaming source. responseId: cached-source",
          sources: [
            { title: "Official docs", url: "https://example.com/docs" },
          ],
          details: { responseId: "cached-source" },
        };
      },
    },
  );
  const node = await env.submit(["subagents"]);
  await until(() => node.status === "completed" || node.status === "failed");
  assert.equal(node.status, "completed", node.error);
  assert.equal(node.subagents?.length, 2);
  for (const run of node.subagents ?? [])
    assert.equal(run.status, "completed", run.error);
  assert.equal(dispatched, 8);
  const calls = node.toolCalls!.filter(
    (call) => call.subagentId && names.includes(call.name),
  );
  assert.equal(calls.length, 8);
  for (const call of calls) {
    assert.equal(call.status, "completed", call.error);
    assert.equal(call.sources?.[0].url, "https://example.com/docs");
    assert.ok(call.authorization?.consumedAt);
  }
});

test("denying a native research tool stops before the web provider", async (t) => {
  let dispatched = 0;
  const env = await fixture(
    t,
    (context) => {
      const tools = getCurrentTools(context.messages) ?? [];
      const results = context.messages.filter(
        (message) => message.role === "toolResult",
      );
      if (tools.some((tool) => tool.name === "subagent"))
        return results.some((result) => result.toolName === "subagent")
          ? fauxAssistantMessage("denial respected")
          : replyTool("subagent", {
              agent: "evidence-auditor",
              task: "Check the streaming claim.",
            });
      return results.length
        ? fauxAssistantMessage("User denied evidence collection.")
        : replyTool("source_check", { claim: "Streaming API" });
    },
    "ask",
    {
      async runNativePlugin() {
        dispatched++;
        throw new Error("must not run");
      },
    },
  );
  const node = await env.submit();
  await until(() =>
    Boolean(
      node.toolCalls?.some(
        (call) =>
          call.name === "source_check" && call.status === "awaiting_approval",
      ),
    ),
  );
  const call = node.toolCalls!.find((call) => call.name === "source_check")!;
  await env.scheduler.approve(env.workspace.id, node.id, call.id, "deny");
  await until(() => node.status === "completed" || node.status === "failed");
  assert.equal(dispatched, 0);
  assert.equal(call.approval, "denied");
});

for (const explicit of [false, true])
  test(`${explicit ? "@subagents" : "automatic delegation on reply 40"} keeps native parent and child execution running beyond 40 replies`, async (t) => {
    let parentReplies = 0;
    let childReplies = 0;
    const env = await fixture(
      t,
      async (context) => {
        const parent = getCurrentTools(context.messages)?.some(
          (tool) => tool.name === "subagent",
        );
        if (!parent) {
          childReplies++;
          return childReplies <= 41
            ? replyTool(
                "read",
                { path: "evidence.txt" },
                `long-child-${childReplies}`,
              )
            : fauxAssistantMessage("CHILD_LONG_TASK_COMPLETE");
        }
        parentReplies++;
        if (parentReplies === 40)
          return replyTool(
            "subagent",
            {
              agent: "oracle",
              task: "Read evidence and return a concise conclusion",
              context: "fresh",
              output: false,
              async: false,
            },
            `long-parent-${parentReplies}`,
          );
        if (parentReplies < 42)
          return replyTool(
            "read",
            { path: "evidence.txt" },
            `long-parent-${parentReplies}`,
          );
        assert.match(
          JSON.stringify(
            context.messages.filter(
              (message) =>
                message.role === "toolResult" &&
                message.toolName === "subagent",
            ),
          ),
          /CHILD_LONG_TASK_COMPLETE/,
        );
        return fauxAssistantMessage("PARENT_LONG_TASK_COMPLETE");
      },
      "ask",
      undefined,
      100,
    );
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(env.project, "evidence.txt"), "fixture evidence");
    const node = await env.submit(explicit ? ["subagents"] : undefined);
    await until(() => node.status === "completed" || node.status === "failed");
    assert.equal(node.status, "completed", node.error);
    assert.equal(parentReplies, 42);
    assert.equal(childReplies, 42);
    assert.equal(node.response, "PARENT_LONG_TASK_COMPLETE");
    assert.equal(node.subagentsEnabled, true);
    assert.equal(
      node.config.longTask,
      undefined,
      "automatic mode keeps manual config intact",
    );
    assert.equal(node.subagents?.[0]?.status, "completed");
    assert.equal(node.toolCalls!.filter((call) => call.subagentId).length, 41);
    assert.ok(node.toolCalls!.every((call) => call.authorization?.consumedAt));
  });

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
      env.reviews
        .filter((review) => review.tool.name !== "subagent")
        .map((review) => review.tool.name),
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
        .every(
          (call) =>
            call.approval ===
            (call.name === "subagent" ? "safety_model" : "policy"),
        ),
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
  node.subagentSchedules = true;
  node.subagentNotices = [
    {
      kind: "ui-request",
      value: { id: "old-question", kind: "confirm" },
      createdAt: 1,
    },
  ];
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
  assert.equal(imported.nodes[1].subagentSchedules, undefined);
  assert.equal(imported.nodes[1].subagentNotices, undefined);
  await env.store.save();
  const restored = new Store(join(env.directory, "state"));
  await restored.init(false);
  const record = restored.workspace(env.workspace.id).nodes[1].subagents![0];
  assert.equal(record.status, "cancelled");
  assert.equal(record.response, "partial");
  assert.equal(record.thinking!.active, false);
  const restoredNode = restored.workspace(env.workspace.id).nodes[1];
  assert.equal(restoredNode.subagentSchedules, true);
  assert.ok(
    restoredNode.subagentNotices!.some(
      (notice) =>
        notice.kind === "ui-response" &&
        (notice.value as { id: string }).id === "old-question",
    ),
  );
  node.subagents[0].status = "cancelled";
});

test("native output persistence requires an approved orchestration boundary", async (t) => {
  const env = await fixture(t, (context) => {
    const parent = getCurrentTools(context.messages)?.some(
      (tool) => tool.name === "subagent",
    );
    if (!parent) return fauxAssistantMessage("child artifact content");
    if (
      !context.messages.some(
        (message) =>
          message.role === "toolResult" && message.toolName === "subagent",
      )
    )
      return replyTool("subagent", {
        agent: "scout",
        task: "Return an investigation report.",
        output: "approved-report.md",
        async: false,
      });
    return fauxAssistantMessage("report reviewed");
  });
  env.setApproveOrchestration(false);
  const node = await env.submit();
  await until(
    () =>
      node.toolCalls?.some(
        (call) =>
          call.name === "subagent" && call.status === "awaiting_approval",
      ) === true,
  );
  const call = node.toolCalls!.find((call) => call.name === "subagent")!;
  assert.equal(
    node.subagents?.length ?? 0,
    0,
    "no child or output before approval",
  );
  await env.scheduler.approve(
    env.workspace.id,
    node.id,
    call.id,
    "approve",
    node.revision ?? 0,
  );
  await until(() => node.status === "completed" || node.status === "failed");
  assert.equal(node.status, "completed", node.error);
  assert.equal(
    node.subagents![0].status,
    "completed",
    node.subagents![0].error,
  );
  assert.ok(node.subagents![0].sessionFile);
  assert.ok(call.authorization?.consumedAt);
  assert.match(call.output ?? "", /child artifact content|approved-report/);
});

test("long native reports hand off a summary and readable file while card and history retain the full report", async (t) => {
  const report = `REPORT_BEGIN\n${"Verified finding with source.\n".repeat(900)}REPORT_END`;
  let parentInput = "";
  let summaryRequests = 0;
  const env = await fixture(
    t,
    (context) => {
      if (
        getCurrentSystemPrompt(context.messages).includes(
          "供主代理继续工作的简短交接摘要",
        )
      ) {
        summaryRequests++;
        return fauxAssistantMessage(
          "SUMMARY_HANDOFF: verified finding; one unresolved question.",
        );
      }
      const tools = getCurrentTools(context.messages);
      const parent = tools?.some((tool) => tool.name === "subagent");
      if (!parent) return fauxAssistantMessage(report);
      if (
        !context.messages.some(
          (message) =>
            message.role === "toolResult" && message.toolName === "subagent",
        )
      )
        return replyTool("subagent", {
          agent: "scout",
          task: "Return a long report.",
          async: false,
          output: false,
        });
      parentInput = JSON.stringify(context.messages);
      return fauxAssistantMessage("Parent reviewed the summary.");
    },
    "auto",
  );
  const node = await env.submit();
  await until(() => node.status === "completed" || node.status === "failed");
  assert.equal(node.status, "completed", node.error);
  assert.equal(summaryRequests, 1);
  assert.match(parentInput, /SUMMARY_HANDOFF/);
  assert.doesNotMatch(parentInput, /REPORT_END/);
  assert.match(node.subagents![0].response, /REPORT_BEGIN[\s\S]*REPORT_END/);
  assert.match(JSON.stringify(node.messages), /REPORT_BEGIN[\s\S]*REPORT_END/);
  const save = node.toolCalls?.find(
    (call) =>
      call.name === "write" &&
      String(call.arguments.path).includes("/handoffs/"),
  );
  assert.equal(save?.status, "completed");
  assert.ok(save?.authorization?.consumedAt);
  assert.match(
    await readFile(String(save!.arguments.path), "utf8"),
    /REPORT_BEGIN[\s\S]*REPORT_END/,
  );
});

test("a detached child keeps approvals, writes and snapshots after its parent completes", async (t) => {
  const env = await fixture(t, async (context) => {
    const parent = getCurrentTools(context.messages)?.some(
      (tool) => tool.name === "subagent",
    );
    const results = context.messages.filter(
      (message) => message.role === "toolResult",
    );
    if (parent)
      return results.some((result) => result.toolName === "subagent")
        ? fauxAssistantMessage("parent released the background task")
        : replyTool("subagent", {
            agent: "delegate",
            task: "Write background.txt",
            async: true,
            output: false,
          });
    if (!results.length) {
      await delay(300);
      return replyTool("write", {
        path: "background.txt",
        content: "background-approved",
      });
    }
    return fauxAssistantMessage("background done");
  });
  const node = await env.submit();
  await until(() => node.status === "completed");
  await until(
    () =>
      node.toolCalls?.some(
        (call) => call.subagentId && call.status === "awaiting_approval",
      ) === true,
  );
  const call = node.toolCalls!.find(
    (call) => call.subagentId && call.status === "awaiting_approval",
  )!;
  await assert.rejects(readFile(join(env.project, "background.txt")), {
    code: "ENOENT",
  });
  await env.scheduler.approve(
    env.workspace.id,
    node.id,
    call.id,
    "approve_tool",
    node.revision ?? 0,
  );
  await until(() => call.status === "completed");
  assert.equal(
    await readFile(join(env.project, "background.txt"), "utf8"),
    "background-approved",
  );
  assert.ok(call.authorization?.consumedAt);
  assert.ok(
    env.workspace.gitHistory?.some(
      (entry) =>
        entry.toolCallId === call.id && entry.workingDirectory === env.project,
    ),
  );
  assert.equal(node.status, "completed");
});

for (const failChild of [false, true])
  test(`background ${failChild ? "failure" : "completion"} wakes the real parent runtime`, async (t) => {
    let childCalls = 0,
      summaries = 0;
    const env = await fixture(
      t,
      async (context) => {
        const parent = getCurrentTools(context.messages)?.some(
          (tool) => tool.name === "subagent",
        );
        if (!parent) {
          childCalls++;
          await delay(300);
          return failChild
            ? fauxAssistantMessage("", {
                stopReason: "error",
                errorMessage: "Invalid API key",
              })
            : fauxAssistantMessage("CHILD_FINAL_EVIDENCE");
        }
        const wake = context.messages.some(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("子代理后台通知"),
        );
        if (wake) {
          summaries++;
          assert.match(
            JSON.stringify(context.messages),
            failChild ? /Invalid API key/ : /CHILD_FINAL_EVIDENCE/,
          );
          return fauxAssistantMessage(
            failChild
              ? "SUMMARIZED_FAILURE_AND_GAPS"
              : "SUMMARIZED_CHILD_EVIDENCE",
          );
        }
        return context.messages.some(
          (message) =>
            message.role === "toolResult" && message.toolName === "subagent",
        )
          ? fauxAssistantMessage("Waiting for background research.")
          : replyTool("subagent", {
              agent: "oracle",
              task: "Research",
              async: true,
              output: false,
            });
      },
      "auto",
    );
    const node = await env.submit(["subagents"]);
    await until(() => summaries > 0 && node.status === "completed");
    assert.equal(childCalls, 1);
    assert.equal(summaries, 1);
    assert.match(
      node.response,
      failChild ? /SUMMARIZED_FAILURE_AND_GAPS/ : /SUMMARIZED_CHILD_EVIDENCE/,
    );
    assert.equal(
      node.subagents!.find((run) => run.agent === "oracle")!.status,
      failChild ? "failed" : "completed",
    );
    const assistants = node.messages!.filter(
      (message) => message.role === "assistant",
    );
    assert.equal(
      node.usage!.total,
      assistants.reduce((sum, message) => sum + message.usage.totalTokens, 0) +
        node.subagents!.reduce((sum, run) => sum + (run.usage?.total ?? 0), 0),
    );
  });

test("native transient stream retry clears stale child failure after recovery", async (t) => {
  let attempts = 0;
  const env = await fixture(
    t,
    (context) => {
      if (
        !getCurrentTools(context.messages)?.some(
          (tool) => tool.name === "subagent",
        )
      ) {
        if (++attempts === 1)
          return fauxAssistantMessage("", {
            stopReason: "error",
            errorMessage: "Anthropic stream ended before message_stop",
          });
        return fauxAssistantMessage("RECOVERED_REPORT");
      }
      return context.messages.some(
        (message) =>
          message.role === "toolResult" && message.toolName === "subagent",
      )
        ? fauxAssistantMessage("Parent completed.")
        : replyTool("subagent", {
            agent: "oracle",
            task: "Research",
            async: false,
            output: false,
          });
    },
    "auto",
  );
  const node = await env.submit();
  await until(() => node.status === "completed" || node.status === "failed");
  assert.equal(node.status, "completed", node.error);
  assert.equal(attempts, 2);
  assert.equal(node.subagents![0].status, "completed");
  assert.equal(node.subagents![0].error, undefined);
  assert.match(node.subagents![0].response, /RECOVERED_REPORT/);
});

test("one async workflow with multiple child notices triggers one final parent synthesis", async (t) => {
  let children = 0,
    summaries = 0;
  const env = await fixture(
    t,
    async (context) => {
      if (
        !getCurrentTools(context.messages)?.some(
          (tool) => tool.name === "subagent",
        )
      ) {
        const number = ++children;
        await delay(300 + number * 50);
        return fauxAssistantMessage(`WORKFLOW_EVIDENCE_${number}`);
      }
      if (
        context.messages.some(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("子代理后台通知"),
        )
      ) {
        summaries++;
        assert.match(JSON.stringify(context.messages), /WORKFLOW_EVIDENCE_1/);
        assert.match(JSON.stringify(context.messages), /WORKFLOW_EVIDENCE_2/);
        return fauxAssistantMessage("WORKFLOW_SYNTHESIS");
      }
      return context.messages.some(
        (message) =>
          message.role === "toolResult" && message.toolName === "subagent",
      )
        ? fauxAssistantMessage("Waiting for workflow.")
        : replyTool("subagent", {
            workflowScript:
              'return await runs.all([{key:"one",agent:"oracle",task:"First topic",output:false},{key:"two",agent:"oracle",task:"Second topic",output:false}]);',
            async: true,
          });
    },
    "auto",
  );
  const node = await env.submit();
  await until(() => summaries > 0 && node.status === "completed");
  await delay(100);
  assert.equal(summaries, 1);
  assert.equal(children, 2);
  assert.match(node.response, /WORKFLOW_SYNTHESIS/);
  assert.ok(
    node.subagentNotices?.some(
      (notice) =>
        notice.kind === "message" &&
        (notice.value as { options?: { triggerTurn?: boolean } }).options
          ?.triggerTurn === false,
    ),
  );
});
