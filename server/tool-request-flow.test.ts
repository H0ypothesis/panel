import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { RunConfig, ToolRequest } from "../shared/types.ts";
import { createApi } from "./api.ts";
import { buildContext } from "./context.ts";
import type { Runtime } from "./runtime.ts";
import { NodeMutationConflict, Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type StoredNode, type StoredWorkspace } from "./store.ts";
import { importWorkspace } from "./workspace-import.ts";

const config: RunConfig = { model: "test/tool-requests", thinking: "off" };
async function until(check: () => boolean) {
  for (let count = 0; count < 400; count++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Timed out waiting for explicit tool request flow");
}
async function settled<T>(run: () => Promise<T>): Promise<T> {
  for (let count = 0; count < 400; count++) {
    try {
      return await run();
    } catch (error) {
      if (
        !(error instanceof NodeMutationConflict) ||
        !error.message.includes("收尾")
      )
        throw error;
      await delay(5);
    }
  }
  assert.fail("Timed out waiting for scheduler cleanup");
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "panel-tool-requests-"));
  const store = new Store(directory);
  await store.init(false);
  const workspace = createWorkspace("Explicit tool selection", "Test");
  store.data.workspaces.push(workspace);
  let failNext = false;
  const calls: {
    prompt: string;
    history: Message[];
    toolRequests?: ToolRequest[];
  }[] = [];
  const runtime: Runtime = {
    models: () => [
      {
        id: config.model,
        name: "Tool requests",
        provider: "test",
        providerName: "Test",
        available: true,
        demo: false,
        thinkingLevels: ["off"],
        contextWindow: 128000,
        supportsImages: true,
      },
    ],
    computerUseStatus: () => ({
      available: true,
      connected: true,
      overlay: true,
      version: "test",
    }),
    async run(_config, history, prompt, signal, _onText, _execution, options) {
      signal.throwIfAborted();
      calls.push({
        prompt,
        history: structuredClone(history),
        toolRequests: structuredClone(options?.toolRequests),
      });
      const messages: Message[] = [
        { role: "user", content: prompt, timestamp: Date.now() },
      ];
      await options?.onMessages?.(messages);
      if (failNext) {
        failNext = false;
        throw new Error("Simulated tool-request run failure");
      }
      const response = "Generated answer";
      messages.push(fauxAssistantMessage(response));
      return { response, messages };
    },
  };
  const scheduler = new Scheduler(store, runtime);
  const api = createApi(store, runtime, scheduler);
  const request = async (method: string, path: string, body?: unknown) => {
    const input = Readable.from(
      body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
    ) as IncomingMessage;
    Object.assign(input, {
      method,
      url: `/api${path}`,
      headers: { host: "127.0.0.1:9999", "content-type": "application/json" },
    });
    let status = 0;
    let output = "";
    const response = {
      setHeader() {},
      writeHead(value: number) {
        status = value;
      },
      end(value = "") {
        output += value;
      },
    } as unknown as ServerResponse;
    await api(input, response);
    return { status, output };
  };
  const submit = async (
    toolRequests?: ToolRequest[],
    parentId = workspace.nodes[0].id,
    prompt = "请研究当前问题",
  ) => {
    const node = await scheduler.submit(workspace.id, {
      parentId,
      prompt,
      config,
      toolRequests,
      requestId: randomUUID(),
    });
    await until(() => node.status === "completed" || node.status === "failed");
    return node;
  };
  t.after(async () => {
    scheduler.shutdown();
    await delay(20);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    store,
    workspace,
    runtime,
    scheduler,
    calls,
    request,
    submit,
    failNext: () => {
      failNext = true;
    },
  };
}

test("explicit choices persist and reach only the selected current turn, while descendants inherit provenance", async (t) => {
  const env = await fixture(t);
  const choices: ToolRequest[] = ["computer_use", "web_search"];
  const node = await env.submit(choices);
  choices.length = 0;
  assert.deepEqual(node.toolRequests, ["web_search", "computer_use"]);
  assert.equal(node.prompt, "请研究当前问题");
  assert.deepEqual(env.calls[0].toolRequests, node.toolRequests);
  assert.match(env.calls[0].prompt, /@web_search[\s\S]*@computer_use/);
  assert.match(env.calls[0].prompt, /不要求后续新轮次重复调用/);
  const child = await env.submit(undefined, node.id, "继续分析已有结论");
  assert.equal(child.toolRequests, undefined);
  assert.equal(env.calls[1].prompt, "继续分析已有结论");
  assert.equal(env.calls[1].toolRequests, undefined);
  assert.match(JSON.stringify(env.calls[1].history), /@web_search/);
  await env.store.save();
  const restored = new Store(env.directory);
  await restored.init(false);
  const saved = restored
    .workspace(env.workspace.id)
    .nodes.find((item) => item.id === node.id)!;
  assert.deepEqual(saved.toolRequests, node.toolRequests);
  assert.deepEqual(
    restored.snapshot().workspaces[0].nodes.find((item) => item.id === node.id)!
      .toolRequests,
    node.toolRequests,
  );
});

test("request idempotence canonicalizes tool order and rejects changed or invalid tool intent", async (t) => {
  const env = await fixture(t);
  const input = {
    parentId: env.workspace.nodes[0].id,
    prompt: "查找资料后操作指定窗口",
    config,
    toolRequests: ["computer_use", "web_search"] as ToolRequest[],
    requestId: randomUUID(),
  };
  const first = await env.scheduler.submit(env.workspace.id, input);
  const duplicate = await env.scheduler.submit(env.workspace.id, {
    ...input,
    toolRequests: ["web_search", "computer_use"],
  });
  assert.equal(duplicate.id, first.id);
  await assert.rejects(
    env.scheduler.submit(env.workspace.id, {
      ...input,
      toolRequests: ["web_search"],
    }),
    /请求 ID/,
  );
  await assert.rejects(
    env.scheduler.submit(env.workspace.id, {
      ...input,
      toolRequests: ["bash"] as unknown as ToolRequest[],
    }),
    /工具/,
  );
  await until(() => first.status === "completed");
  assert.equal(env.calls.length, 1);
});

test("regeneration preserves omitted choices, archives prior choices, and treats [] as explicit clear", async (t) => {
  const env = await fixture(t);
  const original = await env.submit(["web_search"]);
  const retainedInput = {
    prompt: "重写回答",
    config,
    requestId: randomUUID(),
    expectedRevision: 0,
  };
  const retained = await settled(() =>
    env.scheduler.regenerate(env.workspace.id, original.id, retainedInput),
  );
  await until(() => retained.status === "completed");
  assert.deepEqual(retained.toolRequests, ["web_search"]);
  assert.equal(
    (
      await env.scheduler.regenerate(
        env.workspace.id,
        original.id,
        retainedInput,
      )
    ).revision,
    1,
  );
  const changedInput = {
    prompt: "检查桌面",
    config,
    requestId: randomUUID(),
    expectedRevision: 1,
    toolRequests: ["computer_use"] as ToolRequest[],
  };
  const changed = await settled(() =>
    env.scheduler.regenerate(env.workspace.id, original.id, changedInput),
  );
  await until(() => changed.status === "completed");
  assert.deepEqual(changed.toolRequests, ["computer_use"]);
  assert.deepEqual(
    changed.previousRuns!.map((run) => run.toolRequests),
    [["web_search"], ["web_search"]],
  );
  await assert.rejects(
    env.scheduler.regenerate(env.workspace.id, original.id, {
      ...changedInput,
      toolRequests: [],
    }),
    /请求 ID/,
  );
  const cleared = await settled(() =>
    env.scheduler.regenerate(env.workspace.id, original.id, {
      prompt: "只分析已有信息",
      config,
      requestId: randomUUID(),
      expectedRevision: 2,
      toolRequests: [],
    }),
  );
  await until(() => cleared.status === "completed");
  assert.deepEqual(cleared.toolRequests, []);
  assert.equal(env.calls.at(-1)!.prompt, "只分析已有信息");
  assert.deepEqual(cleared.previousRuns!.at(-1)!.toolRequests, [
    "computer_use",
  ]);
});

test("retry retains explicit choices and the archived failed run without treating history as a fresh selection", async (t) => {
  const env = await fixture(t);
  env.failNext();
  const failed = await env.submit(["computer_use", "web_search"]);
  assert.equal(failed.status, "failed");
  const retryInput = { requestId: randomUUID(), expectedRevision: 0 };
  const retried = await settled(() =>
    env.scheduler.retry(env.workspace.id, failed.id, retryInput),
  );
  await until(() => retried.status === "completed");
  assert.deepEqual(retried.toolRequests, ["web_search", "computer_use"]);
  assert.deepEqual(retried.previousRuns![0].toolRequests, retried.toolRequests);
  assert.deepEqual(env.calls.at(-1)!.toolRequests, retried.toolRequests);
  assert.match(env.calls.at(-1)!.prompt, /@web_search[\s\S]*@computer_use/);
  assert.doesNotMatch(
    JSON.stringify(env.calls.at(-1)!.history),
    /本条用户消息的显式工具选择/,
  );
  assert.equal(
    (await env.scheduler.retry(env.workspace.id, failed.id, retryInput))
      .revision,
    1,
  );
});

test("API validates explicit choices, advertises support, and exports them without accepting unknown IDs", async (t) => {
  const env = await fixture(t);
  const capabilities = await env.request("GET", "/capabilities");
  assert.equal(JSON.parse(capabilities.output).toolRequests, true);
  const path = `/workspaces/${env.workspace.id}/nodes`;
  const body = {
    parentId: env.workspace.nodes[0].id,
    prompt: "检索当前主题",
    config,
    toolRequests: ["web_search"],
    requestId: randomUUID(),
  };
  const created = await env.request("POST", path, body);
  assert.equal(created.status, 201, created.output);
  const nodeId = JSON.parse(created.output).nodeId;
  await until(
    () =>
      env.workspace.nodes.find((node) => node.id === nodeId)?.status ===
      "completed",
  );
  const exported = await env.request(
    "GET",
    `/workspaces/${env.workspace.id}/export`,
  );
  assert.deepEqual(
    JSON.parse(exported.output).workspace.nodes.find(
      (node: StoredNode) => node.id === nodeId,
    ).toolRequests,
    ["web_search"],
  );
  const markdown = await env.request(
    "GET",
    `/workspaces/${env.workspace.id}/export?format=markdown&node=${nodeId}`,
  );
  assert.match(markdown.output, /web_search/);
  const count = env.workspace.nodes.length;
  for (const toolRequests of [
    null,
    "web_search",
    [1],
    ["bash"],
    ["web_search", "web_search", "web_search", "web_search"],
  ]) {
    const invalid = await env.request("POST", path, {
      ...body,
      toolRequests,
      requestId: randomUUID(),
    });
    assert.equal(invalid.status, 400, invalid.output);
  }
  assert.equal(env.workspace.nodes.length, count);
});

function exportedFixture() {
  const workspace: StoredWorkspace = createWorkspace(
    "Imported choices",
    "Historical intent",
  );
  const root = workspace.nodes[0];
  const node: StoredNode = {
    ...structuredClone(root),
    id: "selected-tools",
    parentId: root.id,
    prompt: "查询资料后观察窗口",
    response: "历史回答",
    status: "completed",
    revision: 1,
    contextIds: [root.id],
    toolRequests: ["web_search", "computer_use"],
  };
  node.previousRuns = [
    {
      ...structuredClone(node),
      revision: 0,
      toolRequests: ["web_search"],
      archivedAt: Date.now(),
    },
  ];
  workspace.nodes.push(node);
  return { version: 1, workspace };
}

test("JSON import preserves tool selection provenance for current and archived runs but restores no live request", () => {
  const source = exportedFixture();
  Object.assign(source.workspace.nodes[1], {
    requestId: "old-request",
    execution: { workingDirectory: "/untrusted", approvalMode: "auto" },
  });
  const imported = importWorkspace(source);
  const node = imported.nodes[1];
  assert.deepEqual(node.toolRequests, ["web_search", "computer_use"]);
  assert.deepEqual(node.previousRuns![0].toolRequests, ["web_search"]);
  assert.equal(node.requestId, undefined);
  assert.equal(node.execution, undefined);
  const history = JSON.stringify(buildContext(imported, node.id).messages);
  assert.match(history, /以下是从 JSON 导入的历史轮次/);
  assert.match(history, /@web_search[\s\S]*@computer_use/);
  assert.match(history, /不要求后续新轮次重复调用/);
  for (const historical of [false, true]) {
    const corrupted = exportedFixture();
    const run = historical
      ? corrupted.workspace.nodes[1].previousRuns![0]
      : corrupted.workspace.nodes[1];
    run.toolRequests = ["bash"] as unknown as ToolRequest[];
    assert.throws(() => importWorkspace(corrupted), /工具/);
  }
  assert.equal(
    importWorkspace({
      version: 1,
      workspace: createWorkspace("Old export", ""),
    }).nodes[0].toolRequests,
    undefined,
  );
});

test("local completed and interrupted fallback history preserves tool-request provenance when transcript is absent", () => {
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const source = exportedFixture();
    const node = source.workspace.nodes[1];
    node.status = status;
    const text = JSON.stringify(
      buildContext(source.workspace, node.id).messages,
    );
    assert.match(text, /@web_search[\s\S]*@computer_use/);
    assert.match(text, /不要求后续新轮次重复调用/);
  }
});
