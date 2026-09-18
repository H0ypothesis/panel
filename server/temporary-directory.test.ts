import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
import type { RunConfig } from "../shared/types.ts";
import { PiRuntime, type Runtime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type StoredNode, type StoredWorkspace } from "./store.ts";

const config: RunConfig = { model: "openai/temporary-test", thinking: "off" };
const tool = (name: string, args: Record<string, unknown>, id: string) =>
  fauxAssistantMessage(fauxToolCall(name, args, { id }), {
    stopReason: "toolUse",
  });
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for temporary directory execution");
}

async function completed(node: StoredNode, store: Store) {
  await until(() => node.status === "completed" || node.status === "failed");
  assert.equal(node.status, "completed", node.error);
  await store.save();
}

class LocalPiRuntime extends PiRuntime {
  override models() {
    return super.models().map((model) => ({ ...model, available: true }));
  }
}

async function fixture(
  t: TestContext,
  responses: FauxResponseStep[] = [fauxAssistantMessage("完成")],
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-temporary-directory-")),
  );
  const dataDirectory = join(directory, "state");
  const store = new Store(dataDirectory);
  await store.init(false);
  const workspace = createWorkspace("论文下载", "未绑定本地项目");
  store.data.workspaces.push(workspace);
  const registry = createModels();
  const faux = fauxProvider({
    provider: "openai",
    models: [{ id: "temporary-test" }],
    tokensPerSecond: 100000,
    tokenSize: { min: 100, max: 200 },
  });
  faux.setResponses(responses);
  registry.setProvider(faux.provider);
  const runtime = new LocalPiRuntime(registry);
  const scheduler = new Scheduler(store, runtime);
  const schedulers = [scheduler];
  const stores = [store];
  t.after(async () => {
    for (const instance of schedulers) instance.shutdown();
    await delay(50);
    for (const instance of stores) await instance.save();
    await rm(directory, { recursive: true, force: true });
  });
  const submit = (
    target: StoredWorkspace = workspace,
    prompt = "在当前空间保存文件",
  ) =>
    scheduler.submit(target.id, {
      parentId: target.nodes[0].id,
      prompt,
      config,
      requestId: randomUUID(),
    });
  return {
    directory,
    dataDirectory,
    store,
    workspace,
    runtime,
    scheduler,
    schedulers,
    stores,
    faux,
    submit,
  };
}

test("unbound Pi runs write and execute in their temporary directory only after approval", async (t) => {
  const script =
    "require('node:fs').writeFileSync('command.txt', 'executed'); console.log(process.cwd())";
  const env = await fixture(t, [
    tool("write", { path: "paper.txt", content: "paper content" }, "write-1"),
    tool(
      "bash",
      { command: `${quote(process.execPath)} -e ${quote(script)}` },
      "bash-1",
    ),
    tool("write", { path: "denied.txt", content: "never" }, "write-2"),
    fauxAssistantMessage("完成获批的操作"),
  ]);
  const temporaryDirectory = join(
    env.dataDirectory,
    "workspaces",
    env.workspace.id,
  );
  assert.equal(env.workspace.workingDirectory, undefined);
  assert.equal(
    env.store.snapshot().workspaces[0].temporaryDirectory,
    temporaryDirectory,
  );
  await assert.rejects(stat(temporaryDirectory), { code: "ENOENT" });

  const node = await env.submit();
  await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
  assert.equal(node.execution?.workingDirectory, temporaryDirectory);
  await assert.rejects(readFile(join(temporaryDirectory, "paper.txt")), {
    code: "ENOENT",
  });
  await env.scheduler.approve(env.workspace.id, node.id, "write-1", "approve");
  await until(() => node.toolCalls?.[1]?.status === "awaiting_approval");
  assert.equal(
    await readFile(join(temporaryDirectory, "paper.txt"), "utf8"),
    "paper content",
  );
  await assert.rejects(readFile(join(temporaryDirectory, "command.txt")), {
    code: "ENOENT",
  });
  await env.scheduler.approve(env.workspace.id, node.id, "bash-1", "approve");
  await until(() => node.toolCalls?.[2]?.status === "awaiting_approval");
  assert.equal(
    await readFile(join(temporaryDirectory, "command.txt"), "utf8"),
    "executed",
  );
  assert.equal(node.toolCalls![1].output?.trim(), temporaryDirectory);
  await env.scheduler.approve(env.workspace.id, node.id, "write-2", "deny");
  await completed(node, env.store);
  assert.equal(node.toolCalls![2].status, "denied");
  await assert.rejects(readFile(join(temporaryDirectory, "denied.txt")), {
    code: "ENOENT",
  });

  // Loading state preserves the workspace identity and its downloaded files.
  env.scheduler.shutdown();
  const restarted = new Store(env.dataDirectory);
  await restarted.init(false);
  env.stores.push(restarted);
  const restored = restarted.workspace(env.workspace.id);
  assert.equal(restored.workingDirectory, undefined);
  assert.equal(
    restarted.effectiveWorkingDirectory(restored),
    temporaryDirectory,
  );
  env.faux.setResponses([
    tool("read", { path: "paper.txt" }, "read-1"),
    fauxAssistantMessage("重新读取已保存文件"),
  ]);
  const resumed = new Scheduler(restarted, env.runtime);
  env.schedulers.push(resumed);
  const read = await resumed.submit(restored.id, {
    parentId: restored.nodes[0].id,
    prompt: "读取上次保存的文件",
    config,
    requestId: randomUUID(),
  });
  await completed(read, restarted);
  assert.match(read.toolCalls![0].output!, /paper content/);
  assert.equal(read.toolCalls![0].approval, "policy");
});

test("binding and clearing switch future runs while preserving temporary files and historical execution", async (t) => {
  const env = await fixture(t, [
    tool("write", { path: "saved.txt", content: "temporary" }, "write-1"),
    fauxAssistantMessage("已保存"),
  ]);
  const temporaryDirectory = env.store.temporaryDirectory(env.workspace);
  const selected = join(env.directory, "selected");
  await mkdir(selected);
  const first = await env.submit();
  await until(() => first.toolCalls?.[0]?.status === "awaiting_approval");
  await assert.rejects(
    env.scheduler.configureWorkspace(env.workspace.id, {
      workingDirectory: selected,
    }),
    /任务结束|运行|更换工作目录/,
  );
  await env.scheduler.approve(env.workspace.id, first.id, "write-1", "approve");
  await completed(first, env.store);
  await env.scheduler.configureWorkspace(env.workspace.id, {
    workingDirectory: selected,
  });
  assert.equal(env.store.effectiveWorkingDirectory(env.workspace), selected);
  env.faux.setResponses([
    tool("write", { path: "saved.txt", content: "selected" }, "write-2"),
    fauxAssistantMessage("已保存到自选目录"),
  ]);
  const bound = await env.submit();
  await until(() => bound.toolCalls?.[0]?.status === "awaiting_approval");
  await assert.rejects(
    env.scheduler.configureWorkspace(env.workspace.id, {
      workingDirectory: null,
    }),
    /任务结束|运行|更换工作目录/,
  );
  await env.scheduler.approve(env.workspace.id, bound.id, "write-2", "approve");
  await completed(bound, env.store);
  assert.equal(bound.execution?.workingDirectory, selected);
  assert.equal(first.execution?.workingDirectory, temporaryDirectory);

  await env.scheduler.configureWorkspace(env.workspace.id, {
    workingDirectory: null,
  });
  assert.equal(env.workspace.workingDirectory, undefined);
  assert.equal(
    env.store.effectiveWorkingDirectory(env.workspace),
    temporaryDirectory,
  );
  env.faux.setResponses([
    tool("read", { path: "saved.txt" }, "read-1"),
    fauxAssistantMessage("恢复临时目录"),
  ]);
  const regenerated = await env.scheduler.regenerate(
    env.workspace.id,
    bound.id,
    {
      prompt: "读取之前保存的文件",
      config,
      requestId: randomUUID(),
      expectedRevision: bound.revision ?? 0,
    },
  );
  await completed(regenerated, env.store);
  assert.equal(regenerated.execution?.workingDirectory, temporaryDirectory);
  assert.equal(
    regenerated.previousRuns?.[0].execution?.workingDirectory,
    selected,
  );
  assert.match(regenerated.toolCalls![0].output!, /temporary/);
  assert.equal(await readFile(join(selected, "saved.txt"), "utf8"), "selected");
  assert.equal(
    await readFile(join(temporaryDirectory, "saved.txt"), "utf8"),
    "temporary",
  );
});

test("temporary directories serialize one workspace while separate workspaces run concurrently", async (t) => {
  const env = await fixture(t);
  env.scheduler.shutdown();
  const other = createWorkspace("独立空间", "独立任务");
  env.store.data.workspaces.push(other);
  const started = new Map<string, string | undefined>();
  const release = new Map<string, () => void>();
  const runtime: Runtime = {
    models: () => env.runtime.models(),
    async run(_config, _history, prompt, signal, _onText, execution) {
      started.set(prompt, execution?.workingDirectory);
      await new Promise<void>((resolve) => {
        release.set(prompt, resolve);
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      signal.throwIfAborted();
      return { messages: [], response: "完成" };
    },
  };
  const scheduler = new Scheduler(env.store, runtime);
  env.schedulers.push(scheduler);
  const submit = (workspace: StoredWorkspace, prompt: string) =>
    scheduler.submit(workspace.id, {
      parentId: workspace.nodes[0].id,
      prompt,
      config,
      requestId: randomUUID(),
    });
  const first = await submit(env.workspace, "first");
  const second = await submit(env.workspace, "second");
  const independent = await submit(other, "independent");
  await until(() => started.has("first") && started.has("independent"));
  assert.equal(second.status, "queued");
  assert.equal(started.has("second"), false);
  assert.notEqual(started.get("first"), started.get("independent"));
  assert.equal(
    started.get("first"),
    env.store.temporaryDirectory(env.workspace),
  );
  assert.equal(started.get("independent"), env.store.temporaryDirectory(other));
  release.get("first")!();
  await until(() => started.has("second"));
  assert.equal(started.get("second"), started.get("first"));
  assert.equal(independent.status, "running");
  release.get("second")!();
  release.get("independent")!();
  await Promise.all(
    [first, second, independent].map((node) => completed(node, env.store)),
  );
});

test("demo and historical unbound nodes do not acquire local execution or create directories", async (t) => {
  const env = await fixture(t);
  let environmentReceived: unknown = "not called";
  const run = env.runtime.run.bind(env.runtime);
  env.runtime.run = (...args) => {
    environmentReceived = args[5];
    return run(...args);
  };
  const node = await env.scheduler.submit(env.workspace.id, {
    parentId: env.workspace.nodes[0].id,
    prompt: "演示",
    config: { model: "demo/pi-demo", thinking: "off" },
    requestId: randomUUID(),
  });
  await until(() => node.response.length > 0 || node.status === "failed");
  assert.notEqual(node.status, "failed", node.error);
  assert.equal(environmentReceived, undefined);
  assert.equal(node.execution, undefined);
  assert.equal(node.toolCalls?.length ?? 0, 0);
  await env.scheduler.cancel(env.workspace.id, node.id);
  await assert.rejects(stat(env.store.temporaryDirectory(env.workspace)), {
    code: "ENOENT",
  });
  await env.store.save();
  const restarted = new Store(env.dataDirectory);
  await restarted.init(false);
  env.stores.push(restarted);
  assert.equal(
    restarted.workspace(env.workspace.id).nodes[1].execution,
    undefined,
  );
  await assert.rejects(stat(restarted.temporaryDirectory(env.workspace)), {
    code: "ENOENT",
  });
});

test("temporary paths use the canonical data root and do not backfill legacy execution snapshots", async (t) => {
  const env = await fixture(t);
  const alias = join(env.directory, "state-alias");
  await symlink(env.dataDirectory, alias);
  const historic: StoredNode = {
    ...env.workspace.nodes[0],
    id: randomUUID(),
    parentId: env.workspace.nodes[0].id,
    status: "completed",
    execution: { approvalMode: "ask" },
  };
  env.workspace.nodes.push(historic);
  await env.store.save();
  const aliased = new Store(alias);
  await aliased.init(false);
  env.stores.push(aliased);
  const restored = aliased.workspace(env.workspace.id);
  assert.equal(
    aliased.temporaryDirectory(restored),
    join(env.dataDirectory, "workspaces", restored.id),
  );
  assert.equal(restored.nodes[1].execution?.workingDirectory, undefined);
  await assert.rejects(stat(aliased.temporaryDirectory(restored)), {
    code: "ENOENT",
  });
});

for (const kind of [
  "container-link",
  "workspace-link",
  "container-file",
  "workspace-file",
] as const) {
  test(`temporary directory preparation rejects a ${kind} without writing outside`, async (t) => {
    const env = await fixture(t);
    const container = join(env.dataDirectory, "workspaces");
    const temporaryDirectory = env.store.temporaryDirectory(env.workspace);
    const outside = join(env.directory, "outside");
    await mkdir(outside);
    const target = kind.startsWith("container")
      ? container
      : temporaryDirectory;
    if (target !== container) await mkdir(container);
    if (kind.endsWith("link")) await symlink(outside, target);
    else await writeFile(target, "not a directory");
    await assert.rejects(env.store.prepareWorkingDirectory(env.workspace));
    await assert.rejects(stat(join(outside, env.workspace.id)), {
      code: "ENOENT",
    });
  });
}

test("temporary paths reject workspace IDs containing path components", async (t) => {
  const env = await fixture(t);
  for (const id of [
    "../escape",
    "nested/id",
    "nested\\id",
    ".",
    "..",
    "",
    "/absolute",
  ]) {
    const workspace = { ...env.workspace, id };
    await assert.rejects(
      Promise.resolve().then(() =>
        env.store.prepareWorkingDirectory(workspace),
      ),
      Error,
      `must reject workspace ID ${JSON.stringify(id)}`,
    );
  }
  await assert.rejects(stat(join(env.dataDirectory, "escape")), {
    code: "ENOENT",
  });
});

for (const operation of ["submit", "regenerate"] as const) {
  test(`shutdown during temporary directory preparation rejects ${operation} without changing nodes or calling the model`, async (t) => {
    const env = await fixture(t);
    const previous: StoredNode = {
      ...env.workspace.nodes[0],
      id: randomUUID(),
      parentId: env.workspace.nodes[0].id,
      prompt: "原来的问题",
      response: "应当保留的回答",
      status: "completed",
      execution: { approvalMode: "ask" },
    };
    env.workspace.nodes.push(previous);
    await env.store.save();
    const originalNodes = structuredClone(env.workspace.nodes);
    let modelCalls = 0;
    env.runtime.run = async () => {
      modelCalls++;
      return { messages: [], response: "不应启动" };
    };
    let entered!: () => void;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const prepare = env.store.prepareWorkingDirectory.bind(env.store);
    env.store.prepareWorkingDirectory = async (workspace) => {
      entered();
      await blocked;
      return prepare(workspace);
    };
    const pending =
      operation === "submit"
        ? env.submit()
        : env.scheduler.regenerate(env.workspace.id, previous.id, {
            prompt: "重新生成的问题",
            config,
            requestId: randomUUID(),
            expectedRevision: previous.revision ?? 0,
          });
    const rejected = assert.rejects(pending, /服务正在关闭/);
    await preparing;
    env.scheduler.shutdown();
    release();
    await rejected;
    assert.equal(modelCalls, 0);
    assert.deepEqual(env.workspace.nodes, originalNodes);
    assert.equal(
      env.workspace.nodes.some((node) => node.status === "queued"),
      false,
    );
    const persisted = JSON.parse(
      await readFile(join(env.dataDirectory, "state.json"), "utf8"),
    );
    assert.deepEqual(persisted.workspaces[0].nodes, originalNodes);
  });
}
