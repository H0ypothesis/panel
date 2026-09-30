import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type JsonObject,
} from "@earendil-works/pi-ai";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RunConfig, SafetyReviewRequest } from "../shared/types.ts";
import {
  ComputerUse,
  type ComputerDriver,
  type ComputerSession,
} from "./computer-use.ts";
import { PiRuntime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store } from "./store.ts";

const config: RunConfig = { model: "openai/cua-preflight", thinking: "off" };
const target = { kind: "window" as const, pid: 100, windowId: 1 };
const schemas: Tool[] = [
  {
    name: "get_window_state",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string" },
        pid: { type: "integer" },
        window_id: { type: "integer" },
        max_elements: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["session", "pid", "window_id"],
      additionalProperties: false,
    },
  },
];

class FakeDriver implements ComputerDriver {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  sessions = 0;
  closed = 0;
  getStatus() {
    return { installed: true, state: "ready", version: "test" };
  }
  async openSession(): Promise<ComputerSession> {
    const id = `preflight-${++this.sessions}`;
    let closed = false;
    return {
      id,
      generation: 0,
      listTools: async () => structuredClone(schemas),
      callTool: async (name, args) => {
        this.calls.push({ name, args: structuredClone(args) });
        return name === "check_permissions"
          ? {
              structuredContent: {
                accessibility: true,
                screen_recording: true,
              },
            }
          : { content: [{ type: "text", text: "observed target" }] };
      },
      close: async () => {
        if (!closed) {
          this.closed++;
          closed = true;
        }
      },
    };
  }
  async close() {}
}

class ReviewedRuntime extends PiRuntime {
  readonly reviews: SafetyReviewRequest[] = [];
  override models() {
    return super.models().map((model) => ({ ...model, available: true }));
  }
  override async reviewTool(request: SafetyReviewRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    this.reviews.push(structuredClone(request));
    return { decision: "approve" as const, reason: "Test review" };
  }
}

async function until(check: () => boolean) {
  for (let count = 0; count < 400; count++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Timed out waiting for CUA preflight result");
}

async function fixture(t: TestContext, mode: "auto" | "ask", args: JsonObject) {
  const directory = await mkdtemp(join(tmpdir(), "panel-cua-preflight-"));
  const store = new Store(directory);
  await store.init(false);
  const workspace = createWorkspace("Preflight", "Validate before approval");
  workspace.approvalMode = mode;
  workspace.safetyModel = config.model;
  store.data.workspaces.push(workspace);
  const faux = fauxProvider({
    provider: "openai",
    models: [
      {
        id: "cua-preflight",
        input: ["text", "image"],
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    tokensPerSecond: 1000000,
    tokenSize: { min: 2000, max: 3000 },
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("computer_use_tools", { group: "core" }, { id: "catalog" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall(
        "computer_use_call",
        { tool: "get_window_state", target, arguments: args },
        { id: "observe" },
      ),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("I received the actual tool result."),
  ]);
  const registry = createModels();
  registry.setProvider(faux.provider);
  const driver = new FakeDriver();
  const computer = new ComputerUse(driver);
  const runtime = new ReviewedRuntime(registry, undefined, computer);
  const scheduler = new Scheduler(store, runtime);
  t.after(async () => {
    computer.locks.releaseOwner("other-run");
    scheduler.shutdown();
    await delay(20);
    await runtime.close();
    await store.save();
    await rm(directory, { recursive: true, force: true });
  });
  const submit = () =>
    scheduler.submit(workspace.id, {
      parentId: workspace.nodes[0].id,
      prompt: "Observe the selected window",
      config,
      requestId: randomUUID(),
    });
  return { store, workspace, driver, computer, runtime, scheduler, submit };
}

for (const mode of ["auto", "ask"] as const) {
  for (const [label, args] of [
    [
      "nested wrapper envelope",
      { tool: "get_window_state", arguments: { max_elements: 5 } },
    ],
    ["unknown driver property", { max_elements: 5, nonexistent_option: true }],
  ] as const) {
    test(`${label} fails preflight before ${mode} approval and never waits for a busy window`, async (t) => {
      const env = await fixture(t, mode, args);
      await env.computer.locks.acquireTarget("other-run", target);
      const node = await env.submit();
      if (mode === "ask") {
        await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
        await env.scheduler.approve(
          env.workspace.id,
          node.id,
          "catalog",
          "approve",
        );
      }
      await until(
        () => node.status === "completed" || node.status === "failed",
      );
      assert.equal(node.status, "completed", node.error);
      const invalid = node.toolCalls!.find((call) => call.id === "observe")!;
      assert.equal(invalid.status, "failed");
      assert.match(invalid.error!, /schema|参数|arguments|tool|属性/);
      assert.equal(invalid.approval, undefined);
      assert.equal(invalid.authorization, undefined);
      assert.equal(invalid.safetyReview, undefined);
      assert.equal(invalid.waitingFor, undefined);
      assert.deepEqual(
        env.runtime.reviews.map((review) => review.tool.id),
        mode === "auto" ? ["catalog"] : [],
      );
      assert.equal(
        env.driver.calls.some((call) => call.name === "get_window_state"),
        false,
      );
      assert.ok(env.computer.locks.getTarget("other-run"));
    });
  }
}

test("valid flat driver arguments proceed through safety review and exact authorization", async (t) => {
  const env = await fixture(t, "auto", { max_elements: 5 });
  const node = await env.submit();
  await until(() => node.status === "completed" || node.status === "failed");
  assert.equal(node.status, "completed", node.error);
  const call = node.toolCalls!.find((call) => call.id === "observe")!;
  assert.equal(call.status, "completed", call.error);
  assert.equal(call.approval, "safety_model");
  assert.ok(call.authorization?.consumedAt);
  assert.deepEqual(
    env.runtime.reviews.map((review) => review.tool.id),
    ["catalog", "observe"],
  );
  assert.deepEqual(env.runtime.reviews[1].tool.arguments, {
    tool: "get_window_state",
    target,
    arguments: { max_elements: 5 },
  });
  assert.deepEqual(
    env.driver.calls
      .filter((call) => call.name === "get_window_state")
      .map((call) => call.args),
    [{ max_elements: 5, session: "preflight-1", pid: 100, window_id: 1 }],
  );
});

test("prepare snapshots the exact approved arguments before waiting and cannot redirect a retained lease", async (t) => {
  const driver = new FakeDriver();
  const host = new ComputerUse(driver);
  const run = host.newRun(true);
  t.after(async () => {
    host.locks.releaseOwner("holder");
    await run.close();
    await host.close();
  });
  const catalog = run
    .tools()
    .find((tool) => tool.name === "computer_use_tools")!;
  await catalog.execute("catalog", { group: "core" });
  const dispatch = run
    .tools()
    .find((tool) => tool.name === "computer_use_call")!;
  await host.locks.acquireTarget("holder", target);
  const parameters: Record<string, unknown> = {
    tool: "get_window_state",
    target: structuredClone(target),
    arguments: { max_elements: 5 },
  };
  let waited = false;
  const prepared = run.prepare(
    { id: "waiting", name: "computer_use_call", arguments: parameters },
    new AbortController().signal,
    (reason) => {
      if (reason) waited = true;
    },
  );
  await until(() => waited);
  parameters.target = { ...target, windowId: 2 };
  parameters.arguments = { max_elements: 10 };
  host.locks.releaseOwner("holder");
  await prepared;
  assert.equal(host.locks.getTarget(run.id)?.windowId, "1");
  await assert.rejects(
    dispatch.execute("waiting", parameters),
    /审批|准备|参数|占用/,
  );
  assert.equal(
    driver.calls.some((call) => call.name === "get_window_state"),
    false,
  );
});
