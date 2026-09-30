import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { RunConfig } from "../shared/types.ts";
import { createApi } from "./api.ts";
import type { Runtime } from "./runtime.ts";
import { NodeMutationConflict, Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type StoredNode } from "./store.ts";
import { importWorkspace } from "./workspace-import.ts";

const baseConfig: RunConfig = { model: "test/long-task", thinking: "off" };
const config = (longTask?: boolean): RunConfig => ({
  ...baseConfig,
  ...(longTask === undefined ? {} : { longTask }),
});

async function until(check: () => boolean) {
  for (let count = 0; count < 400; count++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Timed out waiting for long-task configuration flow");
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
  const directory = await mkdtemp(join(tmpdir(), "panel-long-task-config-"));
  const store = new Store(directory);
  await store.init(false);
  const workspace = createWorkspace("Long tasks", "Context");
  store.data.workspaces.push(workspace);
  const calls: RunConfig[] = [];
  let failNext = false;
  const runtime: Runtime = {
    models: () => [
      {
        id: baseConfig.model,
        name: "Long-task configuration test",
        provider: "test",
        providerName: "Test",
        available: true,
        demo: false,
        thinkingLevels: ["off"],
        contextWindow: 128000,
      },
    ],
    async run(runConfig, _history, _prompt, signal) {
      signal.throwIfAborted();
      calls.push(structuredClone(runConfig));
      if (failNext) {
        failNext = false;
        throw new Error("Simulated failed long task");
      }
      return {
        response: "Completed",
        messages: [fauxAssistantMessage("Completed")],
      };
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
    return { status, body: JSON.parse(output) };
  };
  const input = (longTask?: boolean) => ({
    parentId: workspace.nodes[0].id,
    prompt: "Complete this task",
    config: config(longTask),
    requestId: randomUUID(),
  });
  const submit = async (longTask?: boolean) => {
    const node = await scheduler.submit(workspace.id, input(longTask));
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
    scheduler,
    calls,
    request,
    input,
    submit,
    failNext: () => {
      failNext = true;
    },
  };
}

test("API, snapshots, disk reload, and JSON export/import retain explicit true and false and legacy omission", async (t) => {
  const env = await fixture(t);
  const capability = await env.request("GET", "/capabilities");
  assert.equal(capability.body.longTasks, true);
  const created: StoredNode[] = [];
  for (const value of [true, false, undefined]) {
    const result = await env.request(
      "POST",
      `/workspaces/${env.workspace.id}/nodes`,
      env.input(value),
    );
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const node = env.workspace.nodes.find(
      (item) => item.id === result.body.nodeId,
    )!;
    await until(() => node.status === "completed");
    created.push(node);
    assert.equal(node.config.longTask, value);
    assert.equal(env.calls.at(-1)!.longTask, value);
    assert.equal(
      env.store
        .snapshot()
        .workspaces[0].nodes.find((item) => item.id === node.id)!.config
        .longTask,
      value,
    );
  }
  await env.store.save();
  const reloaded = new Store(env.directory);
  await reloaded.init(false);
  assert.deepEqual(
    reloaded
      .workspace(env.workspace.id)
      .nodes.slice(1)
      .map((node) => node.config),
    created.map((node) => node.config),
  );
  const exported = await env.request(
    "GET",
    `/workspaces/${env.workspace.id}/export`,
  );
  assert.equal(exported.status, 200);
  const imported = importWorkspace(exported.body);
  assert.deepEqual(
    imported.nodes.slice(1).map((node) => node.config),
    created.map((node) => node.config),
  );
  assert.equal(Object.hasOwn(imported.nodes.at(-1)!.config, "longTask"), false);
});

test("create and regenerate reject non-boolean longTask before scheduling, including direct Scheduler callers", async (t) => {
  const env = await fixture(t);
  const node = await env.submit(true);
  const path = `/workspaces/${env.workspace.id}/nodes`;
  const count = env.calls.length;
  for (const longTask of [null, "true", "false", 0, 1, {}, []]) {
    const invalid = { ...env.input(), config: { ...baseConfig, longTask } };
    const create = await env.request("POST", path, invalid);
    assert.equal(create.status, 400);
    assert.match(create.body.error, /长程任务.*布尔/);
    const edit = await env.request("POST", `${path}/${node.id}/regenerate`, {
      ...invalid,
      expectedRevision: 0,
    });
    assert.equal(edit.status, 400);
    assert.match(edit.body.error, /长程任务.*布尔/);
    await assert.rejects(
      env.scheduler.submit(
        env.workspace.id,
        invalid as ReturnType<typeof env.input>,
      ),
      /长程任务.*布尔/,
    );
    await assert.rejects(
      env.scheduler.regenerate(env.workspace.id, node.id, {
        ...invalid,
        expectedRevision: 0,
      } as unknown as Parameters<Scheduler["regenerate"]>[2]),
      /长程任务.*布尔/,
    );
  }
  assert.equal(env.calls.length, count);
  assert.equal(env.workspace.nodes.length, 2);
  assert.equal(node.config.longTask, true);
  assert.equal(node.revision ?? 0, 0);
});

test("request-id equality distinguishes enabled long tasks while treating omitted and false as the same legacy mode", async (t) => {
  const env = await fixture(t);
  for (const value of [true, false, undefined]) {
    const input = env.input(value);
    const node = await env.scheduler.submit(env.workspace.id, input);
    const equivalent = {
      ...input,
      config: config(
        value === true ? true : value === false ? undefined : false,
      ),
    };
    assert.equal(
      (await env.scheduler.submit(env.workspace.id, equivalent)).id,
      node.id,
    );
    await assert.rejects(
      env.scheduler.submit(env.workspace.id, {
        ...input,
        config: config(value !== true),
      }),
      /请求 ID/,
    );
    await until(() => node.status === "completed");
  }
  assert.equal(env.calls.length, 3);
});

test("editing can retain, disable, and re-enable long tasks while preserving each archived configuration", async (t) => {
  const env = await fixture(t);
  let node = await env.submit(true);
  const expected = [true];
  for (const longTask of [true, false, true]) {
    const input = {
      prompt: "Edited task",
      config: config(longTask),
      requestId: randomUUID(),
      expectedRevision: node.revision ?? 0,
    };
    node = await settled(() =>
      env.scheduler.regenerate(env.workspace.id, node.id, input),
    );
    await until(() => node.status === "completed");
    assert.equal(node.config.longTask, longTask);
    assert.equal(env.calls.at(-1)!.longTask, longTask);
    assert.deepEqual(
      node.previousRuns!.map((run) => run.config.longTask),
      expected,
    );
    assert.equal(
      (await env.scheduler.regenerate(env.workspace.id, node.id, input))
        .revision,
      node.revision,
    );
    await assert.rejects(
      env.scheduler.regenerate(env.workspace.id, node.id, {
        ...input,
        config: config(!longTask),
      }),
      /请求 ID/,
    );
    expected.push(longTask);
  }
  const exported = await env.request(
    "GET",
    `/workspaces/${env.workspace.id}/export`,
  );
  const imported = importWorkspace(exported.body).nodes.find(
    (item) => item.prompt === "Edited task",
  )!;
  assert.equal(imported.config.longTask, true);
  assert.deepEqual(
    imported.previousRuns!.map((run) => run.config.longTask),
    [true, true, false],
  );
});

test("retry preserves true, false, or omitted configuration in the new execution and archived failed run", async (t) => {
  const env = await fixture(t);
  for (const longTask of [true, false, undefined]) {
    env.failNext();
    const node = await env.submit(longTask);
    assert.equal(node.status, "failed");
    const input = { requestId: randomUUID(), expectedRevision: 0 };
    const retried = await settled(() =>
      env.scheduler.retry(env.workspace.id, node.id, input),
    );
    await until(() => retried.status === "completed");
    assert.equal(retried.config.longTask, longTask);
    assert.equal(retried.previousRuns![0].config.longTask, longTask);
    assert.equal(env.calls.at(-1)!.longTask, longTask);
    assert.equal(
      (await env.scheduler.retry(env.workspace.id, node.id, input)).revision,
      1,
    );
  }
  env.failNext();
  const corrupted = await env.submit(true);
  corrupted.config.longTask = "true" as unknown as boolean;
  const before = env.calls.length;
  await assert.rejects(
    settled(() =>
      env.scheduler.retry(env.workspace.id, corrupted.id, {
        requestId: randomUUID(),
        expectedRevision: 0,
      }),
    ),
    /长程任务.*布尔/,
  );
  assert.equal(env.calls.length, before);
});

test("import rejects invalid long-task flags in current and archived configurations", () => {
  for (const archived of [false, true]) {
    for (const longTask of [null, "true", "false", 0, 1, {}, []]) {
      const workspace = createWorkspace("Invalid long-task export", "Context");
      const root = workspace.nodes[0] as StoredNode;
      if (archived)
        root.previousRuns = [
          { ...structuredClone(root), archivedAt: Date.now() },
        ];
      const run = archived ? root.previousRuns![0] : root;
      run.config.longTask = longTask as boolean;
      assert.throws(
        () => importWorkspace({ version: 1, workspace }),
        /长程任务/,
      );
    }
  }
});
