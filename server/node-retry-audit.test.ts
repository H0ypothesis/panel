import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Runtime } from "./runtime.ts";
import { NodeMutationConflict, Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type StoredWorkspace } from "./store.ts";

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for tool cancellation");
}

test("cancelling a file tool during safety review retains proof that no file effect was dispatched", async (t) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-retry-audit-")),
  );
  const project = join(directory, "project");
  await mkdir(project);
  const store = new Store(join(directory, "data"));
  await store.init(false);
  const workspace = createWorkspace("Retry audit", "Parent context");
  workspace.workingDirectory = project;
  workspace.approvalMode = "auto";
  workspace.safetyModel = "test/retry-audit";
  store.data.workspaces.push(workspace);
  let runs = 0;
  const runtime: Runtime = {
    models: () => [
      {
        id: "test/retry-audit",
        name: "Audit",
        provider: "test",
        providerName: "Test",
        available: true,
        demo: false,
        thinkingLevels: ["off"],
        contextWindow: 128_000,
      },
    ],
    reviewTool: async (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("Review cancelled")),
          { once: true },
        );
      }),
    async run(_config, _history, _prompt, _signal, _onText, environment) {
      runs++;
      if (runs === 1) {
        assert.ok(environment);
        await environment.beforeToolCall({
          id: "unexecuted-write",
          name: "write",
          arguments: { path: "never.txt", content: "never" },
        });
        assert.fail(
          "A cancelled safety review must not authorize a file operation",
        );
      }
      return { response: "Retry without previous pending tool", messages: [] };
    },
  };
  const scheduler = new Scheduler(store, runtime);
  t.after(async () => {
    scheduler.shutdown();
    await delay(30);
    await rm(directory, { recursive: true, force: true });
  });
  const node = await scheduler.submit(workspace.id, {
    parentId: workspace.nodes[0].id,
    prompt: "Original request",
    config: { model: "test/retry-audit", thinking: "off" },
    requestId: randomUUID(),
  });
  await until(() => node.toolCalls?.[0]?.status === "reviewing");
  await scheduler.cancel(workspace.id, node.id);
  await delay(30);
  assert.equal(node.toolCalls?.[0]?.fileSnapshot, "unchanged");
  assert.equal(node.toolCalls?.[0]?.authorization, undefined);
  const retried = await scheduler.retry(workspace.id, node.id, {
    requestId: randomUUID(),
    expectedRevision: 0,
  });
  await until(() => retried.status === "completed");
  assert.equal(runs, 2);
  assert.equal(retried.previousRuns?.[0].toolCalls?.[0]?.status, "cancelled");
  assert.equal(retried.id, node.id);

  // A retry with an unavailable historical directory must report a conflict,
  // not silently bind to a different project selected on the workspace.
  retried.status = "failed";
  await delay(30);
  await rm(project, { recursive: true });
  await assert.rejects(
    scheduler.retry(workspace.id, retried.id, {
      requestId: randomUUID(),
      expectedRevision: 1,
    }),
    (error: unknown) =>
      error instanceof NodeMutationConflict && /原工作目录/.test(error.message),
  );
  assert.equal(runs, 2);
});

async function restoreReservationFixture(t: TestContext) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-retry-lock-")),
  );
  const project = join(directory, "project");
  await mkdir(project);
  const path = join(project, "shared.txt");
  await writeFile(path, "before");
  const store = new Store(join(directory, "data"));
  await store.init(false);
  const workspace: StoredWorkspace = createWorkspace(
    "Failed card",
    "Original project",
  );
  const other: StoredWorkspace = createWorkspace(
    "Other workspace",
    "Same project",
  );
  for (const item of [workspace, other]) {
    item.workingDirectory = project;
    item.approvalMode = "auto";
    item.safetyModel = "test/retry-lock";
    store.data.workspaces.push(item);
  }
  let runs = 0;
  const runtime: Runtime = {
    models: () => [
      {
        id: "test/retry-lock",
        name: "Lock",
        provider: "test",
        providerName: "Test",
        available: true,
        demo: false,
        thinkingLevels: ["off"],
        contextWindow: 128_000,
      },
    ],
    reviewTool: async () => ({
      decision: "approve",
      reason: "Fixture approval",
    }),
    async run(_config, _history, _prompt, _signal, _onText, environment) {
      runs++;
      if (runs === 1) {
        assert.ok(environment);
        const call = {
          id: "partial-write",
          name: "write",
          arguments: { path: "shared.txt", content: "partial" },
        };
        assert.equal(await environment.beforeToolCall(call), true);
        await environment.executeTool(call, () => writeFile(path, "partial"));
        environment.onToolUpdate(call.id, { status: "completed" });
        throw new Error("First run failed after writing");
      }
      assert.equal(await readFile(path, "utf8"), "before");
      return {
        response: "Original card retried after restoring",
        messages: [],
      };
    },
  };
  const scheduler = new Scheduler(store, runtime);
  t.after(async () => {
    scheduler.shutdown();
    await delay(30);
    await rm(directory, { recursive: true, force: true });
  });
  const config = { model: "test/retry-lock", thinking: "off" as const };
  const node = await scheduler.submit(workspace.id, {
    parentId: workspace.nodes[0].id,
    prompt: "Original request",
    config,
    requestId: randomUUID(),
  });
  await until(() => node.status === "failed");
  await store.save();
  await delay(20);
  const requestId = randomUUID();
  return {
    path,
    store,
    workspace,
    other,
    scheduler,
    node,
    runs: () => runs,
    retry: () =>
      scheduler.retry(workspace.id, node.id, {
        requestId,
        expectedRevision: 0,
      }),
    submitOther: () =>
      scheduler.submit(other.id, {
        parentId: other.nodes[0].id,
        prompt: "Concurrent request",
        config,
        requestId: randomUUID(),
      }),
  };
}

test("a durable pending restore blocks another workspace's new job without stranding the original retry", async (t) => {
  const e = await restoreReservationFixture(t);
  const applyRestore = e.store.gitSnapshots.applyRestore.bind(
    e.store.gitSnapshots,
  );
  e.store.gitSnapshots.applyRestore = async () => {
    throw new Error("Pause durable restore");
  };
  try {
    await assert.rejects(e.retry(), /Pause durable restore/);
  } finally {
    e.store.gitSnapshots.applyRestore = applyRestore;
  }
  assert.equal(e.workspace.pendingNodeRetry?.status, "failed");
  await assert.rejects(
    e.submitOther(),
    (error: unknown) =>
      error instanceof NodeMutationConflict && /回溯|重试/.test(error.message),
  );
  assert.equal(e.other.nodes.length, 1);
  assert.equal(e.runs(), 1);
  assert.equal(await readFile(e.path, "utf8"), "partial");
  const retried = await e.retry();
  await until(() => retried.status === "completed");
  assert.equal(retried.id, e.node.id);
  assert.equal(e.runs(), 2);
  assert.equal(e.workspace.pendingNodeRetry, undefined);
  assert.equal(await readFile(e.path, "utf8"), "before");
});

test("the restore reservation excludes cross-workspace submissions while Git preparation is still pending", async (t) => {
  const e = await restoreReservationFixture(t);
  const prepareRestore = e.store.gitSnapshots.prepareRestore.bind(
    e.store.gitSnapshots,
  );
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  e.store.gitSnapshots.prepareRestore = async (...args) => {
    entered();
    await gate;
    return prepareRestore(...args);
  };
  const pending = e.retry();
  try {
    await started;
    assert.equal(e.workspace.pendingNodeRetry, undefined);
    await assert.rejects(
      e.submitOther(),
      (error: unknown) =>
        error instanceof NodeMutationConflict &&
        /回溯|重试/.test(error.message),
    );
    assert.equal(e.other.nodes.length, 1);
    assert.equal(e.runs(), 1);
    assert.equal(await readFile(e.path, "utf8"), "partial");
  } finally {
    release();
    e.store.gitSnapshots.prepareRestore = prepareRestore;
  }
  const retried = await pending;
  await until(() => retried.status === "completed");
  assert.equal(retried.id, e.node.id);
  assert.equal(e.runs(), 2);
  assert.equal(e.workspace.pendingNodeRetry, undefined);
  assert.equal(await readFile(e.path, "utf8"), "before");
});
