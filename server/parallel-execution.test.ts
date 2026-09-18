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
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ModelOption, RunConfig, ToolCall } from "../shared/types.ts";
import { createPanelTools } from "./coding-tools.ts";
import type { RunEnvironment, Runtime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type StoredNode, type StoredWorkspace } from "./store.ts";

const config: RunConfig = { model: "test/parallel", thinking: "off" };
const model: ModelOption = {
  id: config.model,
  name: "Parallel test",
  provider: "test",
  providerName: "Test",
  available: true,
  demo: false,
  thinkingLevels: ["off"],
  contextWindow: 128000,
};
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for parallel execution");
}
interface Run {
  environment: RunEnvironment;
  signal: AbortSignal;
  finish: (error?: string) => void;
}
async function fixture(t: TestContext) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-parallel-")),
  );
  const project = join(directory, "project");
  await mkdir(project);
  const store = new Store(join(directory, "state"));
  await store.init(false);
  const workspace = createWorkspace(
    "Parallel",
    "Shared files, independent contexts",
  );
  workspace.workingDirectory = project;
  workspace.approvalMode = "auto";
  workspace.safetyModel = config.model;
  store.data.workspaces.push(workspace);
  const runs = new Map<string, Run>();
  const allRuns: Run[] = [];
  const releases: Array<() => void> = [];
  const executions: Promise<unknown>[] = [];
  const runtime: Runtime = {
    models: () => [model],
    reviewTool: async () => ({ decision: "approve", reason: "Test approval" }),
    async run(_config, _messages, prompt, signal, _onText, environment) {
      assert.ok(environment);
      let finish!: (error?: string) => void;
      const completion = new Promise<string | undefined>((resolve) => {
        finish = resolve;
      });
      const run = { environment, signal, finish };
      runs.set(prompt, run);
      allRuns.push(run);
      signal.addEventListener("abort", () => finish(), { once: true });
      const failure = await completion;
      signal.throwIfAborted();
      if (failure) throw new Error(failure);
      return { response: "Finished", messages: [] };
    },
  };
  const scheduler = new Scheduler(store, runtime);
  t.after(async () => {
    scheduler.shutdown();
    for (const release of releases) release();
    for (const run of allRuns) run.finish();
    await Promise.allSettled(executions);
    await delay(20);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  });
  const submit = async (
    prompt: string,
    target: StoredWorkspace = workspace,
  ) => {
    const node = await scheduler.submit(target.id, {
      parentId: target.nodes[0].id,
      prompt,
      config,
      requestId: randomUUID(),
    });
    await until(() => runs.has(prompt));
    return node;
  };
  const invoke = (
    node: StoredNode,
    name: string,
    args: Record<string, unknown>,
    effect?: () => Promise<unknown>,
  ) => {
    const promise = (async () => {
      const run = runs.get(node.prompt)!;
      const call: Pick<ToolCall, "id" | "name" | "arguments"> = {
        id: randomUUID(),
        name,
        arguments: args,
      };
      if (!(await run.environment.beforeToolCall(call))) return;
      const tool = createPanelTools(run.environment.workingDirectory!).find(
        (tool) => tool.name === name,
      );
      try {
        const result = await run.environment.executeTool(
          call,
          effect ?? (() => tool!.execute(call.id, args, run.signal)),
        );
        run.environment.onToolUpdate(call.id, { status: "completed" });
        return result;
      } catch (error) {
        run.environment.onToolUpdate(call.id, {
          status: "failed",
          error: String(error),
        });
        throw error;
      }
    })();
    executions.push(promise);
    void promise.catch(() => {});
    return promise;
  };
  const finish = async (node: StoredNode, failure?: string) => {
    runs.get(node.prompt)!.finish(failure);
    await until(() => Boolean(node.finishedAt));
    await store.save();
    await delay(0);
  };
  const hold = () => {
    const value = gate();
    releases.push(value.release);
    return value;
  };
  return {
    directory,
    project,
    store,
    workspace,
    runtime,
    scheduler,
    runs,
    submit,
    invoke,
    finish,
    hold,
  };
}

test("same workspace has no default global task limit and cancellation only stops its own model", async (t) => {
  const e = await fixture(t);
  const nodes = await Promise.all(
    Array.from({ length: 8 }, (_, i) => e.submit(`branch-${i}`)),
  );
  assert.equal(e.runs.size, 8);
  assert.ok(nodes.every((node) => node.status === "running"));
  assert.equal(
    new Set(nodes.map((node) => node.execution?.workingDirectory)).size,
    1,
  );
  await e.scheduler.cancel(e.workspace.id, nodes[0].id);
  await until(() => Boolean(nodes[0].finishedAt));
  assert.equal(nodes[0].status, "cancelled");
  assert.ok(nodes.slice(1).every((node) => node.status === "running"));
});

test("different file writes overlap, have isolated Git records and retry restores only the owning branch", async (t) => {
  const e = await fixture(t);
  await writeFile(join(e.project, "a.txt"), "old a");
  await writeFile(join(e.project, "b.txt"), "old b");
  const a = await e.submit("a"),
    b = await e.submit("b");
  const hold = e.hold();
  const entered = new Set<string>();
  const write = (node: StoredNode, path: string, content: string) =>
    e.invoke(node, "write", { path, content }, async () => {
      entered.add(path);
      await hold.promise;
      await writeFile(join(e.project, path), content);
    });
  const first = write(a, "a.txt", "new a"),
    second = write(b, "b.txt", "new b");
  await until(() => entered.size === 2);
  hold.release();
  await Promise.all([first, second]);
  for (const node of [a, b]) {
    const entries = e.workspace.gitHistory!.filter(
      (entry) => entry.nodeId === node.id,
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, "completed");
    assert.deepEqual(entries[0].files, [
      { path: `${node.prompt}.txt`, status: "modified" },
    ]);
  }
  await e.finish(a, "retry this branch");
  await e.finish(b);
  const previous = e.runs.get("a");
  const retried = await e.scheduler.retry(e.workspace.id, a.id, {
    expectedRevision: 0,
    requestId: randomUUID(),
  });
  await until(() => e.runs.get("a") !== previous);
  assert.equal(retried.status, "running");
  assert.equal(await readFile(join(e.project, "a.txt"), "utf8"), "old a");
  assert.equal(await readFile(join(e.project, "b.txt"), "utf8"), "new b");
});

test("Pi path aliases share locks and Git records with the actual written file", async (t) => {
  const e = await fixture(t);
  const a = await e.submit("alias"),
    b = await e.submit("canonical");
  const hold = e.hold();
  let entered = false;
  const tool = createPanelTools(e.project).find(
    (entry) => entry.name === "write",
  )!;
  const first = e.invoke(
    a,
    "write",
    { path: "@canonical.txt", content: "first" },
    async () => {
      entered = true;
      await hold.promise;
      return tool.execute(
        randomUUID(),
        { path: "@canonical.txt", content: "first" },
        e.runs.get(a.prompt)!.signal,
      );
    },
  );
  await until(() => entered);
  const second = e.invoke(b, "write", {
    path: "canonical.txt",
    content: "second",
  });
  await until(() => Boolean(b.toolCalls?.[0].waitingFor));
  hold.release();
  await Promise.all([first, second]);
  assert.equal(
    await readFile(join(e.project, "canonical.txt"), "utf8"),
    "second",
  );
  for (const node of [a, b]) {
    const entry = e.workspace.gitHistory!.find(
      (item) => item.nodeId === node.id,
    )!;
    assert.equal(entry.status, "completed");
    assert.deepEqual(entry.files, [
      { path: "canonical.txt", status: node === a ? "added" : "modified" },
    ]);
  }
});

test("same file writes wait across workspaces while an unrelated file remains runnable", async (t) => {
  const e = await fixture(t);
  const other = createWorkspace("Other", "");
  Object.assign(other, {
    workingDirectory: e.project,
    approvalMode: "auto",
    safetyModel: config.model,
  });
  e.store.data.workspaces.push(other);
  const a = await e.submit("a"),
    b = await e.submit("b", other),
    c = await e.submit("c");
  const hold = e.hold();
  let firstEntered = false,
    secondEntered = false;
  const first = e.invoke(
    a,
    "write",
    { path: "shared.txt", content: "a" },
    async () => {
      firstEntered = true;
      await hold.promise;
      await writeFile(join(e.project, "shared.txt"), "a");
    },
  );
  await until(() => firstEntered);
  const second = e.invoke(
    b,
    "write",
    { path: "shared.txt", content: "b" },
    async () => {
      secondEntered = true;
      await writeFile(join(e.project, "shared.txt"), "b");
    },
  );
  await until(() => Boolean(b.toolCalls?.[0].waitingFor));
  assert.equal(secondEntered, false);
  assert.equal(b.toolCalls![0].authorization?.consumedAt, undefined);
  await e.invoke(c, "write", { path: "unrelated.txt", content: "c" });
  assert.equal(await readFile(join(e.project, "unrelated.txt"), "utf8"), "c");
  assert.equal(secondEntered, false);
  hold.release();
  await Promise.all([first, second]);
  assert.equal(await readFile(join(e.project, "shared.txt"), "utf8"), "b");
  assert.equal(b.toolCalls![0].waitingFor, undefined);
});

test("shell excludes filesystem effects but does not block web tools or other running models", async (t) => {
  const e = await fixture(t);
  const a = await e.submit("shell"),
    b = await e.submit("file"),
    c = await e.submit("web");
  const hold = e.hold();
  let shellEntered = false,
    fileEntered = false,
    webEntered = false;
  const command = e.invoke(
    a,
    "bash",
    { command: "test-controlled-shell" },
    async () => {
      shellEntered = true;
      await hold.promise;
    },
  );
  await until(() => shellEntered);
  const file = e.invoke(
    b,
    "write",
    { path: "file.txt", content: "b" },
    async () => {
      fileEntered = true;
      await writeFile(join(e.project, "file.txt"), "b");
    },
  );
  await until(() => Boolean(b.toolCalls?.[0].waitingFor));
  await e.invoke(c, "web_fetch", { url: "https://example.com" }, async () => {
    webEntered = true;
  });
  assert.equal(webEntered, true);
  assert.equal(fileEntered, false);
  assert.ok([a, b, c].every((node) => node.status === "running"));
  hold.release();
  await Promise.all([command, file]);
  assert.equal(fileEntered, true);
});

test("cancelling a waiting file operation prevents its effect and leaves other branches running", async (t) => {
  const e = await fixture(t);
  const a = await e.submit("a"),
    b = await e.submit("b");
  const hold = e.hold();
  let entered = false,
    rejectedEffect = false;
  const first = e.invoke(
    a,
    "write",
    { path: "shared.txt", content: "a" },
    async () => {
      entered = true;
      await hold.promise;
      await writeFile(join(e.project, "shared.txt"), "a");
    },
  );
  await until(() => entered);
  const second = e.invoke(
    b,
    "edit",
    { path: "shared.txt", edits: [{ oldText: "a", newText: "b" }] },
    async () => {
      rejectedEffect = true;
    },
  );
  const rejected = assert.rejects(second);
  await until(() => Boolean(b.toolCalls?.[0].waitingFor));
  await e.scheduler.cancel(e.workspace.id, b.id);
  await rejected;
  assert.equal(rejectedEffect, false);
  assert.equal(b.toolCalls![0].waitingFor, undefined);
  assert.equal(a.status, "running");
  hold.release();
  await first;
  assert.equal(await readFile(join(e.project, "shared.txt"), "utf8"), "a");
});

test("approval settings changed while waiting for a file invalidate execution rather than auto-running", async (t) => {
  const e = await fixture(t);
  const a = await e.submit("a"),
    b = await e.submit("b");
  const hold = e.hold();
  let entered = false,
    effect = false;
  const first = e.invoke(
    a,
    "write",
    { path: "shared.txt", content: "a" },
    async () => {
      entered = true;
      await hold.promise;
      await writeFile(join(e.project, "shared.txt"), "a");
    },
  );
  await until(() => entered);
  const second = e.invoke(
    b,
    "write",
    { path: "shared.txt", content: "b" },
    async () => {
      effect = true;
    },
  );
  const rejected = assert.rejects(second, /审批|配置|授权/);
  await until(() => Boolean(b.toolCalls?.[0].waitingFor));
  await e.scheduler.configureWorkspace(e.workspace.id, { approvalMode: "ask" });
  hold.release();
  await first;
  await rejected;
  assert.equal(effect, false);
  assert.equal(await readFile(join(e.project, "shared.txt"), "utf8"), "a");
});

test("a grant expiring during file contention cannot execute when the file becomes available", async (t) => {
  const e = await fixture(t);
  const a = await e.submit("a"),
    b = await e.submit("b");
  const hold = e.hold();
  let entered = false,
    effect = false;
  const first = e.invoke(
    a,
    "write",
    { path: "shared.txt", content: "a" },
    async () => {
      entered = true;
      await hold.promise;
      await writeFile(join(e.project, "shared.txt"), "a");
    },
  );
  await until(() => entered);
  const second = e.invoke(
    b,
    "write",
    { path: "shared.txt", content: "b" },
    async () => {
      effect = true;
    },
  );
  const rejected = assert.rejects(second, /过期|失效/);
  await until(() => Boolean(b.toolCalls?.[0].waitingFor));
  const advanced = Date.now() + 31_000;
  const clock = t.mock.method(Date, "now", () => advanced);
  hold.release();
  try {
    await first;
    await rejected;
  } finally {
    clock.mock.restore();
  }
  assert.equal(effect, false);
  assert.ok(b.toolCalls![0].authorization?.invalidatedAt);
  assert.equal(await readFile(join(e.project, "shared.txt"), "utf8"), "a");
});

test("a failed file effect retains its partial snapshot and releases the lock for the next operation", async (t) => {
  const e = await fixture(t);
  const a = await e.submit("a"),
    b = await e.submit("b");
  await assert.rejects(
    e.invoke(
      a,
      "write",
      { path: "shared.txt", content: "partial" },
      async () => {
        await writeFile(join(e.project, "shared.txt"), "partial");
        throw new Error("failure after effect");
      },
    ),
    /failure after effect/,
  );
  assert.equal(a.toolCalls![0].fileSnapshot, "recorded");
  assert.equal(e.workspace.gitHistory![0].status, "completed");
  assert.deepEqual(e.workspace.gitHistory![0].files, [
    { path: "shared.txt", status: "added" },
  ]);
  await e.invoke(b, "edit", {
    path: "shared.txt",
    edits: [{ oldText: "partial", newText: "next" }],
  });
  assert.equal(await readFile(join(e.project, "shared.txt"), "utf8"), "next");
});
