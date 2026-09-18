import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import type {
  AppState,
  ModelOption,
  RunConfig,
  SafetyReviewRequest,
  SafetyReviewResult,
} from "../shared/types.ts";
import { createApi } from "./api.ts";
import { PiRuntime, type RunEnvironment, type Runtime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store } from "./store.ts";
import { TOOL_POLICY_VERSION } from "./tool-authorization.ts";

const config: RunConfig = { model: "openai/tools-test", thinking: "off" };
const tool = (name: string, args: Record<string, unknown>, id: string) =>
  fauxAssistantMessage(fauxToolCall(name, args, { id }), {
    stopReason: "toolUse",
  });
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for execution state");
}

class LocalPiRuntime extends PiRuntime {
  readonly safetyRequests: SafetyReviewRequest[] = [];

  override models() {
    return super.models().map((model) => ({ ...model, available: true }));
  }

  override async reviewTool(
    request: SafetyReviewRequest,
    signal: AbortSignal,
  ): Promise<SafetyReviewResult> {
    signal.throwIfAborted();
    this.safetyRequests.push(structuredClone(request));
    return { decision: "approve", reason: "测试安全模型已批准此操作。" };
  }
}

async function setup(
  responses: AssistantMessage[],
  mode: "ask" | "auto" = "ask",
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-execution-")),
  );
  const project = join(directory, "project");
  await mkdir(project);
  const store = new Store(join(directory, "state"));
  await store.init(false);
  const workspace = createWorkspace("编码项目", "测试本地工具");
  workspace.workingDirectory = project;
  workspace.approvalMode = mode;
  workspace.safetyModel = config.model;
  store.data.workspaces.push(workspace);
  const registry = createModels();
  const faux = fauxProvider({
    provider: "openai",
    models: [{ id: "tools-test" }],
    tokensPerSecond: 100000,
    tokenSize: { min: 100, max: 200 },
  });
  faux.setResponses(responses);
  registry.setProvider(faux.provider);
  const runtime = new LocalPiRuntime(registry);
  const scheduler = new Scheduler(store, runtime);
  const submit = () =>
    scheduler.submit(workspace.id, {
      parentId: workspace.nodes[0].id,
      prompt: "执行测试",
      config,
      requestId: randomUUID(),
    });
  const cleanup = async () => {
    scheduler.shutdown();
    await delay(80);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  };
  return {
    directory,
    project,
    store,
    workspace,
    runtime,
    scheduler,
    submit,
    cleanup,
  };
}

test("actual Pi tools write, edit, execute and read code only after safety model approval", async () => {
  const env = await setup(
    [
      tool(
        "write",
        { path: "hello.cjs", content: "console.log(1 + 1);\n" },
        "write-1",
      ),
      tool(
        "edit",
        { path: "hello.cjs", edits: [{ oldText: "1 + 1", newText: "2 + 3" }] },
        "edit-1",
      ),
      tool(
        "bash",
        { command: `'${process.execPath.replaceAll("'", "'\\''")}' hello.cjs` },
        "bash-1",
      ),
      tool("read", { path: "hello.cjs" }, "read-1"),
      fauxAssistantMessage("已验证输出 5"),
    ],
    "auto",
  );
  try {
    const node = await env.submit();
    await until(() => node.status === "completed" || node.status === "failed");
    assert.equal(node.status, "completed", node.error);
    assert.equal(
      await readFile(join(env.project, "hello.cjs"), "utf8"),
      "console.log(2 + 3);\n",
    );
    assert.equal(node.toolCalls?.length, 4);
    assert.ok(
      node.toolCalls?.every(
        (call) =>
          call.status === "completed" &&
          call.approval === "safety_model" &&
          call.safetyReview?.model === config.model &&
          call.safetyReview.decision === "approve" &&
          Boolean(call.safetyReview.reason) &&
          Boolean(call.authorization?.consumedAt) &&
          !call.authorization?.invalidatedAt,
      ),
    );
    assert.deepEqual(
      env.runtime.safetyRequests.map((request) => request.tool.name),
      ["write", "edit", "bash", "read"],
    );
    assert.ok(
      env.runtime.safetyRequests.every(
        (request) =>
          request.model === config.model &&
          request.workingDirectory === env.project &&
          request.userRequest === "执行测试",
      ),
    );
    assert.match(node.toolCalls![2].output!, /5/);
    assert.equal(
      node.messages?.filter((message) => message.role === "toolResult").length,
      4,
    );
    assert.equal(node.execution?.workingDirectory, env.project);
    assert.equal(node.execution?.safetyModel, config.model);
    await env.store.save();
    const persisted = JSON.parse(
      await readFile(join(env.directory, "state", "state.json"), "utf8"),
    );
    for (const call of persisted.workspaces[0].nodes[1].toolCalls) {
      assert.match(call.authorization.actionHash, /^[a-f0-9]{64}$/);
      assert.equal(call.authorization.policyVersion, TOOL_POLICY_VERSION);
      assert.ok(call.authorization.consumedAt >= call.authorization.issuedAt);
      assert.ok(call.authorization.consumedAt < call.authorization.expiresAt);
    }
  } finally {
    await env.cleanup();
  }
});

test("the actual Pi execution wrapper rejects arguments changed after review", async () => {
  const env = await setup(
    [
      tool("write", { path: "changed.txt", content: "approved" }, "write-1"),
      fauxAssistantMessage("操作已阻止"),
    ],
    "auto",
  );
  const run = env.runtime.run.bind(env.runtime);
  env.runtime.run = (config, history, prompt, signal, onText, execution) => {
    assert.ok(execution);
    return run(config, history, prompt, signal, onText, {
      ...execution,
      beforeToolCall: async (call) => {
        const allowed = await execution.beforeToolCall(call);
        // Simulate a later hook mutating Pi's validated arguments.
        call.arguments.content = "unapproved payload";
        return allowed;
      },
    });
  };
  try {
    const node = await env.submit();
    await until(() => node.status === "completed" || node.status === "failed");
    assert.equal(node.status, "completed", node.error);
    assert.equal(
      env.runtime.safetyRequests[0].tool.arguments.content,
      "approved",
    );
    assert.equal(node.toolCalls![0].status, "failed");
    assert.ok(node.toolCalls![0].authorization?.invalidatedAt);
    assert.match(node.toolCalls![0].error!, /参数或审批配置已变化/);
    await assert.rejects(stat(join(env.project, "changed.txt")), /ENOENT/);
  } finally {
    await env.cleanup();
  }
});

test("manual approval is durable and a mode toggle does not implicitly approve a waiting write", async () => {
  const env = await setup([
    tool("write", { path: "approved.txt", content: "approved" }, "write-1"),
    fauxAssistantMessage("完成"),
  ]);
  try {
    const node = await env.submit();
    await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
    await assert.rejects(stat(join(env.project, "approved.txt")), /ENOENT/);
    assert.equal(
      env.store.snapshot().workspaces[0].nodes[1].toolCalls?.[0].status,
      "awaiting_approval",
    );
    env.workspace.approvalMode = "auto";
    await delay(30);
    assert.equal(node.toolCalls![0].status, "awaiting_approval");
    const save = env.store.save.bind(env.store);
    env.store.save = async () => {
      throw new Error("approval save failed");
    };
    await assert.rejects(
      env.scheduler.approve(env.workspace.id, node.id, "write-1", "approve"),
      /approval save failed/,
    );
    assert.equal(node.toolCalls![0].status, "awaiting_approval");
    await assert.rejects(stat(join(env.project, "approved.txt")), /ENOENT/);
    env.store.save = save;
    await env.scheduler.approve(
      env.workspace.id,
      node.id,
      "write-1",
      "approve",
    );
    await until(() => node.status === "completed");
    assert.equal(
      await readFile(join(env.project, "approved.txt"), "utf8"),
      "approved",
    );
    assert.equal(node.toolCalls![0].approval, "approved");
    assert.equal(node.execution?.approvalMode, "ask");
    await assert.rejects(
      env.scheduler.approve(env.workspace.id, node.id, "write-1", "approve"),
      /失效/,
    );
  } finally {
    await env.cleanup();
  }
});

test("reads pass without asking; rejected writes never execute and denial reaches the model", async () => {
  const env = await setup([
    tool("read", { path: "existing.txt" }, "read-1"),
    tool("write", { path: "denied.txt", content: "must not exist" }, "write-1"),
    fauxAssistantMessage("用户拒绝写入"),
  ]);
  try {
    await writeFile(join(env.project, "existing.txt"), "read me");
    const node = await env.submit();
    await until(() => node.toolCalls?.[1]?.status === "awaiting_approval");
    assert.equal(node.toolCalls![0].status, "completed");
    assert.equal(node.toolCalls![0].approval, "policy");
    assert.equal(env.runtime.safetyRequests.length, 0);
    await env.scheduler.approve(env.workspace.id, node.id, "write-1", "deny");
    await until(() => node.status === "completed");
    assert.equal(node.toolCalls![1].status, "denied");
    assert.ok(
      node.messages?.some(
        (message) => message.role === "toolResult" && message.isError,
      ),
    );
    await assert.rejects(stat(join(env.project, "denied.txt")), /ENOENT/);
  } finally {
    await env.cleanup();
  }
});

test("cancellation and service restart invalidate pending approvals without executing commands", async () => {
  const env = await setup([
    tool("bash", { command: "touch should-not-exist" }, "bash-1"),
    fauxAssistantMessage("停止"),
  ]);
  try {
    const node = await env.submit();
    await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
    await env.store.save();
    const restarted = new Store(join(env.directory, "state"));
    await restarted.init(false);
    const restored = restarted.workspace(env.workspace.id).nodes[1];
    assert.equal(restored.status, "failed");
    assert.equal(restored.toolCalls![0].status, "cancelled");
    await env.scheduler.cancel(env.workspace.id, node.id);
    await assert.rejects(
      env.scheduler.approve(env.workspace.id, node.id, "bash-1", "approve"),
      /失效/,
    );
    await delay(40);
    assert.equal(node.status, "cancelled");
    assert.equal(node.toolCalls![0].status, "cancelled");
    await assert.rejects(stat(join(env.project, "should-not-exist")), /ENOENT/);
  } finally {
    await env.cleanup();
  }
});

test("HTTP directory selection, settings, origin checks and approval use server-side validation", async () => {
  const toolId = "tool:write/1";
  const env = await setup([
    tool("write", { path: "http.txt", content: "yes" }, toolId),
    fauxAssistantMessage("完成"),
  ]);
  const handler = createApi(env.store, env.runtime, env.scheduler);
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  const request = (
    path: string,
    body: unknown,
    method = "POST",
    origin?: string,
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    const listing = await fetch(
      `${base}/directories?path=${encodeURIComponent(env.directory)}`,
    );
    assert.equal(listing.status, 200);
    const listingBody = (await listing.json()) as {
      directories: { path: string }[];
    };
    assert.ok(
      listingBody.directories.some((item) => item.path === env.project),
    );
    assert.equal(
      (
        await fetch(`${base}/directories`, {
          headers: { Origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/workspaces", {
          title: "Bad",
          workingDirectory: "relative/path",
        })
      ).status,
      400,
    );
    const created = await request("/workspaces", {
      title: "项目",
      workingDirectory: env.project,
      approvalMode: "ask",
    });
    assert.equal(created.status, 201);
    const newState = ((await created.json()) as { state: AppState }).state;
    assert.equal(newState.workspaces[0].workingDirectory, env.project);
    const node = await env.submit();
    await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
    const endpoint = `/workspaces/${env.workspace.id}`;
    assert.equal(
      (await request(endpoint, { workingDirectory: env.directory }, "PATCH"))
        .status,
      400,
    );
    assert.equal(
      (await request(endpoint, { approvalMode: "invalid" }, "PATCH")).status,
      400,
    );
    assert.equal(
      (await request(endpoint, { approvalMode: "auto" }, "PATCH")).status,
      200,
    );
    assert.equal(node.toolCalls![0].status, "awaiting_approval");
    const approve = `${endpoint}/nodes/${node.id}/approvals/${encodeURIComponent(toolId)}`;
    assert.equal(
      (
        await request(
          approve,
          { decision: "approve" },
          "POST",
          "https://untrusted.example",
        )
      ).status,
      403,
    );
    assert.equal((await request(approve, { decision: "approve" })).status, 200);
    await until(() => node.status === "completed");
    assert.equal(await readFile(join(env.project, "http.txt"), "utf8"), "yes");
    assert.equal(
      (await request(endpoint, { workingDirectory: null }, "PATCH")).status,
      200,
    );
    assert.equal(node.execution?.workingDirectory, env.project);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await env.cleanup();
  }
});

test("a failed settings save rolls approval back, and tool batches run sequentially", async () => {
  const env = await setup([
    fauxAssistantMessage(
      [
        fauxToolCall(
          "write",
          { path: "ordered.txt", content: "first" },
          { id: "write-1" },
        ),
        fauxToolCall("bash", { command: "cat ordered.txt" }, { id: "bash-1" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("按顺序完成"),
  ]);
  try {
    const save = env.store.save.bind(env.store);
    env.store.save = async () => {
      throw new Error("disk failed");
    };
    await assert.rejects(
      env.scheduler.configureWorkspace(env.workspace.id, {
        approvalMode: "auto",
      }),
      /disk failed/,
    );
    assert.equal(env.workspace.approvalMode, "ask");
    env.store.save = save;
    await Promise.all([
      env.scheduler.configureWorkspace(env.workspace.id, {
        approvalMode: "auto",
      }),
      env.store.save(),
    ]);
    const persisted = JSON.parse(
      await readFile(join(env.directory, "state", "state.json"), "utf8"),
    );
    assert.equal(persisted.workspaces[0].approvalMode, "auto");
    await env.scheduler.configureWorkspace(env.workspace.id, {
      approvalMode: "ask",
    });
    const node = await env.submit();
    await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
    assert.equal(node.toolCalls?.length, 1);
    await env.scheduler.approve(
      env.workspace.id,
      node.id,
      "write-1",
      "approve",
    );
    await until(() => node.toolCalls?.[1]?.status === "awaiting_approval");
    assert.equal(
      await readFile(join(env.project, "ordered.txt"), "utf8"),
      "first",
    );
    await env.scheduler.approve(env.workspace.id, node.id, "bash-1", "approve");
    await until(() => node.status === "completed");
    assert.match(node.toolCalls![1].output!, /first/);
  } finally {
    await env.cleanup();
  }
});

test("overlapping coding directories serialize while independent projects still run in parallel", async () => {
  const env = await setup([]);
  const calls: string[] = [];
  const releases = new Map<string, () => void>();
  const runtime: Runtime = {
    models: (): ModelOption[] => env.runtime.models(),
    async run(
      _config: RunConfig,
      _history: Message[],
      prompt: string,
      signal: AbortSignal,
      _text: (text: string) => void,
      execution?: RunEnvironment,
    ) {
      assert.ok(execution);
      calls.push(prompt);
      await new Promise<void>((resolve) => {
        releases.set(prompt, resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      signal.throwIfAborted();
      return { messages: [fauxAssistantMessage("done")], response: "done" };
    },
  };
  const scheduler = new Scheduler(env.store, runtime, 3);
  try {
    const nested = createWorkspace("Nested", "");
    nested.workingDirectory = join(env.project, "nested");
    await mkdir(nested.workingDirectory);
    const independent = createWorkspace("Independent", "");
    independent.workingDirectory = join(env.directory, "other");
    await mkdir(independent.workingDirectory);
    env.store.data.workspaces.push(nested, independent);
    const submit = (workspace: typeof env.workspace, prompt: string) =>
      scheduler.submit(workspace.id, {
        parentId: workspace.nodes[0].id,
        prompt,
        config,
        requestId: randomUUID(),
      });
    const first = await submit(env.workspace, "first");
    const second = await submit(env.workspace, "same");
    const third = await submit(nested, "nested");
    const fourth = await submit(independent, "independent");
    await until(() => calls.length === 2);
    assert.deepEqual(calls, ["first", "independent"]);
    assert.equal(second.status, "queued");
    assert.equal(third.status, "queued");
    releases.get("first")!();
    await until(() => calls.includes("same"));
    assert.equal(first.status, "completed");
    releases.get("same")!();
    await until(() => calls.includes("nested"));
    releases.get("nested")!();
    releases.get("independent")!();
    await until(
      () => third.status === "completed" && fourth.status === "completed",
    );
  } finally {
    scheduler.shutdown();
    await env.cleanup();
  }
});

test("a tool waits for later queued approval settings before deciding whether to run", async () => {
  const env = await setup([]);
  env.runtime.run = async (
    _config,
    _history,
    _prompt,
    signal,
    _text,
    execution,
  ) => {
    assert.ok(execution);
    const automatic = env.scheduler.configureWorkspace(env.workspace.id, {
      approvalMode: "auto",
    });
    const permission = execution.beforeToolCall({
      id: "queued-write",
      name: "write",
      arguments: { path: "never.txt", content: "no" },
    });
    const manual = env.scheduler.configureWorkspace(env.workspace.id, {
      approvalMode: "ask",
    });
    await Promise.all([automatic, manual]);
    const allowed = await permission;
    signal.throwIfAborted();
    assert.equal(allowed, false);
    return { response: "拒绝", messages: [fauxAssistantMessage("拒绝")] };
  };
  try {
    const node = await env.submit();
    await until(() => Boolean(node.toolCalls?.length));
    assert.equal(env.workspace.approvalMode, "ask");
    assert.equal(node.toolCalls![0].status, "awaiting_approval");
    await env.scheduler.approve(
      env.workspace.id,
      node.id,
      "queued-write",
      "deny",
    );
    await until(() => node.status === "completed");
  } finally {
    await env.cleanup();
  }
});

function holdSafetyReview(runtime: LocalPiRuntime) {
  let release!: (result: SafetyReviewResult) => void;
  const result = new Promise<SafetyReviewResult>((resolve) => {
    release = resolve;
  });
  runtime.reviewTool = async (request) => {
    runtime.safetyRequests.push(structuredClone(request));
    return result;
  };
  return () => release({ decision: "approve", reason: "测试安全模型批准。" });
}

test("a pending safety review cannot execute a tool and persists the configured independent reviewer", async () => {
  const env = await setup(
    [
      tool("write", { path: "reviewed.txt", content: "reviewed" }, "write-1"),
      fauxAssistantMessage("完成"),
    ],
    "auto",
  );
  const models = env.runtime.models();
  const reviewer = "openai/independent-safety-model";
  env.runtime.models = () => [
    ...models,
    { ...models.find((model) => model.id === config.model)!, id: reviewer },
  ];
  env.workspace.safetyModel = reviewer;
  const release = holdSafetyReview(env.runtime);
  try {
    const node = await env.submit();
    await until(() => env.runtime.safetyRequests.length === 1);
    assert.equal(node.toolCalls![0].status, "reviewing");
    assert.equal(node.toolCalls![0].approval, undefined);
    assert.equal(node.toolCalls![0].safetyReview?.decision, "reviewing");
    assert.equal(env.runtime.safetyRequests[0].model, reviewer);
    await assert.rejects(stat(join(env.project, "reviewed.txt")), /ENOENT/);
    await assert.rejects(
      env.scheduler.approve(env.workspace.id, node.id, "write-1", "approve"),
      /失效/,
    );
    const persisted = JSON.parse(
      await readFile(join(env.directory, "state", "state.json"), "utf8"),
    );
    assert.equal(
      persisted.workspaces[0].nodes[1].toolCalls[0].safetyReview.decision,
      "reviewing",
    );
    release();
    await until(() => node.status === "completed" || node.status === "failed");
    assert.equal(node.status, "completed", node.error);
    assert.equal(
      await readFile(join(env.project, "reviewed.txt"), "utf8"),
      "reviewed",
    );
    assert.equal(node.toolCalls![0].approval, "safety_model");
    assert.equal(node.toolCalls![0].safetyReview?.model, reviewer);
    assert.equal(node.toolCalls![0].safetyReview?.decision, "approve");
    assert.ok(node.toolCalls![0].safetyReview?.finishedAt);
  } finally {
    release();
    await env.cleanup();
  }
});

test("rejected, failed and malformed safety reviews wait for a durable human decision", async (t) => {
  for (const scenario of [
    {
      name: "deny",
      result: { decision: "deny", reason: "用户未授权此写入。" },
      decision: "deny",
    },
    {
      name: "error",
      error: new Error("reviewer unavailable"),
      decision: "approve",
    },
    {
      name: "empty reason",
      result: { decision: "approve", reason: "   " },
      decision: "deny",
    },
    {
      name: "invalid decision",
      result: { decision: "maybe", reason: "不确定" },
      decision: "deny",
    },
  ] as const) {
    await t.test(scenario.name, async () => {
      const env = await setup(
        [
          tool("write", { path: "manual.txt", content: "manual" }, "write-1"),
          fauxAssistantMessage("完成"),
        ],
        "auto",
      );
      env.runtime.reviewTool = async () => {
        if ("error" in scenario) throw scenario.error;
        return scenario.result as SafetyReviewResult;
      };
      try {
        const node = await env.submit();
        await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
        assert.equal(node.toolCalls![0].approval, undefined);
        assert.equal(
          node.toolCalls![0].safetyReview?.decision,
          scenario.name === "deny" ? "deny" : "error",
        );
        assert.ok(node.toolCalls![0].safetyReview?.reason);
        await assert.rejects(stat(join(env.project, "manual.txt")), /ENOENT/);
        await env.scheduler.approve(
          env.workspace.id,
          node.id,
          "write-1",
          scenario.decision,
        );
        await until(
          () => node.status === "completed" || node.status === "failed",
        );
        assert.equal(node.status, "completed", node.error);
        if (scenario.decision === "approve") {
          assert.equal(
            await readFile(join(env.project, "manual.txt"), "utf8"),
            "manual",
          );
          assert.equal(node.toolCalls![0].approval, "approved");
        } else {
          await assert.rejects(stat(join(env.project, "manual.txt")), /ENOENT/);
          assert.equal(node.toolCalls![0].status, "denied");
        }
      } finally {
        await env.cleanup();
      }
    });
  }
});

test("legacy persisted auto settings without a safety model fail closed without using the execution model", async () => {
  const env = await setup(
    [
      tool("write", { path: "legacy.txt", content: "forbidden" }, "write-1"),
      fauxAssistantMessage("停止"),
    ],
    "auto",
  );
  delete env.workspace.safetyModel;
  await env.store.save();
  try {
    const node = await env.submit();
    await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
    assert.equal(env.runtime.safetyRequests.length, 0);
    assert.equal(node.toolCalls![0].safetyReview?.decision, "error");
    assert.match(node.toolCalls![0].safetyReview!.reason, /选择安全模型/);
    await assert.rejects(stat(join(env.project, "legacy.txt")), /ENOENT/);
    await env.scheduler.approve(env.workspace.id, node.id, "write-1", "deny");
    await until(() => node.status === "completed");
  } finally {
    await env.cleanup();
  }
});

test("late safety approval after cancellation never executes, and restart invalidates reviewing state", async () => {
  const env = await setup(
    [
      tool("write", { path: "cancelled.txt", content: "forbidden" }, "write-1"),
      fauxAssistantMessage("停止"),
    ],
    "auto",
  );
  const release = holdSafetyReview(env.runtime);
  try {
    const node = await env.submit();
    await until(() => env.runtime.safetyRequests.length === 1);
    await env.store.save();
    const restarted = new Store(join(env.directory, "state"));
    await restarted.init(false);
    const restored = restarted.workspace(env.workspace.id).nodes[1];
    assert.equal(restored.status, "failed");
    assert.equal(restored.toolCalls![0].status, "cancelled");
    assert.equal(restored.toolCalls![0].safetyReview?.decision, "cancelled");
    assert.match(restored.toolCalls![0].safetyReview!.reason, /重启/);
    await env.scheduler.cancel(env.workspace.id, node.id);
    release();
    await delay(100);
    assert.equal(node.status, "cancelled");
    assert.equal(node.toolCalls![0].status, "cancelled");
    assert.equal(node.toolCalls![0].safetyReview?.decision, "cancelled");
    await assert.rejects(stat(join(env.project, "cancelled.txt")), /ENOENT/);
  } finally {
    release();
    await env.cleanup();
  }
});

test("changing approval mode during a review invalidates its approval even if auto is restored", async (t) => {
  for (const restoreAuto of [false, true]) {
    await t.test(restoreAuto ? "ask then auto" : "ask", async () => {
      const env = await setup(
        [
          tool(
            "write",
            { path: "changed.txt", content: "forbidden" },
            "write-1",
          ),
          fauxAssistantMessage("停止"),
        ],
        "auto",
      );
      const release = holdSafetyReview(env.runtime);
      try {
        const node = await env.submit();
        await until(() => env.runtime.safetyRequests.length === 1);
        await env.scheduler.configureWorkspace(env.workspace.id, {
          approvalMode: "ask",
        });
        if (restoreAuto)
          await env.scheduler.configureWorkspace(env.workspace.id, {
            approvalMode: "auto",
          });
        release();
        await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
        assert.equal(node.toolCalls![0].safetyReview?.decision, "error");
        assert.match(node.toolCalls![0].safetyReview!.reason, /设置已改变/);
        await assert.rejects(stat(join(env.project, "changed.txt")), /ENOENT/);
        await env.scheduler.approve(
          env.workspace.id,
          node.id,
          "write-1",
          "deny",
        );
        await until(() => node.status === "completed");
      } finally {
        release();
        await env.cleanup();
      }
    });
  }
});

test("settings queued while safety approval is being saved invalidate the approval before tool execution", async (t) => {
  for (const setting of ["mode", "model"] as const) {
    await t.test(setting, async () => {
      const env = await setup(
        [
          tool(
            "write",
            { path: "racing.txt", content: "forbidden" },
            "write-1",
          ),
          fauxAssistantMessage("停止"),
        ],
        "auto",
      );
      const nextReviewer = "openai/replacement-safety-model";
      const models = env.runtime.models();
      env.runtime.models = () => [
        ...models,
        {
          ...models.find((model) => model.id === config.model)!,
          id: nextReviewer,
        },
      ];
      let releaseApprovalSave!: () => void;
      let releaseSettingsSave!: () => void;
      const approvalSaved = new Promise<void>((resolve) => {
        releaseApprovalSave = resolve;
      });
      const settingsSaved = new Promise<void>((resolve) => {
        releaseSettingsSave = resolve;
      });
      const save = env.store.save.bind(env.store);
      let approvalSavePending = false;
      let settingsSavePending = false;
      env.store.save = async (...args: Parameters<Store["save"]>) => {
        if (args[0]) {
          settingsSavePending = true;
          await settingsSaved;
        } else if (
          !approvalSavePending &&
          env.workspace.nodes.some((node) =>
            node.toolCalls?.some(
              (call) =>
                call.status === "running" && call.approval === "safety_model",
            ),
          )
        ) {
          approvalSavePending = true;
          await approvalSaved;
        }
        return save(...args);
      };
      try {
        const node = await env.submit();
        await until(() => approvalSavePending);
        assert.equal(node.toolCalls![0].safetyReview?.decision, "approve");
        await assert.rejects(stat(join(env.project, "racing.txt")), /ENOENT/);
        const changed = env.scheduler.configureWorkspace(
          env.workspace.id,
          setting === "mode"
            ? { approvalMode: "ask" }
            : { safetyModel: nextReviewer },
        );
        await until(() => settingsSavePending);
        releaseApprovalSave();
        await delay(40);
        // The setting itself is still saving: execution must wait for that
        // queued change before deciding whether the old approval is valid.
        await assert.rejects(stat(join(env.project, "racing.txt")), /ENOENT/);
        releaseSettingsSave();
        await changed;
        await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
        assert.equal(node.toolCalls![0].approval, undefined);
        assert.equal(node.toolCalls![0].safetyReview?.decision, "error");
        assert.match(node.toolCalls![0].safetyReview!.reason, /设置已改变/);
        assert.equal(env.runtime.safetyRequests.length, 1);
        await assert.rejects(stat(join(env.project, "racing.txt")), /ENOENT/);
        await env.scheduler.approve(
          env.workspace.id,
          node.id,
          "write-1",
          "deny",
        );
        await until(() => node.status === "completed");
        await assert.rejects(stat(join(env.project, "racing.txt")), /ENOENT/);
      } finally {
        releaseApprovalSave();
        releaseSettingsSave();
        env.store.save = save;
        await env.cleanup();
      }
    });
  }
});

test("a safety approval that cannot be persisted never grants tool execution", async () => {
  const env = await setup(
    [
      tool("write", { path: "unsaved.txt", content: "forbidden" }, "write-1"),
      fauxAssistantMessage("停止"),
    ],
    "auto",
  );
  const save = env.store.save.bind(env.store);
  let failedApprovalSave = false;
  env.store.save = async (...args: Parameters<Store["save"]>) => {
    if (
      !failedApprovalSave &&
      env.workspace.nodes.some((node) =>
        node.toolCalls?.some((call) => call.approval === "safety_model"),
      )
    ) {
      failedApprovalSave = true;
      throw new Error("cannot persist safety approval");
    }
    return save(...args);
  };
  try {
    const node = await env.submit();
    await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
    assert.equal(failedApprovalSave, true);
    assert.equal(node.toolCalls![0].approval, undefined);
    assert.equal(node.toolCalls![0].safetyReview?.decision, "error");
    assert.match(
      node.toolCalls![0].safetyReview!.reason,
      /cannot persist safety approval/,
    );
    await assert.rejects(stat(join(env.project, "unsaved.txt")), /ENOENT/);
    await env.scheduler.approve(env.workspace.id, node.id, "write-1", "deny");
    await until(() => node.status === "completed");
  } finally {
    env.store.save = save;
    await env.cleanup();
  }
});

test("HTTP creation and settings require an explicitly configured, available non-demo safety model for auto mode", async () => {
  const env = await setup([]);
  const models = env.runtime.models();
  const baseModel = models.find((model) => model.id === config.model)!;
  env.runtime.models = () => [
    ...models,
    { ...baseModel, id: "test/unavailable", available: false },
    { ...baseModel, id: "test/demo", demo: true },
  ];
  delete env.workspace.safetyModel;
  const handler = createApi(env.store, env.runtime, env.scheduler);
  const server = createServer(
    (request, response) => void handler(request, response),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const request = (path: string, body: unknown, method = "POST") =>
    fetch(`http://127.0.0.1:${address.port}/api${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    for (const safetyModel of [
      undefined,
      null,
      "",
      "test/missing",
      "test/demo",
      "test/unavailable",
    ]) {
      const create = await request("/workspaces", {
        title: "自动审批项目",
        workingDirectory: env.project,
        approvalMode: "auto",
        safetyModel,
      });
      assert.equal(create.status, 400, `creation with ${String(safetyModel)}`);
      const change = await request(
        `/workspaces/${env.workspace.id}`,
        {
          approvalMode: "auto",
          safetyModel,
        },
        "PATCH",
      );
      assert.equal(change.status, 400, `settings with ${String(safetyModel)}`);
      assert.equal(env.workspace.approvalMode, "ask");
      assert.equal(env.workspace.safetyModel, undefined);
    }
    const created = await request("/workspaces", {
      title: "安全模型审核项目",
      workingDirectory: env.project,
      approvalMode: "auto",
      safetyModel: config.model,
    });
    assert.equal(created.status, 201);
    const createdState = ((await created.json()) as { state: AppState }).state;
    assert.equal(createdState.workspaces[0].safetyModel, config.model);
    assert.equal(createdState.workspaces[0].approvalMode, "auto");
    assert.equal(
      (
        await request(
          `/workspaces/${env.workspace.id}`,
          {
            approvalMode: "auto",
            safetyModel: config.model,
          },
          "PATCH",
        )
      ).status,
      200,
    );
    assert.equal(env.workspace.safetyModel, config.model);
    assert.equal(
      (
        await request(
          `/workspaces/${env.workspace.id}`,
          {
            safetyModel: null,
          },
          "PATCH",
        )
      ).status,
      400,
    );
    assert.equal(env.workspace.safetyModel, config.model);
    assert.equal(
      (
        await request(
          `/workspaces/${env.workspace.id}`,
          {
            approvalMode: "ask",
            safetyModel: null,
          },
          "PATCH",
        )
      ).status,
      200,
    );
    assert.equal(env.workspace.safetyModel, undefined);
    assert.equal(env.workspace.approvalMode, "ask");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await env.cleanup();
  }
});
