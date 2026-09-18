import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  appendFile,
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
import type { ModelOption, RunConfig, ToolCall } from "../shared/types.ts";
import type { RunEnvironment, Runtime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store } from "./store.ts";

const config: RunConfig = { model: "test/execution-gate", thinking: "off" };
const model: ModelOption = {
  id: config.model,
  name: "Execution gate test",
  provider: "test",
  providerName: "Test",
  available: true,
  demo: false,
  thinkingLevels: ["off"],
  contextWindow: 128000,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-authorization-execution-")),
  );
  const project = join(directory, "project");
  await mkdir(project);
  const store = new Store(join(directory, "state"));
  await store.init(false);
  const workspace = createWorkspace("Execution authorization", "Test");
  workspace.workingDirectory = project;
  workspace.approvalMode = "auto";
  workspace.safetyModel = config.model;
  store.data.workspaces.push(workspace);
  const started = deferred<RunEnvironment>();
  const finish = deferred<void>();
  const runtime: Runtime = {
    models: () => [model],
    reviewTool: async () => ({ decision: "approve", reason: "Test approval" }),
    async run(_config, _history, _prompt, signal, _onText, environment) {
      assert.ok(environment);
      started.resolve(environment);
      signal.addEventListener("abort", () => finish.resolve(), { once: true });
      await finish.promise;
      signal.throwIfAborted();
      return { messages: [], response: "Finished" };
    },
  };
  const scheduler = new Scheduler(store, runtime);
  const save = store.save.bind(store);
  const releases: Array<() => void> = [];
  t.after(async () => {
    store.save = save;
    for (const release of releases) release();
    scheduler.shutdown();
    finish.resolve();
    // Allow the captured runtime to finish and enqueue the scheduler's last save.
    await delay(0);
    await save();
    await rm(directory, { recursive: true, force: true });
  });
  const node = await scheduler.submit(workspace.id, {
    parentId: workspace.nodes[0].id,
    prompt: "Write the requested file",
    config,
    requestId: randomUUID(),
  });
  const execution = await started.promise;
  const call: Pick<ToolCall, "id" | "name" | "arguments"> = {
    id: "write-1",
    name: "write",
    arguments: { path: "approved.txt", content: "approved" },
  };
  const target = join(project, "approved.txt");
  const write = () => writeFile(target, "approved");
  const absent = () => assert.rejects(readFile(target), { code: "ENOENT" });
  const approve = async () => {
    assert.equal(await execution.beforeToolCall(call), true);
    assert.ok(node.toolCalls?.[0].authorization);
    await absent();
  };
  const holdConsumptionSave = () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    releases.push(() => release.resolve());
    let held = false;
    store.save = async (settings) => {
      if (!settings && node.toolCalls?.[0].authorization?.consumedAt && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return save(settings);
    };
    return { entered: entered.promise, release: () => release.resolve() };
  };
  return {
    directory,
    store,
    workspace,
    scheduler,
    node,
    execution,
    call,
    target,
    write,
    absent,
    approve,
    save,
    holdConsumptionSave,
  };
}

test("final execution gate persists exact authorization consumption before the file effect", async (t) => {
  const env = await fixture(t);
  await env.approve();
  assert.equal(env.node.toolCalls![0].authorization!.consumedAt, undefined);
  await env.execution.executeTool(env.call, async () => {
    const persisted = JSON.parse(
      await readFile(join(env.directory, "state", "state.json"), "utf8"),
    );
    const savedNode = persisted.workspaces[0].nodes.find(
      (node: { id: string }) => node.id === env.node.id,
    );
    assert.ok(savedNode.toolCalls[0].authorization.consumedAt);
    await env.write();
  });
  assert.equal(await readFile(env.target, "utf8"), "approved");
});

test("final execution gate refuses calls without an earlier approval", async (t) => {
  const env = await fixture(t);
  await assert.rejects(env.execution.executeTool(env.call, env.write));
  await env.absent();
});

test("final execution gate refuses arguments changed after safety approval", async (t) => {
  const env = await fixture(t);
  await env.approve();
  await assert.rejects(
    env.execution.executeTool(
      { ...env.call, arguments: { ...env.call.arguments, content: "changed" } },
      env.write,
    ),
  );
  await env.absent();
  assert.ok(env.node.toolCalls![0].authorization!.invalidatedAt);
});

test("concurrent duplicate dispatch consumes a grant only once", async (t) => {
  const env = await fixture(t);
  await env.approve();
  let executions = 0;
  const effect = async () => {
    executions++;
    await appendFile(env.target, "once\n");
  };
  const results = await Promise.allSettled([
    env.execution.executeTool(env.call, effect),
    env.execution.executeTool(env.call, effect),
  ]);
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.equal(executions, 1);
  assert.equal(await readFile(env.target, "utf8"), "once\n");
  await assert.rejects(env.execution.executeTool(env.call, effect));
  assert.equal(executions, 1);
  assert.equal(env.node.toolCalls![0].status, "running");
  assert.equal(env.node.toolCalls![0].authorization!.invalidatedAt, undefined);
});

test("changing approval configuration after issuance invalidates the unconsumed grant", async (t) => {
  const env = await fixture(t);
  await env.approve();
  await env.scheduler.configureWorkspace(env.workspace.id, {
    approvalMode: "ask",
  });
  await assert.rejects(env.execution.executeTool(env.call, env.write));
  await env.absent();
  assert.ok(env.node.toolCalls![0].authorization!.invalidatedAt);
});

for (const interruption of ["settings", "cancellation"] as const) {
  test(`${interruption} while consumption persistence is pending prevents the file effect`, async (t) => {
    const env = await fixture(t);
    await env.approve();
    const held = env.holdConsumptionSave();
    const rejected = assert.rejects(
      env.execution.executeTool(env.call, env.write),
    );
    await held.entered;
    await env.absent();
    if (interruption === "settings") {
      await env.scheduler.configureWorkspace(env.workspace.id, {
        approvalMode: "ask",
      });
    } else {
      await env.scheduler.cancel(env.workspace.id, env.node.id);
    }
    held.release();
    await rejected;
    await env.absent();
    assert.ok(env.node.toolCalls![0].authorization!.invalidatedAt);
  });
}

test("failed consumption persistence prevents execution and cannot replay its grant", async (t) => {
  const env = await fixture(t);
  await env.approve();
  let failed = false;
  env.store.save = async (settings) => {
    if (
      !settings &&
      env.node.toolCalls?.[0].authorization?.consumedAt &&
      !failed
    ) {
      failed = true;
      throw new Error("Consumption persistence failed");
    }
    return env.save(settings);
  };
  await assert.rejects(
    env.execution.executeTool(env.call, env.write),
    /Consumption persistence failed/,
  );
  await env.absent();
  assert.ok(env.node.toolCalls![0].authorization!.invalidatedAt);
  env.store.save = env.save;
  await assert.rejects(env.execution.executeTool(env.call, env.write));
  await env.absent();
});
