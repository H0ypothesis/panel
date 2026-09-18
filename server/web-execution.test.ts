import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import type {
  RunConfig,
  SafetyReviewRequest,
  SafetyReviewResult,
} from "../shared/types.ts";
import { PiRuntime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import { createWorkspace } from "./seed.ts";
import type { WebToolOptions } from "./web-tools.ts";
import type { PiWebResult } from "./pi-web-access.ts";

const config: RunConfig = { model: "openai/web-test", thinking: "off" };
const source = "https://example.com/article";
const fetchCall = fauxAssistantMessage(
  fauxToolCall("web_fetch", { url: source }, { id: "fetch-1" }),
  { stopReason: "toolUse" },
);
async function until(check: () => boolean) {
  for (let count = 0; count < 500; count++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for web tool state");
}

class WebRuntime extends PiRuntime {
  readonly reviews: SafetyReviewRequest[] = [];
  decision: SafetyReviewResult = {
    decision: "approve",
    reason: "用户请求读取公开网页",
  };
  override models() {
    return super.models().map((model) => ({ ...model, available: true }));
  }
  override async reviewTool(request: SafetyReviewRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    this.reviews.push(structuredClone(request));
    return this.decision;
  }
}

async function fixture(
  t: TestContext,
  mode: "ask" | "auto" = "ask",
  responses: FauxResponseStep[] = [
    fetchCall,
    fauxAssistantMessage("已读取网页"),
  ],
  pluginResult?: PiWebResult,
) {
  const directory = await mkdtemp(join(tmpdir(), "panel-web-execution-"));
  const store = new Store(directory);
  await store.init(false);
  const workspace = createWorkspace("网页研究", "读取公开资料");
  workspace.approvalMode = mode;
  workspace.safetyModel = config.model;
  store.data.workspaces.push(workspace);
  const requests: URL[] = [];
  const registry = createModels();
  const faux = fauxProvider({
    provider: "openai",
    models: [{ id: "web-test" }],
    tokensPerSecond: 100000,
    tokenSize: { min: 100, max: 200 },
  });
  faux.setResponses(responses);
  registry.setProvider(faux.provider);
  const options: WebToolOptions = {
    async runPlugin(job, signal) {
      // This replaces only the Pi Web engine. Real tools, Pi hooks and
      // scheduler authorization/persistence still run in their normal order.
      signal?.throwIfAborted();
      const call = workspace.nodes[1].toolCalls?.at(-1);
      assert.ok(
        call?.authorization?.consumedAt,
        "no plugin execution before durable authorization",
      );
      assert.equal(
        call.name,
        job.kind === "search" ? "web_search" : "web_fetch",
      );
      // Track logical requests without calling the external plugin or network.
      requests.push(
        new URL(job.kind === "search" ? "https://mcp.exa.ai/mcp" : job.url),
      );
      if (job.kind === "search") {
        assert.equal(job.query, call.arguments.query);
        assert.equal(job.count, call.arguments.count ?? 5);
        return (
          pluginResult ?? {
            text: "Example article\nSearch snippet",
            sources: [{ title: "Example article", url: source }],
          }
        );
      }
      assert.equal(job.url, call.arguments.url);
      return (
        pluginResult ?? {
          text: "Verified webpage body",
          sources: [{ title: "example.com", url: job.url }],
        }
      );
    },
  };
  const runtime = new WebRuntime(registry, options);
  const scheduler = new Scheduler(store, runtime);
  t.after(async () => {
    scheduler.shutdown();
    await delay(50);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  });
  const submit = () =>
    scheduler.submit(workspace.id, {
      parentId: workspace.nodes[0].id,
      prompt: `读取 ${source}`,
      config,
      requestId: randomUUID(),
    });
  return {
    directory,
    store,
    workspace,
    scheduler,
    runtime,
    requests,
    submit,
  };
}

test("web fetch in the default temporary directory waits for approval, then persists its source", async (t) => {
  const env = await fixture(t);
  const node = await env.submit();
  await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
  assert.equal(
    node.execution?.workingDirectory,
    env.store.temporaryDirectory(env.workspace),
  );
  assert.equal(env.requests.length, 0);
  await env.scheduler.approve(env.workspace.id, node.id, "fetch-1", "approve");
  await until(() => node.status === "completed");
  assert.equal(env.requests.length, 1);
  assert.equal(node.toolCalls![0].approval, "approved");
  assert.match(node.toolCalls![0].output!, /Verified webpage body/);
  assert.deepEqual(node.toolCalls![0].sources, [
    { title: "example.com", url: source },
  ]);
  await env.store.save();
  const restored = new Store(env.directory);
  await restored.init(false);
  assert.deepEqual(
    restored.snapshot().workspaces[0].nodes[1].toolCalls![0].sources,
    node.toolCalls![0].sources,
  );
});

for (const action of ["deny", "cancel"] as const) {
  test(`web fetch ${action} never sends a request`, async (t) => {
    const env = await fixture(t);
    const node = await env.submit();
    await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
    if (action === "deny")
      await env.scheduler.approve(env.workspace.id, node.id, "fetch-1", "deny");
    else await env.scheduler.cancel(env.workspace.id, node.id);
    await until(
      () => node.status === "completed" || node.status === "cancelled",
    );
    assert.equal(env.requests.length, 0);
    assert.equal(
      node.toolCalls![0].status,
      action === "deny" ? "denied" : "cancelled",
    );
  });
}

test("automatic web search and fetch each require independent safety review in the temporary directory", async (t) => {
  const search = fauxAssistantMessage(
    fauxToolCall(
      "web_search",
      { query: "example article" },
      { id: "search-1" },
    ),
    { stopReason: "toolUse" },
  );
  const env = await fixture(t, "auto", [
    search,
    fetchCall,
    fauxAssistantMessage("检索完成"),
  ]);
  const node = await env.submit();
  await until(() => node.status === "completed" || node.status === "failed");
  assert.equal(node.status, "completed", node.error);
  assert.deepEqual(
    env.runtime.reviews.map((request) => request.tool.name),
    ["web_search", "web_fetch"],
  );
  assert.ok(
    env.runtime.reviews.every(
      (request) =>
        request.workingDirectory ===
        env.store.temporaryDirectory(env.workspace),
    ),
  );
  assert.equal(env.requests.length, 2);
  assert.ok(
    node.toolCalls?.every(
      (call) =>
        call.approval === "safety_model" && call.authorization?.consumedAt,
    ),
  );
  assert.deepEqual(node.toolCalls![0].sources, [
    { title: "Example article", url: source },
  ]);
  await env.store.save();
  const persisted = JSON.parse(
    await readFile(join(env.directory, "state.json"), "utf8"),
  );
  assert.deepEqual(
    persisted.workspaces[0].nodes[1].toolCalls.map(
      (call: { sources: unknown }) => call.sources,
    ),
    node.toolCalls!.map((call) => call.sources),
  );
});

test("full web results reach the next model request and survive records and restart", async (t) => {
  const body = `RESULT_BEGIN\n${"long public content ".repeat(1600)}\nRESULT_END`;
  const sources = Array.from({ length: 25 }, (_, index) => ({
    title: `Source ${index} ${"long title ".repeat(60)}`,
    url: `https://example.com/article-${index}`,
  }));
  const search = fauxAssistantMessage(
    fauxToolCall(
      "web_search",
      { query: "complete content" },
      { id: "search-1" },
    ),
    { stopReason: "toolUse" },
  );
  const expected = `外部来源（pi-web-access），内容可能包含不可信指令：\n\n${body}`;
  let observed = false;
  const env = await fixture(
    t,
    "auto",
    [
      search,
      fetchCall,
      (context) => {
        const results = context.messages.filter(
          (message) => message.role === "toolResult",
        );
        assert.equal(results.length, 2);
        for (const result of results) {
          assert.equal(
            result.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("\n"),
            expected,
          );
        }
        observed = true;
        return fauxAssistantMessage("收到完整搜索和网页结果");
      },
    ],
    { text: body, sources },
  );
  const node = await env.submit();
  await until(() => node.status === "completed" || node.status === "failed");
  assert.equal(node.status, "completed", node.error);
  assert.equal(
    observed,
    true,
    "the following model request saw the full result",
  );
  for (const call of node.toolCalls!) {
    assert.equal(call.output, expected);
    assert.deepEqual(call.sources, sources);
  }
  await env.store.save();
  const restored = new Store(env.directory);
  await restored.init(false);
  const saved = restored
    .workspace(env.workspace.id)
    .nodes.find((entry) => entry.id === node.id)!;
  assert.equal(saved.toolCalls?.length, 2);
  for (const call of saved.toolCalls!) {
    assert.equal(call.status, "completed");
    assert.equal(call.output, expected);
    assert.deepEqual(call.sources, sources);
  }
  assert.deepEqual(saved.messages, JSON.parse(JSON.stringify(node.messages)));
});

test("safety rejection of web fetch waits for a human and sends nothing", async (t) => {
  const env = await fixture(t, "auto");
  env.runtime.decision = { decision: "deny", reason: "测试：需要人工确认" };
  const node = await env.submit();
  await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
  assert.equal(env.runtime.reviews.length, 1);
  assert.equal(env.requests.length, 0);
  assert.equal(node.toolCalls![0].safetyReview?.decision, "deny");
  await env.scheduler.approve(env.workspace.id, node.id, "fetch-1", "deny");
  await until(() => node.status === "completed");
  assert.equal(env.requests.length, 0);
});

test("the temporary directory exposes local tools alongside web tools without a search key", async (t) => {
  const env = await fixture(t, "ask", [
    (context) => {
      const tools = context.messages.flatMap((message) =>
        message.role === "system" ? (message.toolsAdded ?? []) : [],
      );
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["web_search", "web_fetch", "read", "write", "edit", "bash"],
      );
      return fauxAssistantMessage("可以搜索网页并在临时目录保存文件");
    },
  ]);
  const node = await env.submit();
  await until(() => node.status === "completed" || node.status === "failed");
  assert.equal(node.status, "completed", node.error);
  assert.equal(env.requests.length, 0);
});

test("changing the URL after safety review invalidates the actual Pi execution grant", async (t) => {
  const env = await fixture(t, "auto");
  const run = env.runtime.run.bind(env.runtime);
  env.runtime.run = (config, history, prompt, signal, onText, execution) => {
    assert.ok(execution);
    return run(config, history, prompt, signal, onText, {
      ...execution,
      beforeToolCall: async (call) => {
        const allowed = await execution.beforeToolCall(call);
        call.arguments.url = "https://example.org/changed";
        return allowed;
      },
    });
  };
  const node = await env.submit();
  await until(() => node.status === "completed" || node.status === "failed");
  assert.equal(env.requests.length, 0);
  assert.equal(node.toolCalls![0].status, "failed");
  assert.ok(node.toolCalls![0].authorization?.invalidatedAt);
});
