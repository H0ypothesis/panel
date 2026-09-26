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
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ModelOption, RunConfig, ToolCall } from "../shared/types.ts";
import { createPanelTools } from "./coding-tools.ts";
import { createApi } from "./api.ts";
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
  const workspace: StoredWorkspace = createWorkspace(
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
  const previous = e.runs.get("a");
  const retried = await e.scheduler.retry(e.workspace.id, a.id, {
    expectedRevision: 0,
    requestId: randomUUID(),
  });
  await until(() => e.runs.get("a") !== previous);
  assert.equal(retried.status, "running");
  assert.equal(await readFile(join(e.project, "a.txt"), "utf8"), "old a");
  assert.equal(await readFile(join(e.project, "b.txt"), "utf8"), "new b");
  assert.equal(b.status, "running");
  assert.equal(e.runs.get("b")!.signal.aborted, false);
});

test("retry without file changes proceeds while another branch holds the shell lock", async (t) => {
  for (const operation of ["none", "read", "unchanged write"] as const) {
    await t.test(operation, { timeout: 10_000 }, async (t) => {
      const e = await fixture(t);
      await writeFile(join(e.project, "a.txt"), "original");
      const a = await e.submit("failed");
      if (operation !== "none") {
        await e.invoke(a, operation === "read" ? "read" : "write", {
          path: "a.txt",
          content: "original",
        });
        if (operation === "unchanged write")
          assert.equal(a.toolCalls?.[0].fileSnapshot, "unchanged");
      }
      await e.finish(a, "retry without a rollback");
      const b = await e.submit("busy shell");
      const hold = e.hold();
      let entered = false;
      const shell = e.invoke(
        b,
        "bash",
        { command: "long-running task" },
        async () => {
          entered = true;
          await hold.promise;
        },
      );
      await until(() => entered);
      const previous = e.runs.get(a.prompt);
      const retried = await e.scheduler.retry(e.workspace.id, a.id, {
        expectedRevision: 0,
        requestId: randomUUID(),
      });
      await until(() => e.runs.get(a.prompt) !== previous);
      assert.equal(retried.id, a.id);
      assert.equal(retried.status, "running");
      assert.equal(b.status, "running");
      assert.equal(b.toolCalls?.[0].status, "running");
      assert.equal(
        await readFile(join(e.project, "a.txt"), "utf8"),
        "original",
      );
      hold.release();
      await shell;
    });
  }
});

test(
  "retry restores its files while an unrelated file write is still executing",
  { timeout: 10_000 },
  async (t) => {
    const e = await fixture(t);
    await writeFile(join(e.project, "a.txt"), "original a");
    const a = await e.submit("retry a");
    await e.invoke(a, "write", { path: "a.txt", content: "partial a" });
    await e.finish(a, "failed after writing");
    const b = await e.submit("write b");
    const hold = e.hold();
    let entered = false;
    const write = e.invoke(
      b,
      "write",
      { path: "b.txt", content: "final b" },
      async () => {
        entered = true;
        await hold.promise;
        await writeFile(join(e.project, "b.txt"), "final b");
      },
    );
    await until(() => entered);
    const previous = e.runs.get(a.prompt);
    const retried = await e.scheduler.retry(e.workspace.id, a.id, {
      expectedRevision: 0,
      requestId: randomUUID(),
    });
    await until(() => e.runs.get(a.prompt) !== previous);
    assert.equal(retried.status, "running");
    assert.equal(b.toolCalls?.[0].status, "running");
    assert.equal(
      await readFile(join(e.project, "a.txt"), "utf8"),
      "original a",
    );
    hold.release();
    await write;
    assert.equal(await readFile(join(e.project, "b.txt"), "utf8"), "final b");
    assert.deepEqual(
      e.workspace.gitHistory!.find((entry) => entry.nodeId === b.id)!.files,
      [{ path: "b.txt", status: "added" }],
    );
  },
);

test(
  "retry waits for a conflicting write and preserves its newer contents",
  { timeout: 10_000 },
  async (t) => {
    const e = await fixture(t);
    await writeFile(join(e.project, "shared.txt"), "original");
    const a = await e.submit("failed writer");
    await e.invoke(a, "write", { path: "shared.txt", content: "partial" });
    await e.finish(a, "failed after writing");
    const b = await e.submit("newer writer");
    const hold = e.hold();
    let entered = false;
    const write = e.invoke(
      b,
      "write",
      { path: "shared.txt", content: "newer" },
      async () => {
        entered = true;
        await hold.promise;
        await writeFile(join(e.project, "shared.txt"), "newer");
      },
    );
    await until(() => entered);
    let settled = false;
    const retry = e.scheduler.retry(e.workspace.id, a.id, {
      expectedRevision: 0,
      requestId: randomUUID(),
    });
    void retry.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await delay(50);
    assert.equal(settled, false);
    assert.equal(
      await readFile(join(e.project, "shared.txt"), "utf8"),
      "partial",
    );
    hold.release();
    await write;
    await assert.rejects(retry, /后续操作|修改|冲突/);
    assert.equal(
      await readFile(join(e.project, "shared.txt"), "utf8"),
      "newer",
    );
    assert.equal(b.status, "running");
    assert.equal(a.revision ?? 0, 0);
  },
);

test("a failed restore protects its files from existing runs while unrelated tools continue", async (t) => {
  const e = await fixture(t);
  await writeFile(join(e.project, "a.txt"), "original a");
  const a = await e.submit("restore a");
  await e.invoke(a, "write", { path: "a.txt", content: "partial a" });
  await e.finish(a, "failed after writing");
  const b = await e.submit("existing sibling");
  const input = { expectedRevision: 0, requestId: randomUUID() };
  const applyRestore = e.store.gitSnapshots.applyRestore.bind(
    e.store.gitSnapshots,
  );
  e.store.gitSnapshots.applyRestore = async () => {
    throw new Error("restore interrupted");
  };
  try {
    await assert.rejects(
      e.scheduler.retry(e.workspace.id, a.id, input),
      /restore interrupted/,
    );
  } finally {
    e.store.gitSnapshots.applyRestore = applyRestore;
  }
  assert.equal(e.workspace.pendingNodeRetry?.status, "failed");
  await e.invoke(b, "write", { path: "b.txt", content: "unrelated" });
  await assert.rejects(
    e.invoke(b, "write", { path: "a.txt", content: "must not overwrite" }),
    /回溯/,
  );
  assert.equal(await readFile(join(e.project, "a.txt"), "utf8"), "partial a");
  const previous = e.runs.get(a.prompt);
  const retried = await e.scheduler.retry(e.workspace.id, a.id, input);
  await until(() => e.runs.get(a.prompt) !== previous);
  assert.equal(retried.status, "running");
  assert.equal(e.workspace.pendingNodeRetry, undefined);
  assert.equal(await readFile(join(e.project, "a.txt"), "utf8"), "original a");
  assert.equal(await readFile(join(e.project, "b.txt"), "utf8"), "unrelated");
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

test("batch approval releases only matching pending tools and future calls on the same card", async (t) => {
  const e = await fixture(t);
  e.workspace.approvalMode = "ask";
  const a = await e.submit("batch-card");
  const b = await e.submit("other-card");
  const effects: string[] = [];
  const effect = (value: string) => async () => {
    effects.push(value);
  };
  const first = e.invoke(a, "web_search", { query: "one" }, effect("first"));
  const second = e.invoke(a, "web_search", { query: "two" }, effect("second"));
  const fetch = e.invoke(
    a,
    "web_fetch",
    { url: "https://example.com" },
    effect("fetch"),
  );
  const sibling = e.invoke(
    b,
    "web_search",
    { query: "sibling" },
    effect("sibling"),
  );
  await until(() => a.toolCalls?.length === 3 && b.toolCalls?.length === 1);
  await e.scheduler.approve(
    e.workspace.id,
    a.id,
    a.toolCalls![0].id,
    "approve_tool",
  );
  await Promise.all([first, second]);
  await e.invoke(a, "web_search", { query: "later" }, effect("later"));
  assert.deepEqual([...effects].sort(), ["first", "later", "second"]);
  assert.equal(a.toolCalls![2].status, "awaiting_approval");
  assert.equal(b.toolCalls![0].status, "awaiting_approval");
  const grants = a.toolCalls!.filter((call) => call.name === "web_search");
  assert.ok(
    grants.every(
      (call) =>
        call.approval === "approved_tool" && call.authorization?.consumedAt,
    ),
  );
  assert.equal(new Set(grants.map((call) => call.authorization?.id)).size, 3);
  await e.scheduler.approve(e.workspace.id, a.id, a.toolCalls![2].id, "deny");
  await e.scheduler.approve(e.workspace.id, b.id, b.toolCalls![0].id, "deny");
  await Promise.all([fetch, sibling]);
});

test("a batch grant never survives a failed save and single approval does not grant later calls", async (t) => {
  const e = await fixture(t);
  e.workspace.approvalMode = "ask";
  const node = await e.submit("failed-batch-save");
  let effects = 0;
  const effect = async () => {
    effects++;
  };
  const first = e.invoke(node, "web_search", { query: "one" }, effect);
  await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
  const save = e.store.save.bind(e.store);
  e.store.save = async () => {
    throw new Error("batch save failed");
  };
  await assert.rejects(
    e.scheduler.approve(
      e.workspace.id,
      node.id,
      node.toolCalls![0].id,
      "approve_tool",
    ),
    /batch save failed/,
  );
  assert.equal(effects, 0);
  assert.equal(node.toolCalls![0].status, "awaiting_approval");
  e.store.save = save;
  await e.scheduler.approve(
    e.workspace.id,
    node.id,
    node.toolCalls![0].id,
    "approve",
  );
  await first;
  const next = e.invoke(node, "web_search", { query: "two" }, effect);
  await until(() => node.toolCalls?.[1]?.status === "awaiting_approval");
  assert.equal(effects, 1);
  await e.scheduler.approve(
    e.workspace.id,
    node.id,
    node.toolCalls![1].id,
    "deny",
  );
  await next;
});

test("batch approval cannot take effect when cancelled while persistence is pending", async (t) => {
  const e = await fixture(t);
  e.workspace.approvalMode = "ask";
  const node = await e.submit("cancel-batch-save");
  let executed = false;
  const invocation = e.invoke(
    node,
    "web_search",
    { query: "one" },
    async () => {
      executed = true;
    },
  );
  await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
  const held = e.hold();
  const save = e.store.save.bind(e.store);
  let saving = false;
  e.store.save = async (...args) => {
    if (!saving && node.toolCalls![0].approval === "approved_tool") {
      saving = true;
      await held.promise;
    }
    return save(...args);
  };
  const approval = e.scheduler.approve(
    e.workspace.id,
    node.id,
    node.toolCalls![0].id,
    "approve_tool",
  );
  void approval.catch(() => {});
  await until(() => saving);
  await e.scheduler.cancel(e.workspace.id, node.id);
  held.release();
  await assert.rejects(approval, /批量同意未生效/);
  await assert.rejects(invocation, /abort/i);
  assert.equal(executed, false);
  assert.equal(node.toolCalls![0].status, "cancelled");
});

test("batch approval expires when approval settings change and does not return after toggling back", async (t) => {
  const e = await fixture(t);
  e.workspace.approvalMode = "ask";
  e.runtime.reviewTool = async () => {
    throw new Error("review unavailable");
  };
  const node = await e.submit("settings-batch");
  let effects = 0;
  const effect = async () => {
    effects++;
  };
  const first = e.invoke(node, "web_search", { query: "one" }, effect);
  await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
  await e.scheduler.approve(
    e.workspace.id,
    node.id,
    node.toolCalls![0].id,
    "approve_tool",
  );
  await first;
  await e.scheduler.configureWorkspace(e.workspace.id, {
    approvalMode: "auto",
  });
  await e.scheduler.configureWorkspace(e.workspace.id, { approvalMode: "ask" });
  const next = e.invoke(node, "web_search", { query: "two" }, effect);
  await until(() => node.toolCalls?.[1]?.status === "awaiting_approval");
  assert.equal(effects, 1);
  await e.scheduler.approve(
    e.workspace.id,
    node.id,
    node.toolCalls![1].id,
    "deny",
  );
  await next;
});

test("retrying a card drops its batch grant and rejects approvals from the previous revision", async (t) => {
  const e = await fixture(t);
  e.workspace.approvalMode = "ask";
  const node = await e.submit("retry-batch");
  let effects = 0;
  const effect = async () => {
    effects++;
  };
  const first = e.invoke(node, "web_search", { query: "one" }, effect);
  await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
  await e.scheduler.approve(
    e.workspace.id,
    node.id,
    node.toolCalls![0].id,
    "approve_tool",
  );
  await first;
  const oldRun = e.runs.get(node.prompt);
  await e.finish(node, "test failure");
  const retried = await e.scheduler.retry(e.workspace.id, node.id, {
    expectedRevision: 0,
    requestId: randomUUID(),
  });
  await until(() => e.runs.get(node.prompt) !== oldRun);
  const next = e.invoke(retried, "web_search", { query: "two" }, effect);
  await until(() => retried.toolCalls?.[0]?.status === "awaiting_approval");
  assert.equal(effects, 1);
  await assert.rejects(
    e.scheduler.approve(
      e.workspace.id,
      retried.id,
      retried.toolCalls![0].id,
      "approve_tool",
      0,
    ),
    /已失效/,
  );
  await e.scheduler.approve(
    e.workspace.id,
    retried.id,
    retried.toolCalls![0].id,
    "deny",
    retried.revision,
  );
  await next;
});

test("the batch approval API validates origin, decision and revision before granting the named tool", async (t) => {
  const e = await fixture(t);
  e.workspace.approvalMode = "ask";
  const node = await e.submit("http-batch");
  let effects = 0;
  const effect = async () => {
    effects++;
  };
  const first = e.invoke(node, "web_search", { query: "one" }, effect);
  await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
  const api = createApi(e.store, e.runtime, e.scheduler);
  const request = async (body: unknown, origin?: string) => {
    const incoming = Readable.from([
      Buffer.from(JSON.stringify(body)),
    ]) as IncomingMessage;
    Object.assign(incoming, {
      method: "POST",
      url: `/api/workspaces/${e.workspace.id}/nodes/${node.id}/approvals/${node.toolCalls![0].id}`,
      headers: {
        host: "127.0.0.1:9999",
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
    });
    let status = 0;
    const outgoing = {
      setHeader() {},
      writeHead(value: number) {
        status = value;
      },
      end() {},
    } as unknown as ServerResponse;
    await api(incoming, outgoing);
    return status;
  };
  assert.equal(
    await request({ decision: "approve_tool" }, "https://foreign.example"),
    403,
  );
  assert.equal(await request({ decision: "approve_all" }), 400);
  assert.equal(
    await request({ decision: "approve_tool", expectedRevision: 1 }),
    409,
  );
  assert.equal(effects, 0);
  assert.equal(
    await request({ decision: "approve_tool", expectedRevision: 0 }),
    200,
  );
  await first;
  await e.invoke(node, "web_search", { query: "two" }, effect);
  assert.equal(effects, 2);
});
