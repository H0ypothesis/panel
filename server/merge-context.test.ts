import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import {
  ancestorPath,
  layoutTree,
  type ContextCheckpoint,
  type ModelOption,
  type RunConfig,
} from "../shared/types.ts";
import { buildContext } from "./context.ts";
import { contextSourceHash } from "./compaction.ts";
import { contextParentInput } from "./context-parents.ts";
import type { RunContextOptions, Runtime } from "./runtime.ts";
import { createApi } from "./api.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type StoredNode, type StoredWorkspace } from "./store.ts";
import { importWorkspace } from "./workspace-import.ts";

const config: RunConfig = { model: "test/merge", thinking: "off" };
function add(
  workspace: StoredWorkspace,
  id: string,
  parentId: string,
): StoredNode {
  const context = buildContext(workspace, parentId);
  const node: StoredNode = {
    ...workspace.nodes[0],
    id,
    parentId,
    status: "completed",
    config,
    prompt: `question-${id}`,
    response: `answer-${id}`,
    contextIds: context.ids,
    messages: [
      { role: "user", content: `question-${id}`, timestamp: 1 },
      fauxAssistantMessage(`answer-${id}`),
    ],
    position: {
      x: workspace.nodes.find((node) => node.id === parentId)!.position.x + 360,
      y: 0,
    },
  };
  workspace.nodes.push(node);
  return node;
}
function fixture() {
  const workspace: StoredWorkspace = createWorkspace("root", "background");
  const root = workspace.nodes[0];
  const shared = add(workspace, "shared", root.id);
  const a = add(workspace, "a", shared.id);
  const b = add(workspace, "b", shared.id);
  return { workspace, root, shared, a, b };
}
class MergeRuntime implements Runtime {
  calls: { history: Message[]; options: RunContextOptions }[] = [];
  gate?: Promise<void>;
  prepareContext?: Runtime["prepareContext"];
  models(): ModelOption[] {
    return [
      {
        id: config.model,
        name: "merge",
        provider: "test",
        providerName: "test",
        demo: true,
        available: true,
        thinkingLevels: ["off"],
        contextWindow: 16000,
      },
    ];
  }
  async run(...args: Parameters<Runtime["run"]>) {
    const [, history, prompt, signal, , , options] = args;
    this.calls.push({ history: structuredClone(history), options: options! });
    if (this.gate) await this.gate;
    signal.throwIfAborted();
    const messages: Message[] = [
      { role: "user", content: prompt, timestamp: Date.now() },
      fauxAssistantMessage("merged"),
    ];
    await options?.onMessages?.(messages);
    return { messages, response: "merged" };
  }
}
async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "panel-merge-"));
  const store = new Store(directory);
  await store.init(false);
  const data = fixture();
  store.data.workspaces.push(data.workspace);
  const runtime = new MergeRuntime();
  const scheduler = new Scheduler(store, runtime);
  t.after(async () => {
    scheduler.shutdown();
    await delay(30);
    await rm(directory, { recursive: true, force: true });
  });
  return { ...data, directory, store, runtime, scheduler };
}
async function settled(node: StoredNode) {
  for (let i = 0; i < 200; i++) {
    if (node.finishedAt) {
      await delay(20);
      return;
    }
    await delay(5);
  }
  assert.fail("run did not finish");
}
function checkpoint(
  workspace: StoredWorkspace,
  node: StoredNode,
): ContextCheckpoint {
  const context = buildContext(workspace, node.id);
  return {
    id: `summary-${node.id}`,
    version: 1,
    sources: context.sources,
    sourceHash: contextSourceHash(
      context.messages,
      context.sources,
      context.messages.length,
    ),
    messageCount: context.messages.length,
    summary: `summary of ${node.id}`,
    model: config.model,
    thinking: "off",
    createdAt: 1,
    tokensBefore: 200,
    tokensAfter: 20,
  };
}

test("DAG inputs preserve deterministic order, raw transcripts and unique common ancestors", () => {
  const { workspace, root, shared, a, b } = fixture();
  const before = structuredClone(workspace);
  const parents = [{ nodeId: a.id }, { nodeId: b.id }];
  const union = buildContext(workspace, a.id, parents);
  assert.deepEqual(union.ids, [root.id, shared.id, a.id, b.id]);
  assert.equal(union.messages.length, 7);
  assert.deepEqual(
    union.sources.map((source) => source.messageCount),
    [1, 2, 2, 2],
  );
  assert.deepEqual(workspace, before);
  const merged = add(workspace, "merged", a.id);
  merged.contextParents = parents;
  assert.deepEqual(
    ancestorPath(workspace.nodes, merged.id).map((node) => node.id),
    [...union.ids, merged.id],
  );
  b.contextParents = [{ nodeId: shared.id }, { nodeId: merged.id }];
  assert.throws(() => ancestorPath(workspace.nodes, merged.id), /循环/);
});

test("merge submit snapshots all inputs, ignores primary raw as aggregate mode, and replays idempotently", async (t) => {
  const { workspace, a, b, runtime, scheduler } = await setup(t);
  workspace.autoCompact = false;
  const request = {
    parentId: a.id,
    contextParents: [
      { nodeId: a.id, contextMode: "raw" as const },
      { nodeId: b.id },
    ],
    contextMode: "raw" as const,
    prompt: "merge",
    config,
    requestId: randomUUID(),
  };
  const node = await scheduler.submit(workspace.id, request);
  await settled(node);
  assert.equal(node.status, "completed");
  assert.equal(node.contextAutoCompact, true);
  assert.equal(node.contextMode, undefined);
  assert.deepEqual(
    node.contextParents?.map((parent) => parent.revision),
    [0, 0],
  );
  assert.equal(runtime.calls[0].options.mergeContext, true);
  assert.equal(runtime.calls[0].options.requestedCheckpointId, undefined);
  assert.equal(node.position.x, Math.max(a.position.x, b.position.x) + 500);
  assert.equal(await scheduler.submit(workspace.id, request), node);
  await assert.rejects(
    scheduler.submit(workspace.id, {
      ...request,
      contextParents: request.contextParents.slice().reverse(),
    }),
    /主分支|其他内容/,
  );
});

test("submit rejects malformed, duplicate, unknown, stale and active inputs without creating a run", async (t) => {
  const { workspace, a, b, scheduler } = await setup(t);
  const send = (parents: unknown) =>
    scheduler.submit(workspace.id, {
      parentId: a.id,
      contextParents: parents as never,
      prompt: "merge",
      config,
      requestId: randomUUID(),
    });
  for (const value of [
    [],
    null,
    {},
    [{ nodeId: a.id }, { nodeId: a.id }],
    [{ nodeId: a.id }, { nodeId: "missing" }],
    [{ nodeId: a.id, revision: 99 }, { nodeId: b.id }],
  ])
    await assert.rejects(send(value));
  b.status = "running";
  await assert.rejects(send([{ nodeId: a.id }, { nodeId: b.id }]), /尚未完成/);
  b.status = "completed";
  b.contextStale = true;
  await assert.rejects(send([{ nodeId: a.id }, { nodeId: b.id }]), /失效/);
  assert.equal(workspace.nodes.length, 4);
  assert.equal(
    contextParentInput(
      Array.from({ length: 1000 }, (_, i) => ({ nodeId: `branch-${i}` })),
    )?.length,
    1000,
  );
});

test("per-source checkpoints survive merge descendants and explicit raw suppresses only that input", async (t) => {
  const { workspace, a, b, runtime, scheduler } = await setup(t);
  const summary = checkpoint(workspace, b);
  b.preparedCompactions = [summary];
  const merged = await scheduler.submit(workspace.id, {
    parentId: a.id,
    contextParents: [
      { nodeId: a.id, contextMode: "raw" },
      { nodeId: b.id, contextCheckpointId: summary.id },
    ],
    prompt: "merge",
    config,
    requestId: randomUUID(),
  });
  await settled(merged);
  assert.deepEqual(
    runtime.calls[0].options.branchCheckpoints?.map((item) => item.id),
    [summary.id],
  );
  const child = await scheduler.submit(workspace.id, {
    parentId: merged.id,
    prompt: "continue",
    config,
    requestId: randomUUID(),
  });
  await settled(child);
  assert.deepEqual(
    runtime.calls[1].options.branchCheckpoints?.map((item) => item.id),
    [summary.id],
  );
  const raw = await scheduler.submit(workspace.id, {
    parentId: merged.id,
    contextMode: "raw",
    prompt: "raw",
    config,
    requestId: randomUUID(),
  });
  await settled(raw);
  assert.deepEqual(runtime.calls[2].options.branchCheckpoints, []);
});

test("secondary ancestry protects active merges, propagates staleness and cascades deletion", async (t) => {
  const { workspace, a, b, runtime, scheduler } = await setup(t);
  let release!: () => void;
  runtime.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const merged = await scheduler.submit(workspace.id, {
    parentId: a.id,
    contextParents: [{ nodeId: a.id }, { nodeId: b.id }],
    prompt: "merge",
    config,
    requestId: randomUUID(),
  });
  await assert.rejects(
    scheduler.regenerate(workspace.id, b.id, {
      prompt: "updated",
      config,
      requestId: randomUUID(),
      expectedRevision: 0,
    }),
    /后代.*运行/,
  );
  release();
  await settled(merged);
  runtime.gate = undefined;
  const updated = await scheduler.regenerate(workspace.id, b.id, {
    prompt: "updated",
    config,
    requestId: randomUUID(),
    expectedRevision: 0,
  });
  await settled(updated);
  const stale = workspace.nodes.find((node) => node.id === merged.id)!;
  assert.equal(stale.contextStale, true);
  const refreshed = await scheduler.regenerate(workspace.id, merged.id, {
    prompt: "merge again",
    config,
    requestId: randomUUID(),
    expectedRevision: 0,
  });
  await settled(refreshed);
  assert.deepEqual(
    refreshed.contextParents?.map((parent) => parent.revision),
    [0, 1],
  );
  assert.equal(refreshed.contextStale, false);
  await assert.rejects(
    scheduler.deleteNode(workspace.id, b.id, {
      expectedRevision: 1,
      expectedNodeIds: [b.id],
    }),
    /变化|改变/,
  );
  await scheduler.deleteNode(workspace.id, b.id, {
    expectedRevision: 1,
    expectedNodeIds: [b.id, refreshed.id],
  });
  assert.ok(workspace.nodes.some((node) => node.id === a.id));
  assert.ok(!workspace.nodes.some((node) => node.id === refreshed.id));
});

test("export imports remap the full DAG and per-input checkpoint IDs without mutating the export", () => {
  const { workspace, a, b } = fixture();
  const summary = checkpoint(workspace, b);
  b.preparedCompactions = [summary];
  const merged = add(workspace, "merged", a.id);
  merged.contextParents = [
    { nodeId: a.id, revision: 0 },
    { nodeId: b.id, revision: 0, contextCheckpointId: summary.id },
  ];
  merged.contextIds = buildContext(workspace, a.id, merged.contextParents).ids;
  const value = { version: 1, workspace };
  const before = structuredClone(value);
  const imported = importWorkspace(value);
  assert.deepEqual(value, before);
  const importedMerge = imported.nodes.find(
    (node) => node.prompt === merged.prompt,
  )!;
  const importedB = imported.nodes.find((node) => node.prompt === b.prompt)!;
  assert.equal(importedMerge.contextParents?.[1].nodeId, importedB.id);
  assert.equal(
    importedMerge.contextParents?.[1].contextCheckpointId,
    importedB.preparedCompactions?.[0].id,
  );
  assert.notEqual(
    importedMerge.contextParents?.[1].contextCheckpointId,
    summary.id,
  );
  assert.equal(buildContext(imported, importedMerge.id).ids.length, 5);
  b.contextParents = [{ nodeId: b.parentId! }, { nodeId: merged.id }];
  assert.throws(() => importWorkspace(value), /循环/);
});

test("auto-layout places merges after every input and moves primary descendants with them", () => {
  const { workspace, a, b } = fixture();
  const deeper = add(workspace, "deeper", b.id);
  const merged = add(workspace, "merged", a.id);
  merged.contextParents = [{ nodeId: a.id }, { nodeId: deeper.id }];
  const child = add(workspace, "child", merged.id);
  const layout = layoutTree(workspace.nodes);
  assert.equal(layout.get(merged.id)!.x, layout.get(deeper.id)!.x + 500);
  assert.equal(layout.get(child.id)!.x, layout.get(merged.id)!.x + 360);
});

test("merge API validates wire choices and advertises support without silently dropping inputs", async (t) => {
  const { workspace, a, b, store, runtime, scheduler } = await setup(t);
  const api = createApi(store, runtime, scheduler);
  async function call(method: string, path: string, body?: unknown) {
    const request = Readable.from(
      body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
    ) as IncomingMessage;
    Object.assign(request, {
      method,
      url: `/api${path}`,
      headers: { host: "127.0.0.1:9999", "content-type": "application/json" },
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
  }
  const capabilities = await call("GET", "/capabilities");
  assert.equal(capabilities.body.branchMerging, true);
  const request = {
    parentId: a.id,
    contextParents: [{ nodeId: a.id }, { nodeId: b.id }],
    prompt: "merge",
    config,
    requestId: randomUUID(),
  };
  const response = await call(
    "POST",
    `/workspaces/${workspace.id}/nodes`,
    request,
  );
  assert.equal(response.status, 201);
  const node = workspace.nodes.find(
    (item) => item.id === response.body.nodeId,
  )!;
  await settled(node);
  assert.equal(node.contextParents?.length, 2);
  for (const contextParents of [
    null,
    [],
    [{ nodeId: a.id }, { nodeId: b.id, revision: -1 }],
    [
      { nodeId: a.id },
      { nodeId: b.id, contextMode: "raw", contextCheckpointId: "summary" },
    ],
  ]) {
    const invalid = await call("POST", `/workspaces/${workspace.id}/nodes`, {
      ...request,
      contextParents,
      requestId: randomUUID(),
    });
    assert.equal(invalid.status, 400);
  }
});

test("imported merge inputs and archived selections survive storage reload with remapped summaries", async (t) => {
  const { workspace, a, b, store, directory } = await setup(t);
  const summary = checkpoint(workspace, b);
  b.preparedCompactions = [summary];
  const merged = add(workspace, "merged", a.id);
  merged.contextParents = [
    { nodeId: a.id, revision: 0 },
    { nodeId: b.id, revision: 0, contextCheckpointId: summary.id },
  ];
  merged.contextIds = buildContext(workspace, a.id, merged.contextParents).ids;
  merged.previousRuns = [{ ...structuredClone(merged), archivedAt: 2 }];
  const imported = importWorkspace({ version: 1, workspace });
  store.data.workspaces = [imported];
  await store.save();
  const reloaded = new Store(directory);
  await reloaded.init(false);
  assert.deepEqual(reloaded.workspace(imported.id).nodes, imported.nodes);
  const restored = imported.nodes.find(
    (node) => node.prompt === merged.prompt,
  )!;
  assert.equal(
    restored.previousRuns?.[0].contextParents?.[1].contextCheckpointId,
    restored.contextParents?.[1].contextCheckpointId,
  );
  assert.notEqual(restored.contextParents?.[1].contextCheckpointId, summary.id);
});

test("automatic merge summaries propagate to continuations including later replacement checkpoints", async (t) => {
  const { workspace, a, b, runtime, scheduler } = await setup(t);
  workspace.autoCompact = false;
  const sourceSummary = checkpoint(workspace, b);
  b.preparedCompactions = [sourceSummary];
  const merged = await scheduler.submit(workspace.id, {
    parentId: a.id,
    contextParents: [
      { nodeId: a.id },
      { nodeId: b.id, contextCheckpointId: sourceSummary.id },
    ],
    prompt: "merge",
    config,
    requestId: randomUUID(),
  });
  await settled(merged);
  const initial = {
    ...checkpoint(workspace, merged),
    id: "aggregate",
    purpose: "merge" as const,
  };
  const latest = {
    ...initial,
    id: "latest-tool-checkpoint",
    purpose: undefined,
  };
  merged.compactions = [initial, latest];
  merged.contextState = {
    status: "compacted",
    checkpointId: latest.id,
    updatedAt: 1,
  };
  const child = await scheduler.submit(workspace.id, {
    parentId: merged.id,
    prompt: "continue",
    config,
    requestId: randomUUID(),
  });
  await settled(child);
  assert.equal(child.effectiveContextCheckpointId, latest.id);
  assert.equal(child.contextAutoCompact, true);
  assert.equal(runtime.calls[1].options.requestedCheckpointId, latest.id);
  const raw = await scheduler.submit(workspace.id, {
    parentId: merged.id,
    prompt: "raw",
    contextMode: "raw",
    config,
    requestId: randomUUID(),
  });
  await settled(raw);
  assert.equal(runtime.calls[2].options.mergeContext, false);
  assert.equal(raw.effectiveContextCheckpointId, undefined);
});

test("manual compression of merged history retains branch projections, topology and overflow support", async (t) => {
  const { workspace, a, b, runtime, scheduler } = await setup(t);
  const sourceSummary = checkpoint(workspace, b);
  b.preparedCompactions = [sourceSummary];
  const merged = await scheduler.submit(workspace.id, {
    parentId: a.id,
    contextParents: [
      { nodeId: a.id, contextMode: "raw" },
      { nodeId: b.id, contextCheckpointId: sourceSummary.id },
    ],
    prompt: "merge",
    config,
    requestId: randomUUID(),
  });
  await settled(merged);
  const models = runtime.models();
  runtime.models = () => models.map((model) => ({ ...model, demo: false }));
  let preparation: RunContextOptions | undefined;
  runtime.prepareContext = async (_config, _history, _signal, options) => {
    preparation = options;
    return checkpoint(workspace, merged);
  };
  await scheduler.compactContext(workspace.id, merged.id, {
    config,
    expectedRevision: 0,
    requestId: randomUUID(),
  });
  assert.equal(preparation?.mergeContext, true);
  assert.deepEqual(
    preparation?.branchCheckpoints?.map((item) => item.id),
    [sourceSummary.id],
  );
  assert.equal(
    preparation?.contextBranches?.find((branch) => branch.nodeId === a.id)
      ?.contextMode,
    "raw",
  );
});

test("a single remaining inlet inherits a source summary without falsely claiming a new explicit selection", async (t) => {
  const { workspace, a, runtime, scheduler } = await setup(t);
  const summary = checkpoint(workspace, a);
  a.preparedCompactions = [summary];
  a.effectiveContextCheckpointId = summary.id;
  const request = {
    parentId: a.id,
    contextParents: [{ nodeId: a.id }],
    prompt: "continue",
    config,
    requestId: randomUUID(),
  };
  const node = await scheduler.submit(workspace.id, request);
  await settled(node);
  assert.equal(node.requestedContextCheckpointId, undefined);
  assert.equal(node.effectiveContextCheckpointId, summary.id);
  assert.equal(await scheduler.submit(workspace.id, request), node);
  const raw = await scheduler.regenerate(workspace.id, node.id, {
    prompt: "raw",
    config,
    requestId: randomUUID(),
    expectedRevision: 0,
    contextMode: "raw",
  });
  await settled(raw);
  assert.equal(raw.requestedContextCheckpointId, undefined);
  assert.equal(raw.effectiveContextMode, "raw");
  assert.deepEqual(runtime.calls[1].options.branchCheckpoints, []);
});

function overallPreparation(runtime: MergeRuntime) {
  const models = runtime.models();
  runtime.models = () => models.map((model) => ({ ...model, demo: false }));
  const preparations: { history: Message[]; options: RunContextOptions }[] = [];
  runtime.prepareContext = async (_config, history, signal, options) => {
    signal.throwIfAborted();
    preparations.push({ history: structuredClone(history), options });
    return {
      id: randomUUID(),
      version: 1,
      sourceHash: contextSourceHash(history, options.sources, history.length),
      sources: structuredClone(options.sources),
      messageCount: history.length,
      summary: "all selected branches",
      model: config.model,
      thinking: "off",
      createdAt: Date.now(),
      tokensBefore: 200,
      tokensAfter: 20,
    };
  };
  return preparations;
}

test("overall draft preparation deduplicates and binds every source, is private, and is adopted by answer plus continuation", async (t) => {
  const { workspace, a, b, shared, runtime, scheduler, store } = await setup(t);
  const c = add(workspace, "c", shared.id);
  const sourceSummary = checkpoint(workspace, b);
  b.preparedCompactions = [sourceSummary];
  const originals = structuredClone(workspace.nodes);
  const preparations = overallPreparation(runtime);
  const input = {
    parentId: a.id,
    contextParents: [
      { nodeId: a.id, revision: 0, contextMode: "raw" as const },
      { nodeId: b.id, revision: 0, contextCheckpointId: sourceSummary.id },
      { nodeId: c.id, revision: 0 },
    ],
    config,
    requestId: randomUUID(),
  };
  const summary = await scheduler.compactMergeContext(workspace.id, input);
  assert.equal(summary.purpose, "merge");
  assert.deepEqual(workspace.nodes, originals);
  assert.equal(preparations.length, 1);
  assert.equal(preparations[0].history.length, 9);
  assert.equal(preparations[0].options.mergeContext, true);
  assert.deepEqual(
    preparations[0].options.branchCheckpoints?.map((cp) => cp.id),
    [sourceSummary.id],
  );
  assert.equal(preparations[0].options.contextBranches?.length, 3);
  assert.equal(
    preparations[0].options.contextBranches?.find(
      (branch) => branch.nodeId === a.id,
    )?.contextMode,
    "raw",
  );
  assert.equal(
    "mergePreparationRequests" in store.snapshot().workspaces[0],
    false,
  );
  assert.deepEqual(
    await scheduler.compactMergeContext(workspace.id, input),
    summary,
  );
  assert.equal(preparations.length, 1);
  const submission = {
    ...input,
    requestId: randomUUID(),
    prompt: "answer all",
    mergedContextCheckpointId: summary.id,
  };
  const merged = await scheduler.submit(workspace.id, submission);
  await settled(merged);
  assert.equal(merged.status, "completed");
  assert.deepEqual(merged.compactions, [summary]);
  assert.equal(merged.effectiveContextCheckpointId, summary.id);
  assert.equal(runtime.calls[0].options.requestedCheckpointId, summary.id);
  assert.ok(
    runtime.calls[0].options.checkpoints?.some((cp) => cp.id === summary.id),
  );
  assert.equal(
    (await scheduler.submit(workspace.id, submission)).id,
    merged.id,
  );
  await assert.rejects(
    scheduler.submit(workspace.id, {
      ...submission,
      mergedContextCheckpointId: undefined,
    }),
    /请求 ID/,
  );
  const child = await scheduler.submit(workspace.id, {
    parentId: merged.id,
    prompt: "continue",
    config,
    requestId: randomUUID(),
  });
  await settled(child);
  assert.equal(runtime.calls[1].options.requestedCheckpointId, summary.id);
  const regenerated = await scheduler.regenerate(workspace.id, merged.id, {
    prompt: "answer differently",
    config,
    requestId: randomUUID(),
    expectedRevision: 0,
  });
  await settled(regenerated);
  assert.equal(runtime.calls[2].options.requestedCheckpointId, summary.id);
  assert.deepEqual(regenerated.compactions, [summary]);
});

test("overall summary rejects altered mode, model, order, revision, history and foreign checkpoint IDs", async (t) => {
  const { workspace, a, b, runtime, scheduler } = await setup(t);
  overallPreparation(runtime);
  const input = {
    parentId: a.id,
    contextParents: [
      { nodeId: a.id, revision: 0 },
      { nodeId: b.id, revision: 0 },
    ],
    config,
    requestId: randomUUID(),
  };
  const summary = await scheduler.compactMergeContext(workspace.id, input);
  const submission = {
    ...input,
    requestId: randomUUID(),
    prompt: "answer",
    mergedContextCheckpointId: summary.id,
  };
  await assert.rejects(
    scheduler.submit(workspace.id, {
      ...submission,
      contextParents: [
        { nodeId: a.id, revision: 0, contextMode: "raw" },
        input.contextParents[1],
      ],
    }),
    /整体摘要/,
  );
  await assert.rejects(
    scheduler.submit(workspace.id, {
      ...submission,
      parentId: b.id,
      contextParents: [...input.contextParents].reverse(),
    }),
    /整体摘要/,
  );
  await assert.rejects(
    scheduler.submit(workspace.id, {
      ...submission,
      mergedContextCheckpointId: "unrelated",
    }),
    /整体摘要/,
  );
  const models = runtime.models();
  runtime.models = () => [...models, { ...models[0], id: "test/other" }];
  await assert.rejects(
    scheduler.submit(workspace.id, {
      ...submission,
      config: { ...config, model: "test/other" },
    }),
    /整体摘要/,
  );
  await assert.rejects(
    scheduler.compactMergeContext(workspace.id, {
      ...input,
      contextParents: [{ nodeId: a.id }, { nodeId: b.id, contextMode: "raw" }],
    }),
    /请求 ID/,
  );
  a.messages![0] = {
    role: "user",
    content: "changed without revision",
    timestamp: 1,
  };
  await assert.rejects(scheduler.submit(workspace.id, submission), /整体摘要/);
  b.revision = 1;
  await assert.rejects(scheduler.submit(workspace.id, submission), /更新/);
  assert.equal(runtime.calls.length, 0);
});

test("in-flight overall preparation is idempotent, protects every ancestor, and cancellation discards late model replies", async (t) => {
  const { workspace, a, b, shared, runtime, scheduler } = await setup(t);
  overallPreparation(runtime);
  const prepare = runtime.prepareContext!;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  runtime.prepareContext = async (...args) => {
    calls++;
    const cp = await prepare(...args);
    started();
    await gate;
    return cp;
  };
  const input = {
    parentId: a.id,
    contextParents: [{ nodeId: a.id }, { nodeId: b.id }],
    config,
    requestId: randomUUID(),
  };
  const first = scheduler.compactMergeContext(workspace.id, input);
  const rejected = assert.rejects(first, /停止|abort/i);
  await ready;
  const duplicate = scheduler.compactMergeContext(workspace.id, input);
  const duplicateRejected = assert.rejects(duplicate, /停止|abort/i);
  await assert.rejects(
    scheduler.regenerate(workspace.id, shared.id, {
      prompt: "change",
      config,
      requestId: randomUUID(),
      expectedRevision: 0,
    }),
    /仍在运行/,
  );
  await assert.rejects(
    scheduler.deleteNode(workspace.id, b.id, {
      expectedRevision: 0,
      expectedNodeIds: [b.id],
    }),
    /仍在运行/,
  );
  await assert.rejects(
    scheduler.deleteWorkspace(workspace.id, {
      expectedNodeIds: workspace.nodes.map((node) => node.id),
    }),
    /仍有任务/,
  );
  await scheduler.cancelMergeContext(workspace.id, input.requestId);
  release();
  await Promise.all([rejected, duplicateRejected]);
  assert.equal(calls, 1);
  assert.equal(workspace.mergePreparationRequests?.[0].status, "cancelled");
  assert.equal(workspace.mergePreparationRequests?.[0].checkpoint, undefined);
  await assert.rejects(
    scheduler.compactMergeContext(workspace.id, input),
    /停止/,
  );
  assert.equal(calls, 1);
});

test("cancel-before-start is durable and prevents both late preparation and request-ID reuse", async (t) => {
  const { workspace, a, b, runtime, scheduler, store, directory } =
    await setup(t);
  const preparations = overallPreparation(runtime);
  const input = {
    parentId: a.id,
    contextParents: [{ nodeId: a.id }, { nodeId: b.id }],
    config,
    requestId: randomUUID(),
  };
  await scheduler.cancelMergeContext(workspace.id, input.requestId);
  await scheduler.cancelMergeContext(workspace.id, input.requestId);
  await assert.rejects(
    scheduler.compactMergeContext(workspace.id, input),
    /停止/,
  );
  await assert.rejects(
    scheduler.submit(workspace.id, { ...input, prompt: "answer" }),
    /请求 ID/,
  );
  assert.equal(preparations.length, 0);
  assert.equal(
    "cancelledMergePreparationIds" in store.snapshot().workspaces[0],
    false,
  );
  const reloaded = new Store(directory);
  await reloaded.init(false);
  const resumed = new Scheduler(reloaded, runtime);
  t.after(() => resumed.shutdown());
  await assert.rejects(
    resumed.compactMergeContext(workspace.id, input),
    /停止/,
  );
});

test("overall preparation reload preserves completed summaries and marks interrupted requests failed", async (t) => {
  const { workspace, a, b, runtime, scheduler, store, directory } =
    await setup(t);
  const preparations = overallPreparation(runtime);
  const input = {
    parentId: a.id,
    contextParents: [{ nodeId: a.id }, { nodeId: b.id }],
    config,
    requestId: randomUUID(),
  };
  const summary = await scheduler.compactMergeContext(workspace.id, input);
  const interruptedId = randomUUID();
  workspace.mergePreparationRequests!.push({
    ...structuredClone(workspace.mergePreparationRequests![0]),
    requestId: interruptedId,
    status: "compacting",
    checkpoint: undefined,
  });
  await store.save();
  const reloaded = new Store(directory);
  await reloaded.init(false);
  const resumed = new Scheduler(reloaded, runtime);
  t.after(() => resumed.shutdown());
  assert.deepEqual(
    await resumed.compactMergeContext(workspace.id, input),
    summary,
  );
  await assert.rejects(
    resumed.compactMergeContext(workspace.id, {
      ...input,
      requestId: interruptedId,
    }),
    /重启/,
  );
  assert.equal(preparations.length, 1);
});

test("export/import retains explicit own aggregate selection for regeneration and retry", async (t) => {
  const { workspace, a, b, runtime, scheduler, store } = await setup(t);
  overallPreparation(runtime);
  const input = {
    parentId: a.id,
    contextParents: [{ nodeId: a.id }, { nodeId: b.id }],
    config,
    requestId: randomUUID(),
  };
  const summary = await scheduler.compactMergeContext(workspace.id, input);
  const merged = await scheduler.submit(workspace.id, {
    ...input,
    requestId: randomUUID(),
    prompt: "combined",
    mergedContextCheckpointId: summary.id,
  });
  await settled(merged);
  const imported = importWorkspace({ version: 1, workspace });
  store.data.workspaces.push(imported);
  const restored = imported.nodes.find((node) => node.prompt === "combined")!;
  assert.equal(restored.compactions?.length, 1);
  const aggregateId = restored.compactions![0].id;
  assert.notEqual(aggregateId, summary.id);
  assert.equal(restored.requestedContextCheckpointId, aggregateId);
  assert.equal(restored.effectiveContextCheckpointId, aggregateId);
  const rerun = await scheduler.regenerate(imported.id, restored.id, {
    prompt: "combined again",
    config,
    requestId: randomUUID(),
    expectedRevision: 0,
  });
  await settled(rerun);
  assert.equal(
    runtime.calls.at(-1)?.options.requestedCheckpointId,
    aggregateId,
  );
  rerun.status = "failed";
  const retried = await scheduler.retry(imported.id, rerun.id, {
    requestId: randomUUID(),
    expectedRevision: 1,
  });
  await settled(retried);
  assert.equal(
    runtime.calls.at(-1)?.options.requestedCheckpointId,
    aggregateId,
  );
});

test("overall API returns full checkpoint, advertises support, validates inputs and cancels before start", async (t) => {
  const { workspace, a, b, store, runtime, scheduler } = await setup(t);
  overallPreparation(runtime);
  const api = createApi(store, runtime, scheduler);
  async function call(method: string, path: string, body?: unknown) {
    const request = Readable.from(
      body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
    ) as IncomingMessage;
    Object.assign(request, {
      method,
      url: `/api${path}`,
      headers: { host: "127.0.0.1:9999", "content-type": "application/json" },
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
    await api(request, response);
    return { status, body: JSON.parse(output) };
  }
  assert.equal(
    (await call("GET", "/capabilities")).body.mergeContextPreparation,
    true,
  );
  const path = `/workspaces/${workspace.id}/merge-context/compact`;
  const input = {
    parentId: a.id,
    contextParents: [{ nodeId: a.id }, { nodeId: b.id }],
    config,
    requestId: randomUUID(),
  };
  const result = await call("POST", path, input);
  assert.equal(result.status, 200);
  assert.equal(result.body.checkpoint.summary, "all selected branches");
  assert.equal(result.body.checkpoint.purpose, "merge");
  assert.equal(
    result.body.state.workspaces[0].mergePreparationRequests,
    undefined,
  );
  const submission = await call("POST", `/workspaces/${workspace.id}/nodes`, {
    ...input,
    prompt: "answer",
    requestId: randomUUID(),
    mergedContextCheckpointId: result.body.checkpoint.id,
  });
  assert.equal(submission.status, 201);
  await settled(
    workspace.nodes.find((node) => node.id === submission.body.nodeId)!,
  );
  assert.equal(
    runtime.calls.at(-1)?.options.requestedCheckpointId,
    result.body.checkpoint.id,
  );
  assert.equal(
    (
      await call("POST", path, {
        ...input,
        requestId: randomUUID(),
        contextParents: [input.contextParents[0]],
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("POST", path, {
        ...input,
        requestId: randomUUID(),
        contextParents: null,
      })
    ).status,
    400,
  );
  const cancelledId = randomUUID();
  assert.equal(
    (await call("POST", `${path}/${cancelledId}/cancel`, {})).status,
    200,
  );
  assert.equal(
    (await call("POST", path, { ...input, requestId: cancelledId })).status,
    409,
  );
});

test("overall preparation shutdown and invalid prefix results never publish an aggregate", async (t) => {
  const { workspace, a, b, runtime, scheduler } = await setup(t);
  overallPreparation(runtime);
  const fullPrepare = runtime.prepareContext!;
  runtime.prepareContext = async () => checkpoint(workspace, a);
  const input = {
    parentId: a.id,
    contextParents: [{ nodeId: a.id }, { nodeId: b.id }],
    config,
    requestId: randomUUID(),
  };
  await assert.rejects(
    scheduler.compactMergeContext(workspace.id, input),
    /来源校验/,
  );
  assert.equal(workspace.mergePreparationRequests?.[0].status, "failed");
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.prepareContext = async (...args) => {
    const summary = await fullPrepare(...args);
    started();
    await gate;
    return summary;
  };
  const running = scheduler.compactMergeContext(workspace.id, {
    ...input,
    requestId: randomUUID(),
  });
  const rejected = assert.rejects(running, /关闭/);
  await ready;
  scheduler.shutdown();
  release();
  await rejected;
  assert.equal(
    workspace.mergePreparationRequests?.at(-1)?.checkpoint,
    undefined,
  );
});
