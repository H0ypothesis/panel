import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ModelOption, RunConfig, ToolCall } from "../shared/types.ts";
import { CuaLocks } from "./cua-locks.ts";
import type { RunEnvironment, Runtime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store } from "./store.ts";
import { ToolAuthorizationRegistry } from "./tool-authorization.ts";

const config: RunConfig = { model: "test/cua-scheduler", thinking: "off" };
const model: ModelOption = {
  id: config.model,
  name: "Computer use scheduling test",
  provider: "test",
  providerName: "Test",
  available: true,
  demo: false,
  thinkingLevels: ["off"],
  contextWindow: 128000,
};
const target = { kind: "window" as const, pid: 100, windowId: 1 };
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("Timed out waiting for CUA scheduler state");
}

async function fixture(t: TestContext, approvalMode: "auto" | "ask" = "auto") {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-cua-scheduler-")),
  );
  const project = join(directory, "project");
  await mkdir(project);
  const store = new Store(join(directory, "state"));
  await store.init(false);
  const workspace = createWorkspace("Computer use", "Scheduling test");
  workspace.workingDirectory = project;
  workspace.approvalMode = approvalMode;
  workspace.safetyModel = config.model;
  store.data.workspaces.push(workspace);
  const started = gate<{ execution: RunEnvironment; signal: AbortSignal }>();
  const finish = gate<void>();
  const locks = new CuaLocks();
  const reviews: unknown[] = [];
  let onReview: (() => void) | undefined;
  const runtime: Runtime = {
    models: () => [model],
    reviewTool: async (request) => {
      onReview?.();
      reviews.push(request);
      return { decision: "approve", reason: "Test approval" };
    },
    async run(_config, _history, _prompt, signal, _onText, execution) {
      assert.ok(execution);
      started.resolve({ execution, signal });
      signal.addEventListener("abort", () => finish.resolve(), { once: true });
      await finish.promise;
      signal.throwIfAborted();
      return { messages: [], response: "Finished" };
    },
  };
  const scheduler = new Scheduler(store, runtime);
  let now = Date.now();
  // The scheduler has no public clock dependency. Replace only its registry so
  // a minute-long target wait can be tested without a minute-long test sleep.
  (
    scheduler as unknown as { authorizations: ToolAuthorizationRegistry }
  ).authorizations = new ToolAuthorizationRegistry(() => now, 30_000);
  const pending: Promise<unknown>[] = [];
  t.after(async () => {
    scheduler.shutdown();
    locks.releaseOwner("occupant");
    locks.releaseOwner("waiting-run");
    finish.resolve();
    await Promise.allSettled(pending);
    await delay(10);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  });
  const node = await scheduler.submit(workspace.id, {
    parentId: workspace.nodes[0].id,
    prompt: "Use the requested application",
    config,
    requestId: randomUUID(),
  });
  const { execution, signal } = await started.promise;
  const call: Pick<ToolCall, "id" | "name" | "arguments"> = {
    id: randomUUID(),
    name: "computer_use_call",
    arguments: { tool: "get_window_state", target },
  };
  function track<T>(promise: Promise<T>): Promise<T> {
    pending.push(promise);
    void promise.catch(() => {});
    return promise;
  }
  return {
    store,
    workspace,
    scheduler,
    node,
    execution,
    signal,
    call,
    locks,
    reviews,
    track,
    setTime: (value: number) => {
      now = value;
    },
    setReviewCheck: (check: () => void) => {
      onReview = check;
    },
  };
}

test("target acquisition precedes review and token issuance even after more than the token TTL", async (t) => {
  const env = await fixture(t);
  const queuedAt = Date.now() - 60_000;
  env.setTime(queuedAt);
  await env.locks.acquireTarget("occupant", target);
  let prepared = false;
  env.setReviewCheck(() => assert.equal(prepared, true));
  const approval = env.track(
    env.execution.beforeToolCall(env.call, async (onWait) => {
      await env.locks.acquireTarget("waiting-run", target, env.signal, onWait);
      prepared = true;
    }),
  );
  await until(() => Boolean(env.node.toolCalls?.[0]?.waitingFor));
  assert.equal(env.node.toolCalls![0].authorization, undefined);
  assert.equal(env.reviews.length, 0);
  const acquiredAt = Date.now();
  env.setTime(acquiredAt);
  env.locks.releaseOwner("occupant");
  assert.equal(await approval, true);
  const call = env.node.toolCalls![0];
  assert.equal(call.waitingFor, undefined);
  assert.ok(acquiredAt - queuedAt >= 60_000);
  assert.equal(call.authorization?.issuedAt, acquiredAt);
  assert.equal(call.authorization?.expiresAt, acquiredAt + 30_000);
  assert.equal(env.reviews.length, 1);
  let executed = false;
  await env.execution.executeTool(env.call, async () => {
    executed = true;
  });
  assert.equal(executed, true);
  assert.equal(call.authorization?.consumedAt, acquiredAt);
});

test("canceling while waiting for a desktop target never issues authorization or reviews the action", async (t) => {
  const env = await fixture(t);
  await env.locks.acquireTarget("occupant", target);
  const approval = env.track(
    env.execution.beforeToolCall(env.call, async (onWait) => {
      await env.locks.acquireTarget("waiting-run", target, env.signal, onWait);
    }),
  );
  const rejected = assert.rejects(approval);
  await until(() => Boolean(env.node.toolCalls?.[0]?.waitingFor));
  await env.scheduler.cancel(env.workspace.id, env.node.id);
  await rejected;
  assert.equal(env.node.toolCalls![0].authorization, undefined);
  assert.equal(env.node.toolCalls![0].waitingFor, undefined);
  assert.equal(env.reviews.length, 0);
  env.locks.releaseOwner("occupant");
  assert.equal(env.locks.getTarget("waiting-run"), undefined);
  let executed = false;
  await assert.rejects(
    env.execution.executeTool(env.call, async () => {
      executed = true;
    }),
  );
  assert.equal(executed, false);
});

test("failed target preparation creates no reusable authorization", async (t) => {
  const env = await fixture(t);
  await assert.rejects(
    env.execution.beforeToolCall(env.call, async () => {
      throw new Error("target no longer exists");
    }),
    /target no longer exists/,
  );
  assert.equal(env.node.toolCalls![0].authorization, undefined);
  assert.equal(env.reviews.length, 0);
  let executed = false;
  await assert.rejects(
    env.execution.executeTool(env.call, async () => {
      executed = true;
    }),
  );
  assert.equal(executed, false);
});

test("desktop tools reject blanket approval server-side and keep single-action approval usable", async (t) => {
  const env = await fixture(t, "ask");
  const approval = env.track(
    env.execution.beforeToolCall(env.call, async () => {}),
  );
  await until(() => env.node.toolCalls?.[0]?.status === "awaiting_approval");
  await assert.rejects(
    env.scheduler.approve(
      env.workspace.id,
      env.node.id,
      env.call.id,
      "approve_tool",
    ),
    /桌面|电脑|单次|批量|逐次/,
  );
  const call = env.node.toolCalls![0];
  assert.equal(call.authorization, undefined);
  assert.equal(call.status, "awaiting_approval");
  await env.scheduler.approve(
    env.workspace.id,
    env.node.id,
    env.call.id,
    "approve",
  );
  assert.equal(await approval, true);
  assert.equal(call.approval, "approved");
  assert.ok(call.authorization);
  let executed = false;
  await env.execution.executeTool(env.call, async () => {
    executed = true;
  });
  assert.equal(executed, true);
  const later = { ...env.call, id: randomUUID() };
  const laterApproval = env.track(
    env.execution.beforeToolCall(later, async () => {}),
  );
  await until(() => env.node.toolCalls?.[1]?.status === "awaiting_approval");
  assert.equal(env.node.toolCalls![1].authorization, undefined);
  await env.scheduler.approve(env.workspace.id, env.node.id, later.id, "deny");
  assert.equal(await laterApproval, false);
});
