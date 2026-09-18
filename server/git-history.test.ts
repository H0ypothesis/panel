import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  access,
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
import type {
  GitHistoryEntry,
  ModelOption,
  RunConfig,
  ToolCall,
} from "../shared/types.ts";
import { createPanelTools } from "./coding-tools.ts";
import type { RunEnvironment, Runtime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type StoredNode } from "./store.ts";

const config: RunConfig = { model: "test/git-history", thinking: "off" };
const model: ModelOption = {
  id: config.model,
  name: "Git history integration test",
  provider: "test",
  providerName: "Test",
  available: true,
  demo: false,
  thinkingLevels: ["off"],
  contextWindow: 128000,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function until(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for Git history integration state");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function nodeCommand(script: string) {
  return `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
}

async function fixture(t: TestContext, approvalMode: "ask" | "auto" = "auto") {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-git-history-integration-")),
  );
  const project = join(directory, "project");
  const stateDirectory = join(directory, "state");
  await mkdir(project);
  const store = new Store(stateDirectory);
  await store.init(false);
  const workspace = createWorkspace("Git history", "Record actual changes");
  workspace.workingDirectory = project;
  workspace.approvalMode = approvalMode;
  workspace.safetyModel = config.model;
  store.data.workspaces.push(workspace);
  const runs: Array<{
    environment: RunEnvironment;
    signal: AbortSignal;
    finish: () => void;
  }> = [];
  const runtime: Runtime = {
    models: () => [model],
    reviewTool: async () => ({ decision: "approve", reason: "Test approval" }),
    async run(_config, _history, _prompt, signal, _onText, environment) {
      assert.ok(environment);
      const finish = deferred();
      runs.push({ environment, signal, finish: finish.resolve });
      await finish.promise;
      signal.throwIfAborted();
      return { messages: [], response: "Finished" };
    },
  };
  const scheduler = new Scheduler(store, runtime);
  const tools = createPanelTools(project);
  t.after(async () => {
    scheduler.shutdown();
    for (const run of runs) run.finish();
    await delay(0);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  });

  const submit = async () => {
    const previousRuns = runs.length;
    const node = await scheduler.submit(workspace.id, {
      parentId: workspace.nodes[0].id,
      prompt: "Update the project files",
      config,
      requestId: randomUUID(),
    });
    await until(() => runs.length > previousRuns);
    return node;
  };
  const finish = async (node: StoredNode) => {
    runs.at(-1)!.finish();
    await until(() => Boolean(node.finishedAt));
    await store.save();
    // The scheduler releases its directory lock after its final save.
    await delay(0);
  };
  const invoke = async (
    name: string,
    args: Record<string, unknown>,
    id: string = randomUUID(),
  ) => {
    const run = runs.at(-1)!;
    const call = { id, name, arguments: args };
    const allowed = await run.environment.beforeToolCall(call);
    if (!allowed) return;
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool);
    try {
      const result = await run.environment.executeTool(call, () =>
        tool.execute(id, args, run.signal),
      );
      run.environment.onToolUpdate(id, { status: "completed" });
      return result;
    } catch (error) {
      run.environment.onToolUpdate(id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  return {
    directory,
    project,
    stateDirectory,
    store,
    workspace,
    scheduler,
    runs,
    submit,
    finish,
    invoke,
  };
}

function completedEntries(entries: GitHistoryEntry[] | undefined) {
  assert.ok(entries);
  assert.ok(entries.every((entry) => entry.status === "completed"));
  for (const entry of entries) {
    assert.match(entry.commit ?? "", /^[0-9a-f]{40,64}$/);
    assert.ok(entry.files.length > 0);
  }
  return entries;
}

test("approved writes, edits and shell deletions persist actual file changes with their card", async (t) => {
  const env = await fixture(t);
  const node = await env.submit();
  await env.invoke(
    "write",
    { path: "note.txt", content: "first\n" },
    "write-1",
  );
  await env.invoke(
    "edit",
    { path: "note.txt", edits: [{ oldText: "first", newText: "second" }] },
    "edit-1",
  );
  await env.invoke(
    "bash",
    { command: nodeCommand('require("node:fs").unlinkSync("note.txt")') },
    "delete-1",
  );
  const entries = completedEntries(env.workspace.gitHistory);
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => entry.files),
    [
      [{ path: "note.txt", status: "added" }],
      [{ path: "note.txt", status: "modified" }],
      [{ path: "note.txt", status: "deleted" }],
    ],
  );
  assert.deepEqual(
    entries.map((entry) => entry.toolCallId),
    ["write-1", "edit-1", "delete-1"],
  );
  assert.equal(new Set(entries.map((entry) => entry.commit)).size, 3);
  for (const entry of entries) {
    assert.equal(entry.nodeId, node.id);
    assert.equal(entry.nodeRevision, 0);
    assert.equal(entry.nodePrompt, node.prompt);
    assert.equal(entry.workingDirectory, env.project);
  }
  await env.finish(node);
  const restarted = new Store(env.stateDirectory);
  await restarted.init(false);
  assert.deepEqual(restarted.workspace(env.workspace.id).gitHistory, entries);
  assert.deepEqual(restarted.snapshot().workspaces[0].gitHistory, entries);
});

test("read tools, read-only shell commands and identical writes create no Git record", async (t) => {
  const env = await fixture(t);
  await writeFile(join(env.project, "existing.txt"), "unchanged\n");
  const node = await env.submit();
  await env.invoke("read", { path: "existing.txt" });
  await env.invoke("bash", { command: "pwd" });
  await env.invoke("write", { path: "existing.txt", content: "unchanged\n" });
  assert.deepEqual(env.workspace.gitHistory ?? [], []);
  assert.equal(
    await readFile(join(env.project, "existing.txt"), "utf8"),
    "unchanged\n",
  );
  await env.finish(node);
});

test("Git recording never bypasses the one-time authorization gate", async (t) => {
  const env = await fixture(t, "ask");
  const node = await env.submit();
  const call: Pick<ToolCall, "id" | "name" | "arguments"> = {
    id: "unapproved-write",
    name: "write",
    arguments: { path: "blocked.txt", content: "blocked" },
  };
  let executed = false;
  await assert.rejects(
    env.runs[0].environment.executeTool(call, async () => {
      executed = true;
      await writeFile(join(env.project, "blocked.txt"), "blocked");
    }),
    /授权/,
  );
  assert.equal(executed, false);
  const denied = env.invoke("write", call.arguments, "denied-write");
  await until(() => node.toolCalls?.[0]?.status === "awaiting_approval");
  assert.deepEqual(env.workspace.gitHistory ?? [], []);
  await env.scheduler.approve(
    env.workspace.id,
    node.id,
    "denied-write",
    "deny",
  );
  await denied;
  assert.deepEqual(env.workspace.gitHistory ?? [], []);
  await assert.rejects(readFile(join(env.project, "blocked.txt")), {
    code: "ENOENT",
  });
  await env.finish(node);
});

test("a shell command that writes before failing still records its actual update", async (t) => {
  const env = await fixture(t);
  const node = await env.submit();
  await assert.rejects(
    env.invoke(
      "bash",
      {
        command: nodeCommand(
          'require("node:fs").writeFileSync("failed.txt", "saved before failure"); process.exit(9)',
        ),
      },
      "failed-command",
    ),
    /code 9/,
  );
  const entries = completedEntries(env.workspace.gitHistory);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].toolCallId, "failed-command");
  assert.equal(entries[0].nodeId, node.id);
  assert.deepEqual(entries[0].files, [{ path: "failed.txt", status: "added" }]);
  assert.equal(
    await readFile(join(env.project, "failed.txt"), "utf8"),
    "saved before failure",
  );
  await env.finish(node);
});

test("cancelling a shell command retains changes already written to disk", async (t) => {
  const env = await fixture(t);
  const node = await env.submit();
  const outcome = env
    .invoke(
      "bash",
      {
        command: nodeCommand(
          'require("node:fs").writeFileSync("cancelled.txt", "saved before cancellation"); setInterval(() => {}, 1000)',
        ),
      },
      "cancelled-command",
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await until(async () => {
    try {
      await access(join(env.project, "cancelled.txt"));
      return true;
    } catch {
      return false;
    }
  });
  await env.scheduler.cancel(env.workspace.id, node.id);
  assert.ok(await outcome);
  const entries = completedEntries(env.workspace.gitHistory);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].nodeId, node.id);
  assert.deepEqual(entries[0].files, [
    { path: "cancelled.txt", status: "added" },
  ]);
  await env.finish(node);
});

test("regeneration and card deletion retain records and distinguish node revisions", async (t) => {
  const env = await fixture(t);
  const node = await env.submit();
  await env.invoke(
    "write",
    { path: "version.txt", content: "first" },
    "same-id",
  );
  await env.finish(node);
  const regenerated = await env.scheduler.regenerate(
    env.workspace.id,
    node.id,
    {
      prompt: "Update again",
      config,
      requestId: randomUUID(),
      expectedRevision: 0,
    },
  );
  await until(() => env.runs.length === 2);
  await env.invoke(
    "write",
    { path: "version.txt", content: "second" },
    "same-id",
  );
  await env.finish(regenerated);
  const entries = structuredClone(completedEntries(env.workspace.gitHistory));
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((entry) => entry.nodeRevision),
    [0, 1],
  );
  assert.ok(entries.every((entry) => entry.nodeId === node.id));
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 2);
  await env.scheduler.deleteNode(env.workspace.id, node.id, {
    expectedRevision: 1,
    expectedNodeIds: [node.id],
  });
  assert.equal(
    env.workspace.nodes.some((entry) => entry.id === node.id),
    false,
  );
  assert.deepEqual(env.workspace.gitHistory, entries);
  const restarted = new Store(env.stateDirectory);
  await restarted.init(false);
  assert.deepEqual(restarted.workspace(env.workspace.id).gitHistory, entries);
});

for (const phase of ["prepare", "capture"] as const) {
  test(`a ${phase} failure reports the missing snapshot without failing or repeating an authorized write`, async (t) => {
    const env = await fixture(t);
    const node = await env.submit();
    t.mock.method(env.store.gitSnapshots, phase, async () => {
      throw new Error(`simulated ${phase} failure`);
    });
    const call = {
      id: "write-during-snapshot-failure",
      name: "write",
      arguments: { path: "once.txt", content: "once\n" },
    };
    const execution = env.runs[0].environment;
    assert.equal(await execution.beforeToolCall(call), true);
    let executions = 0;
    const write = async () => {
      executions++;
      await appendFile(join(env.project, "once.txt"), "once\n");
      return "written";
    };
    assert.equal(await execution.executeTool(call, write), "written");
    assert.equal(executions, 1);
    assert.equal(
      await readFile(join(env.project, "once.txt"), "utf8"),
      "once\n",
    );
    assert.equal(env.workspace.gitHistory?.length, 1);
    const entry = env.workspace.gitHistory![0];
    assert.equal(entry.status, "failed");
    assert.match(entry.error ?? "", new RegExp(`simulated ${phase} failure`));
    assert.equal(entry.commit, undefined);
    await assert.rejects(execution.executeTool(call, write), /授权/);
    assert.equal(executions, 1);
    assert.equal(env.workspace.gitHistory?.length, 1);
    execution.onToolUpdate(call.id, { status: "completed" });
    await env.finish(node);
    const saved = JSON.parse(
      await readFile(join(env.stateDirectory, "state.json"), "utf8"),
    );
    assert.equal(saved.workspaces[0].gitHistory[0].status, "failed");
  });
}

test("restart recovers a pending snapshot without replaying the tool or exposing its baseline", async (t) => {
  const env = await fixture(t);
  const node = await env.submit();
  await env.finish(node);
  const baseline = await env.store.gitSnapshots.prepare(
    env.workspace.id,
    env.project,
  );
  const entry: GitHistoryEntry = {
    id: randomUUID(),
    nodeId: node.id,
    nodeRevision: node.revision ?? 0,
    nodePrompt: node.prompt,
    toolCallId: "interrupted-write",
    toolName: "write",
    workingDirectory: env.project,
    createdAt: Date.now(),
    summary: "正在记录文件更新",
    status: "recording",
    files: [],
  };
  node.status = "running";
  node.toolCalls = [
    {
      id: entry.toolCallId,
      name: "write",
      arguments: { path: "recovered.txt", content: "written once" },
      status: "running",
      startedAt: Date.now(),
    },
  ];
  env.workspace.gitHistory = [entry];
  env.store.workspace(env.workspace.id).pendingGitSnapshots = [
    { historyId: entry.id, baseline },
  ];
  await env.store.save();
  // Model the process stopping after the file effect but before its finally block.
  await writeFile(join(env.project, "recovered.txt"), "written once");
  const restarted = new Store(env.stateDirectory);
  await restarted.init(false);
  const restored = restarted.workspace(env.workspace.id);
  const entries = completedEntries(restored.gitHistory);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, entry.id);
  assert.equal(entries[0].interrupted, true);
  assert.equal(entries[0].nodeId, node.id);
  assert.equal(entries[0].parentCommit, baseline.commit);
  assert.deepEqual(entries[0].files, [
    { path: "recovered.txt", status: "added" },
  ]);
  assert.deepEqual(restored.pendingGitSnapshots, []);
  assert.equal(
    restored.nodes.find((item) => item.id === node.id)?.status,
    "failed",
  );
  assert.equal(
    "pendingGitSnapshots" in restarted.snapshot().workspaces[0],
    false,
  );
  assert.equal(
    await readFile(join(env.project, "recovered.txt"), "utf8"),
    "written once",
  );
  const restartedAgain = new Store(env.stateDirectory);
  await restartedAgain.init(false);
  assert.deepEqual(
    restartedAgain.workspace(env.workspace.id).gitHistory,
    entries,
  );
});
