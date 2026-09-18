import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ModelOption, RunConfig } from "../shared/types.ts";
import { createApi } from "./api.ts";
import { temporaryWorkspaceDirectory } from "./directories.ts";
import type { Runtime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type PendingNodeRetry, type StoredWorkspace } from "./store.ts";

const config: RunConfig = { model: "test/workspace-deletion", thinking: "off" };
const model: ModelOption = {
  id: config.model,
  name: "Test",
  provider: "test",
  providerName: "Test",
  available: true,
  demo: false,
  thinkingLevels: ["off"],
  contextWindow: 100000,
};
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Timed out waiting for workspace deletion execution");
}

async function setup(t: TestContext, concurrency = 2) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-workspace-deletion-")),
  );
  const dataDirectory = join(directory, "data");
  const store = new Store(dataDirectory);
  await store.init(false);
  const workspace: StoredWorkspace = createWorkspace(
    "Delete me",
    "Temporary workspace",
  );
  const other: StoredWorkspace = createWorkspace("Keep me", "Other workspace");
  store.data.workspaces.push(workspace, other);
  await store.save();
  const releases = new Map<string, () => void>();
  const runtime: Runtime = {
    models: () => [model],
    async run(_config, _history, prompt, signal) {
      // Cancellation leaves the executor busy until the test releases it.
      await new Promise<void>((resolve) => releases.set(prompt, resolve));
      signal.throwIfAborted();
      return { messages: [], response: "done" };
    },
  };
  const scheduler = new Scheduler(store, runtime, concurrency);
  const schedulers = [scheduler];
  t.after(async () => {
    for (const instance of schedulers) instance.shutdown();
    for (const release of releases.values()) release();
    await delay(30);
    await rm(directory, { recursive: true, force: true });
  });
  const temporary = store.temporaryDirectory(workspace);
  const remove = (
    cleanup = false,
    expectedNodeIds = workspace.nodes.map((node) => node.id),
  ) =>
    scheduler.deleteWorkspace(workspace.id, {
      deleteTemporaryDirectory: cleanup,
      expectedNodeIds,
    });
  const submit = (target = workspace, prompt: string = randomUUID()) =>
    scheduler.submit(target.id, {
      parentId: target.nodes[0].id,
      prompt,
      config,
      requestId: randomUUID(),
    });
  const files = async () => {
    await store.prepareWorkingDirectory(workspace);
    await writeFile(join(temporary, "download.txt"), "keep until confirmed");
  };
  const api = createApi(store, runtime, scheduler);
  const call = async (method: string, path: string, body: unknown) => {
    const request = Readable.from([
      Buffer.from(JSON.stringify(body)),
    ]) as IncomingMessage;
    Object.assign(request, {
      method,
      url: path,
      headers: {
        host: "127.0.0.1:9999",
        "content-type": "application/json",
      },
    });
    let status = 0;
    let output = "";
    const response = {
      setHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        output = value;
      },
    } as unknown as ServerResponse;
    assert.equal(await api(request, response), true);
    return { status, body: JSON.parse(output) };
  };
  return {
    directory,
    dataDirectory,
    store,
    workspace,
    other,
    temporary,
    scheduler,
    schedulers,
    runtime,
    releases,
    remove,
    submit,
    files,
    call,
  };
}

test("deletion preserves temporary files by default and survives restart without resurrecting the space", async (t) => {
  const e = await setup(t);
  await e.files();
  const state = await e.scheduler.deleteWorkspace(e.workspace.id, {
    expectedNodeIds: e.workspace.nodes.map((node) => node.id),
  });
  assert.deepEqual(
    state.workspaces.map((workspace) => workspace.id),
    [e.other.id],
  );
  assert.equal(
    await readFile(join(e.temporary, "download.txt"), "utf8"),
    "keep until confirmed",
  );
  const reloaded = new Store(e.dataDirectory);
  await reloaded.init(false);
  assert.deepEqual(
    reloaded.snapshot().workspaces.map((workspace) => workspace.id),
    [e.other.id],
  );
});

test("confirmed cleanup removes only managed temporary files, including links without following them", async (t) => {
  const e = await setup(t);
  await e.files();
  const selected = join(e.directory, "selected-project");
  await mkdir(selected);
  await writeFile(join(selected, "important.txt"), "project");
  await symlink(selected, join(e.temporary, "project-link"));
  await e.scheduler.configureWorkspace(e.workspace.id, {
    workingDirectory: selected,
  });
  await e.remove(true);
  await assert.rejects(stat(e.temporary), { code: "ENOENT" });
  assert.equal(
    await readFile(join(selected, "important.txt"), "utf8"),
    "project",
  );
  assert.equal(e.store.data.workspaces.length, 1);
});

test("cleanup of an unused workspace never creates the temporary parent directory", async (t) => {
  const e = await setup(t);
  await e.remove(true);
  await assert.rejects(stat(dirname(e.temporary)), { code: "ENOENT" });
});

for (const owner of ["self", "other"] as const) {
  test(`cleanup protects a ${owner} selected project overlapping the temporary path`, async (t) => {
    const e = await setup(t);
    await e.files();
    await e.scheduler.configureWorkspace(
      owner === "self" ? e.workspace.id : e.other.id,
      {
        workingDirectory: e.temporary,
      },
    );
    await assert.rejects(e.remove(true), /自选项目|其他探索绑定/);
    assert.equal(
      await readFile(join(e.temporary, "download.txt"), "utf8"),
      "keep until confirmed",
    );
    await e.remove(false);
    assert.ok(await stat(e.temporary));
  });
}

for (const kind of [
  "container-link",
  "workspace-link",
  "container-file",
  "workspace-file",
  "root-link",
] as const) {
  test(`cleanup rejects ${kind} without removing outside files`, async (t) => {
    const e = await setup(t);
    const outside = join(e.directory, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "important.txt"), "outside");
    const target =
      kind === "root-link"
        ? e.dataDirectory
        : kind.startsWith("container")
          ? dirname(e.temporary)
          : e.temporary;
    if (target === e.temporary) await mkdir(dirname(target));
    if (kind === "root-link")
      await rename(e.dataDirectory, join(e.directory, "original-data"));
    if (kind.endsWith("link")) await symlink(outside, target);
    else await writeFile(target, "not a directory");
    await assert.rejects(e.remove(true), /符号链接|普通文件/);
    assert.equal(e.store.data.workspaces.length, 2);
    assert.equal(e.workspace.pendingWorkspaceDeletion, undefined);
    assert.equal(
      await readFile(join(outside, "important.txt"), "utf8"),
      "outside",
    );
  });
}

test("temporary directory identity never accepts client path components", async () => {
  for (const id of ["../outside", "/tmp/outside", "a/b", "a\\b", "", ".", ".."])
    assert.throws(() => temporaryWorkspaceDirectory("/data", id), /ID/);
});

test("stale confirmation, duplicate IDs and concurrent new children cannot delete additional nodes", async (t) => {
  const e = await setup(t);
  const rootId = e.workspace.nodes[0].id;
  await assert.rejects(e.remove(false, [rootId, rootId]), /删除范围/);
  await assert.rejects(e.remove(false, ["wrong"]), /删除范围/);
  const submission = e.submit(e.workspace, "new child");
  const rejected = assert.rejects(e.remove(true, [rootId]), /删除范围|运行/);
  const node = await submission;
  await rejected;
  assert.ok(e.workspace.nodes.includes(node));
});

test("running, queued and cancelled but still active work prevent workspace deletion", async (t) => {
  const e = await setup(t, 1);
  const running = await e.submit(e.workspace, "running");
  await until(() => e.releases.has("running"));
  await assert.rejects(e.remove(true), /运行|排队|收尾/);
  const queued = await e.submit(e.other, "queued");
  assert.equal(queued.status, "queued");
  await assert.rejects(
    e.scheduler.deleteWorkspace(e.other.id, {
      deleteTemporaryDirectory: true,
      expectedNodeIds: e.other.nodes.map((node) => node.id),
    }),
    /运行|排队/,
  );
  await e.scheduler.cancel(e.workspace.id, running.id);
  assert.equal(running.status, "cancelled");
  await assert.rejects(e.remove(true), /收尾/);
  e.releases.get("running")!();
  await until(() => e.releases.has("queued"));
  await e.remove(true);
});

test("an unfinished filesystem restore prevents workspace deletion", async (t) => {
  const e = await setup(t);
  e.workspace.pendingNodeRetry = {
    workingDirectory: e.temporary,
  } as PendingNodeRetry;
  await assert.rejects(e.remove(false), /回溯/);
  delete e.workspace.pendingNodeRetry;
});

for (const cleanup of [false, true]) {
  test(`failed first persistence retains workspace and files (cleanup ${cleanup})`, async (t) => {
    const e = await setup(t);
    await e.files();
    await mkdir(join(e.dataDirectory, "state.json.tmp"));
    await assert.rejects(e.remove(cleanup));
    assert.equal(e.store.workspace(e.workspace.id), e.workspace);
    assert.equal(e.workspace.pendingWorkspaceDeletion, undefined);
    assert.equal(
      await readFile(join(e.temporary, "download.txt"), "utf8"),
      "keep until confirmed",
    );
    assert.equal(
      JSON.parse(await readFile(join(e.dataDirectory, "state.json"), "utf8"))
        .workspaces.length,
      2,
    );
    await rm(join(e.dataDirectory, "state.json.tmp"), { recursive: true });
    await e.remove(cleanup);
    assert.equal(e.store.data.workspaces.length, 1);
  });
}

test("partial cleanup failure keeps a durable retry record and blocks new work until explicit retry", async (t) => {
  const e = await setup(t);
  await e.files();
  await writeFile(join(e.temporary, "remaining.txt"), "still here");
  e.store.removeTemporaryDirectory = async () => {
    await rm(join(e.temporary, "download.txt"));
    throw new Error("simulated filesystem failure");
  };
  await assert.rejects(e.remove(true), /部分文件可能已删除.*探索已保留/);
  assert.equal(
    await readFile(join(e.temporary, "remaining.txt"), "utf8"),
    "still here",
  );
  await assert.rejects(e.submit(), /清理尚未完成/);
  await assert.rejects(e.remove(false), /清理已开始/);
  assert.equal(
    "pendingWorkspaceDeletion" in e.store.snapshot().workspaces[0],
    false,
  );
  const restarted = new Store(e.dataDirectory);
  await restarted.init(false);
  assert.equal(
    await readFile(join(e.temporary, "remaining.txt"), "utf8"),
    "still here",
  );
  const scheduler = new Scheduler(restarted, e.runtime);
  e.schedulers.push(scheduler);
  await scheduler.deleteWorkspace(e.workspace.id, {
    deleteTemporaryDirectory: true,
    expectedNodeIds: e.workspace.nodes.map((node) => node.id),
  });
  await assert.rejects(stat(e.temporary), { code: "ENOENT" });
  assert.equal(restarted.data.workspaces.length, 1);
});

test("failed final persistence preserves a recoverable space after cleanup and retry commits deletion", async (t) => {
  const e = await setup(t);
  await e.files();
  const original = e.store.removeTemporaryDirectory.bind(e.store);
  e.store.removeTemporaryDirectory = async (workspace) => {
    await original(workspace);
    await mkdir(join(e.dataDirectory, "state.json.tmp"));
  };
  await assert.rejects(e.remove(true), /临时目录已清理.*保存失败/);
  assert.equal(e.store.workspace(e.workspace.id), e.workspace);
  assert.ok(e.workspace.pendingWorkspaceDeletion);
  await assert.rejects(stat(e.temporary), { code: "ENOENT" });
  await rm(join(e.dataDirectory, "state.json.tmp"), { recursive: true });
  e.store.removeTemporaryDirectory = original;
  await e.remove(true);
  assert.equal(e.store.data.workspaces.length, 1);
});

test("cleanup excludes new directory bindings, workspace creation and historical retries in other spaces", async (t) => {
  const e = await setup(t);
  await e.files();
  const old = {
    ...e.other.nodes[0],
    id: randomUUID(),
    parentId: e.other.nodes[0].id,
    status: "failed" as const,
    config,
    execution: { workingDirectory: e.temporary, approvalMode: "ask" as const },
  };
  e.other.nodes.push(old);
  let started = false;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const original = e.store.removeTemporaryDirectory.bind(e.store);
  e.store.removeTemporaryDirectory = async (workspace) => {
    started = true;
    await blocked;
    await original(workspace);
  };
  const deleting = e.remove(true);
  await until(() => started);
  await assert.rejects(
    e.scheduler.configureWorkspace(e.other.id, {
      workingDirectory: e.temporary,
    }),
    /正在清理/,
  );
  await assert.rejects(
    e.scheduler.retry(e.other.id, old.id, {
      expectedRevision: 0,
      requestId: randomUUID(),
    }),
    /正在清理/,
  );
  const created = await e.call("POST", "/api/workspaces", {
    title: "Cannot bind",
    workingDirectory: e.temporary,
  });
  assert.equal(created.status, 409);
  release();
  await deleting;
});

test("a directory binding already awaiting persistence prevents cleanup before the new binding is published", async (t) => {
  const e = await setup(t);
  await e.files();
  const save = e.store.save.bind(e.store);
  let entered = false;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  e.store.save = async (settings) => {
    if (
      settings?.workspace === e.other &&
      settings.values?.workingDirectory === e.temporary
    ) {
      entered = true;
      await blocked;
    }
    return save(settings);
  };
  const binding = e.scheduler.configureWorkspace(e.other.id, {
    workingDirectory: e.temporary,
  });
  await until(() => entered);
  assert.equal(e.other.workingDirectory, undefined);
  await assert.rejects(e.remove(true), /正在绑定/);
  assert.equal(
    await readFile(join(e.temporary, "download.txt"), "utf8"),
    "keep until confirmed",
  );
  release();
  await binding;
  e.store.save = save;
});

test("cleanup never accepts client-supplied directory paths", async (t) => {
  const e = await setup(t);
  await e.files();
  const outside = join(e.directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "important.txt"), "outside");
  const result = await e.call("DELETE", `/api/workspaces/${e.workspace.id}`, {
    deleteTemporaryDirectory: true,
    expectedNodeIds: e.workspace.nodes.map((node) => node.id),
    temporaryDirectory: outside,
    workingDirectory: outside,
  });
  assert.equal(result.status, 200);
  await assert.rejects(stat(e.temporary), { code: "ENOENT" });
  assert.equal(
    await readFile(join(outside, "important.txt"), "utf8"),
    "outside",
  );
});

test("DELETE API validates explicit file choice and confirmation scope, returns AppState, and defaults to keeping files", async (t) => {
  const e = await setup(t);
  await e.files();
  const path = `/api/workspaces/${e.workspace.id}`;
  const expectedNodeIds = e.workspace.nodes.map((node) => node.id);
  for (const body of [
    {},
    { expectedNodeIds: [] },
    { expectedNodeIds, deleteTemporaryDirectory: "true" },
  ])
    assert.equal((await e.call("DELETE", path, body)).status, 400);
  assert.equal(
    (await e.call("DELETE", path, { expectedNodeIds: ["changed"] })).status,
    409,
  );
  const deleted = await e.call("DELETE", path, { expectedNodeIds });
  assert.equal(deleted.status, 200);
  assert.deepEqual(
    deleted.body.workspaces.map((workspace: StoredWorkspace) => workspace.id),
    [e.other.id],
  );
  assert.equal(
    await readFile(join(e.temporary, "download.txt"), "utf8"),
    "keep until confirmed",
  );
});
