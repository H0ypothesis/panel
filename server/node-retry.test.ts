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
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Message } from "@earendil-works/pi-ai";
import type { ModelOption, RunConfig } from "../shared/types.ts";
import { createApi } from "./api.ts";
import { createPanelTools } from "./coding-tools.ts";
import type { RunEnvironment, Runtime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type StoredNode, type StoredWorkspace } from "./store.ts";

const config: RunConfig = { model: "test/retry", thinking: "off" };
const model: ModelOption = {
  id: config.model,
  name: "Retry test",
  provider: "test",
  providerName: "Test",
  available: true,
  demo: false,
  thinkingLevels: ["off"],
  contextWindow: 128_000,
};

async function until(check: () => boolean) {
  for (let i = 0; i < 600; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for retry state");
}

async function fixture(t: TestContext) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-node-retry-")),
  );
  const project = join(directory, "project");
  const data = join(directory, "data");
  await mkdir(project);
  const store = new Store(data);
  await store.init(false);
  const workspace: StoredWorkspace = createWorkspace("Retry", "Parent context");
  workspace.workingDirectory = project;
  workspace.approvalMode = "auto";
  workspace.safetyModel = config.model;
  store.data.workspaces.push(workspace);
  const runs: Array<{
    environment: RunEnvironment;
    history: Message[];
    prompt: string;
    config: RunConfig;
    signal: AbortSignal;
    release: (failure?: string) => void;
  }> = [];
  const runtime: Runtime = {
    models: () => [model],
    reviewTool: async () => ({ decision: "approve", reason: "Test approval" }),
    async run(runConfig, history, prompt, signal, _onText, environment) {
      assert.ok(environment);
      let release!: (failure?: string) => void;
      const completion = new Promise<string | undefined>((resolve) => {
        release = resolve;
      });
      runs.push({
        environment,
        history: structuredClone(history),
        prompt,
        config: runConfig,
        signal,
        release,
      });
      const failure = await completion;
      signal.throwIfAborted();
      if (failure) throw new Error(failure);
      return { response: "Retried successfully", messages: [] };
    },
  };
  const scheduler = new Scheduler(store, runtime);
  const submit = async () => {
    const count = runs.length;
    const node = await scheduler.submit(workspace.id, {
      parentId: workspace.nodes[0].id,
      prompt: "Original question",
      config,
      requestId: randomUUID(),
    });
    await until(() => runs.length === count + 1);
    return node;
  };
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const run = runs.at(-1)!;
    const id = randomUUID();
    const input = { id, name, arguments: args };
    assert.equal(await run.environment.beforeToolCall(input), true);
    const tool = createPanelTools(run.environment.workingDirectory!).find(
      (item) => item.name === name,
    )!;
    try {
      const result = await run.environment.executeTool(input, () =>
        tool.execute(id, args, run.signal),
      );
      run.environment.onToolUpdate(id, { status: "completed" });
      return result;
    } catch (error) {
      run.environment.onToolUpdate(id, {
        status: "failed",
        error: String(error),
      });
      throw error;
    }
  };
  const finish = async (node: StoredNode, failure?: string) => {
    runs.at(-1)!.release(failure);
    await until(() => node.status !== "running" && node.status !== "queued");
    await store.save();
    await delay(20);
  };
  const retry = (node: StoredNode, requestId = randomUUID()) =>
    scheduler.retry(workspace.id, node.id, {
      expectedRevision: node.revision ?? 0,
      requestId,
    });
  const call = async (nodeId: string, body: unknown, origin?: string) => {
    const api = createApi(store, runtime, scheduler);
    const request = Readable.from([
      Buffer.from(JSON.stringify(body)),
    ]) as IncomingMessage;
    Object.assign(request, {
      method: "POST",
      url: `/api/workspaces/${workspace.id}/nodes/${nodeId}/retry`,
      headers: {
        host: "127.0.0.1:9999",
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
    });
    let status = 0;
    let output = "";
    const response = {
      setHeader() {},
      writeHead(value: number) {
        status = value;
      },
      end(value: string) {
        output = value;
      },
    } as unknown as ServerResponse;
    await api(request, response);
    return { status, body: JSON.parse(output) };
  };
  t.after(async () => {
    scheduler.shutdown();
    for (const run of runs) run.release();
    await delay(30);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    project,
    data,
    store,
    workspace,
    runtime,
    scheduler,
    runs,
    submit,
    invoke,
    finish,
    retry,
    call,
  };
}

test("retry restores this run's additions, edits and deletions before regenerating the same card", async (t) => {
  const e = await fixture(t);
  await writeFile(join(e.project, "original.txt"), "before\n");
  await writeFile(join(e.project, "deleted.txt"), "restore me\n");
  const node = await e.submit();
  await e.invoke("write", { path: "original.txt", content: "first update\n" });
  await e.invoke("edit", {
    path: "original.txt",
    edits: [{ oldText: "first update", newText: "second update" }],
  });
  await e.invoke("write", {
    path: "new.txt",
    content: "created by failed run",
  });
  await e.invoke("bash", { command: "rm deleted.txt" });
  await e.finish(node, "Original model failure");
  await writeFile(
    join(e.project, "unrelated.txt"),
    "keep later independent changes",
  );
  const priorHistory = e.workspace.gitHistory!.length;
  const next = await e.retry(node);
  await until(() => e.runs.length === 2);
  assert.equal(
    await readFile(join(e.project, "original.txt"), "utf8"),
    "before\n",
  );
  assert.equal(
    await readFile(join(e.project, "deleted.txt"), "utf8"),
    "restore me\n",
  );
  await assert.rejects(readFile(join(e.project, "new.txt")), {
    code: "ENOENT",
  });
  assert.equal(
    await readFile(join(e.project, "unrelated.txt"), "utf8"),
    "keep later independent changes",
  );
  assert.equal(next.id, node.id);
  assert.equal(next.parentId, node.parentId);
  assert.deepEqual(next.position, node.position);
  assert.deepEqual(next.config, node.config);
  assert.equal(next.prompt, node.prompt);
  assert.equal(next.revision, 1);
  assert.equal(e.workspace.nodes.length, 2);
  assert.equal(next.previousRuns?.[0].error, "Original model failure");
  assert.equal(next.response, "");
  assert.doesNotMatch(
    JSON.stringify(e.runs[1].history),
    /Original model failure|second update/,
  );
  assert.ok(e.workspace.gitHistory!.length >= priorHistory);
  await e.finish(next);
});

test("cancelled cards roll back already written files before in-place retry", async (t) => {
  const e = await fixture(t);
  const node = await e.submit();
  await e.invoke("write", { path: "cancelled.txt", content: "partial effect" });
  await e.scheduler.cancel(e.workspace.id, node.id);
  await e.finish(node);
  assert.equal(node.status, "cancelled");
  const next = await e.retry(node);
  await until(() => e.runs.length === 2);
  await assert.rejects(readFile(join(e.project, "cancelled.txt")), {
    code: "ENOENT",
  });
  assert.equal(next.id, node.id);
  await e.finish(next);
});

test("text-only failures and verified no-op file operations can retry without snapshots", async (t) => {
  const e = await fixture(t);
  await writeFile(join(e.project, "same.txt"), "same");
  const node = await e.submit();
  await e.finish(node, "text failure");
  const second = await e.retry(node);
  await until(() => e.runs.length === 2);
  await e.invoke("write", { path: "same.txt", content: "same" });
  await e.invoke("bash", { command: "pwd" });
  await e.finish(second, "later text failure");
  assert.deepEqual(e.workspace.gitHistory ?? [], []);
  const third = await e.retry(second);
  await until(() => e.runs.length === 3);
  assert.equal(third.revision, 2);
  assert.equal(await readFile(join(e.project, "same.txt"), "utf8"), "same");
  await e.finish(third);
});

test("conflicting later edits prevent all rollback effects and do not launch a model", async (t) => {
  const e = await fixture(t);
  await writeFile(join(e.project, "a.txt"), "before a");
  await writeFile(join(e.project, "b.txt"), "before b");
  const node = await e.submit();
  await e.invoke("write", { path: "a.txt", content: "agent a" });
  await e.invoke("write", { path: "b.txt", content: "agent b" });
  await e.finish(node, "failed");
  await writeFile(join(e.project, "b.txt"), "later manual change");
  await assert.rejects(e.retry(node), /冲突|后续|改变|变化|修改/);
  assert.equal(await readFile(join(e.project, "a.txt"), "utf8"), "agent a");
  assert.equal(
    await readFile(join(e.project, "b.txt"), "utf8"),
    "later manual change",
  );
  assert.equal(e.runs.length, 1);
  assert.equal(
    e.workspace.nodes.find((item) => item.id === node.id)?.revision ?? 0,
    0,
  );
});

test("retry restores only the current revision, retaining earlier revisions' file results", async (t) => {
  const e = await fixture(t);
  await writeFile(join(e.project, "revision.txt"), "initial");
  const first = await e.submit();
  await e.invoke("write", {
    path: "revision.txt",
    content: "first revision result",
  });
  await e.finish(first);
  const second = await e.scheduler.regenerate(e.workspace.id, first.id, {
    prompt: first.prompt,
    config,
    expectedRevision: 0,
    requestId: randomUUID(),
  });
  await until(() => e.runs.length === 2);
  await e.invoke("write", {
    path: "revision.txt",
    content: "second revision partial",
  });
  await e.finish(second, "failed");
  const third = await e.retry(second);
  await until(() => e.runs.length === 3);
  assert.equal(
    await readFile(join(e.project, "revision.txt"), "utf8"),
    "first revision result",
  );
  assert.equal(third.revision, 2);
  assert.equal(third.previousRuns?.length, 2);
  await e.finish(third);
});

test("retry uses the card's original working directory after the workspace is rebound", async (t) => {
  const e = await fixture(t);
  const other = join(e.directory, "other");
  await mkdir(other);
  await writeFile(join(other, "file.txt"), "other project");
  const node = await e.submit();
  await e.invoke("write", { path: "file.txt", content: "old project partial" });
  await e.finish(node, "failed");
  await e.scheduler.configureWorkspace(e.workspace.id, {
    workingDirectory: other,
  });
  const next = await e.retry(node);
  await until(() => e.runs.length === 2);
  assert.equal(next.execution?.workingDirectory, e.project);
  await assert.rejects(readFile(join(e.project, "file.txt")), {
    code: "ENOENT",
  });
  await e.invoke("write", {
    path: "retry.txt",
    content: "still original project",
  });
  assert.equal(
    await readFile(join(e.project, "retry.txt"), "utf8"),
    "still original project",
  );
  assert.equal(
    await readFile(join(other, "file.txt"), "utf8"),
    "other project",
  );
  await assert.rejects(readFile(join(other, "retry.txt")), { code: "ENOENT" });
  await e.finish(next);
});

test("duplicate retry requests run once and cannot be reused as ordinary regeneration", async (t) => {
  const e = await fixture(t);
  const node = await e.submit();
  await e.finish(node, "failed");
  const requestId = randomUUID();
  const [first, duplicate] = await Promise.all([
    e.retry(node, requestId),
    e.retry(node, requestId),
  ]);
  assert.equal(first, duplicate);
  await until(() => e.runs.length === 2);
  await assert.rejects(e.retry(node), /版本|修改/);
  await assert.rejects(
    e.scheduler.regenerate(e.workspace.id, node.id, {
      prompt: node.prompt,
      config,
      requestId,
      expectedRevision: 0,
    }),
    /请求 ID|其他/,
  );
  assert.equal(e.runs.length, 2);
  await e.finish(first);
  const repeated = await e.retry(node, requestId);
  assert.equal(repeated.id, node.id);
  assert.equal(e.runs.length, 2);
});

test("missing and failed snapshots block retry instead of silently rerunning a partial mutation", async (t) => {
  const e = await fixture(t);
  const node = await e.submit();
  const capture = e.store.gitSnapshots.capture.bind(e.store.gitSnapshots);
  e.store.gitSnapshots.capture = async () => {
    throw new Error("snapshot disk failed");
  };
  await e.invoke("write", { path: "partial.txt", content: "already changed" });
  e.store.gitSnapshots.capture = capture;
  await e.finish(node, "failed");
  await assert.rejects(e.retry(node), /快照|回溯/);
  assert.equal(
    await readFile(join(e.project, "partial.txt"), "utf8"),
    "already changed",
  );
  e.workspace.gitHistory = [];
  for (const call of node.toolCalls ?? []) delete call.fileSnapshot;
  await assert.rejects(e.retry(node), /快照|回溯/);
  assert.equal(e.runs.length, 1);
});

test("failed journal persistence leaves files and the failed card intact", async (t) => {
  const e = await fixture(t);
  const node = await e.submit();
  await e.invoke("write", {
    path: "partial.txt",
    content: "keep until durable",
  });
  await e.finish(node, "failed");
  const save = e.store.save.bind(e.store);
  e.store.save = async () => {
    throw new Error("disk failed");
  };
  try {
    await assert.rejects(e.retry(node), /disk failed/);
  } finally {
    e.store.save = save;
  }
  assert.equal(
    await readFile(join(e.project, "partial.txt"), "utf8"),
    "keep until durable",
  );
  assert.equal(
    e.workspace.nodes.find((item) => item.id === node.id),
    node,
  );
  assert.equal(e.runs.length, 1);
});

test("a save failure after restoring files keeps a durable journal, and restart does not replay the model", async (t) => {
  const e = await fixture(t);
  await writeFile(join(e.project, "original.txt"), "before");
  const node = await e.submit();
  await e.invoke("write", { path: "original.txt", content: "partial" });
  await e.finish(node, "failed");
  const requestId = randomUUID();
  const save = e.store.save.bind(e.store);
  e.store.save = async (options) => {
    if (options && "values" in options && options.values?.nodes)
      throw new Error("final state save failed");
    await save(options);
  };
  try {
    await assert.rejects(e.retry(node, requestId), /final state save failed/);
  } finally {
    e.store.save = save;
  }
  assert.equal(
    await readFile(join(e.project, "original.txt"), "utf8"),
    "before",
  );
  assert.equal(e.runs.length, 1);
  assert.equal(
    e.workspace.nodes.find((item) => item.id === node.id),
    node,
  );
  assert.ok(e.workspace.pendingNodeRetry);
  const restarted = new Store(e.data);
  await restarted.init(false);
  const restoredWorkspace = restarted.workspace(e.workspace.id);
  assert.equal(restoredWorkspace.pendingNodeRetry?.status, "restored");
  assert.equal(
    restoredWorkspace.nodes.find((item) => item.id === node.id)?.status,
    "failed",
  );
  assert.equal(e.runs.length, 1);
  assert.doesNotMatch(
    JSON.stringify(restarted.snapshot()),
    /pendingNodeRetry|\"plan\"|\"repository\"/,
  );
  const scheduler = new Scheduler(restarted, e.runtime);
  t.after(() => scheduler.shutdown());
  const next = await scheduler.retry(e.workspace.id, node.id, {
    expectedRevision: 0,
    requestId,
  });
  await until(() => e.runs.length === 2);
  assert.equal(next.id, node.id);
  assert.equal(next.revision, 1);
  assert.equal(restoredWorkspace.pendingNodeRetry, undefined);
  assert.ok(restoredWorkspace.gitHistory?.every((entry) => entry.restoredAt));
  e.runs.at(-1)!.release();
  await until(() => next.status === "completed");
  await restarted.save();
});

test("restart completes an interrupted file restoration without rerunning any old tool", async (t) => {
  const e = await fixture(t);
  await writeFile(join(e.project, "original.txt"), "before");
  const node = await e.submit();
  await e.invoke("write", { path: "original.txt", content: "partial" });
  await e.finish(node, "failed");
  const applyRestore = e.store.gitSnapshots.applyRestore.bind(
    e.store.gitSnapshots,
  );
  e.store.gitSnapshots.applyRestore = async () => {
    throw new Error("simulated interrupted restore");
  };
  try {
    await assert.rejects(e.retry(node), /interrupted restore/);
  } finally {
    e.store.gitSnapshots.applyRestore = applyRestore;
  }
  assert.equal(
    await readFile(join(e.project, "original.txt"), "utf8"),
    "partial",
  );
  const restarted = new Store(e.data);
  await restarted.init(false);
  assert.equal(
    await readFile(join(e.project, "original.txt"), "utf8"),
    "before",
  );
  assert.equal(
    restarted.workspace(e.workspace.id).pendingNodeRetry?.status,
    "restored",
  );
  assert.equal(e.runs.length, 1);
});

test("an overlapping workspace run blocks rollback without interrupting that run", async (t) => {
  const e = await fixture(t);
  const node = await e.submit();
  await e.invoke("write", { path: "partial.txt", content: "partial" });
  await e.finish(node, "failed");
  const other = createWorkspace("Another workspace", "Shared project");
  other.workingDirectory = e.project;
  e.store.data.workspaces.push(other);
  const otherNode = await e.scheduler.submit(other.id, {
    parentId: other.nodes[0].id,
    prompt: "Other running task",
    config,
    requestId: randomUUID(),
  });
  await until(() => e.runs.length === 2);
  await assert.rejects(e.retry(node), /目录|运行|排队|占用/);
  assert.equal(
    await readFile(join(e.project, "partial.txt"), "utf8"),
    "partial",
  );
  assert.equal(otherNode.status, "running");
  assert.equal(e.runs.length, 2);
  await e.finish(otherNode);
});

test("retry API validates revisions, origin and state and returns the same node ID", async (t) => {
  const e = await fixture(t);
  const node = await e.submit();
  await e.finish(node, "failed");
  const body = { expectedRevision: 0, requestId: randomUUID() };
  assert.equal(
    (await e.call(node.id, { requestId: randomUUID() })).status,
    400,
  );
  assert.equal(
    (await e.call(node.id, { ...body, expectedRevision: 99 })).status,
    409,
  );
  assert.equal(
    (await e.call(node.id, body, "https://example.com")).status,
    403,
  );
  assert.ok((await e.call(e.workspace.nodes[0].id, body)).status >= 400);
  const result = await e.call(node.id, body);
  assert.equal(result.status, 200);
  assert.equal(result.body.nodeId, node.id);
  assert.equal(result.body.state.workspaces[0].nodes.length, 2);
  assert.doesNotMatch(
    JSON.stringify(result.body),
    /pendingNodeRetry|previousRuns|requestKind/,
  );
  await until(() => e.runs.length === 2);
  await e.finish(e.workspace.nodes.find((item) => item.id === node.id)!);
});
