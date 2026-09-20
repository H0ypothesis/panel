import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ContextReference } from "../shared/types.ts";
import { prepareAttachments } from "./attachments.ts";
import { buildContext } from "./context.ts";
import { contextReferencePrompt } from "./context-references.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type StoredNode, type StoredWorkspace } from "./store.ts";
import { importWorkspace } from "./workspace-import.ts";

function fixture() {
  const workspace: StoredWorkspace = createWorkspace("引用探索", "共同背景");
  const root = workspace.nodes[0];
  const source: StoredNode = {
    ...structuredClone(root),
    id: "reference-source",
    parentId: root.id,
    prompt: "另一个分支的方案",
    response: "改写后的新方案，不应覆盖引用快照",
    status: "completed",
    revision: 3,
    contextIds: [root.id],
  };
  const reference: ContextReference = {
    nodeId: source.id,
    revision: 1,
    prompt: "旧版问题",
    response: "提交时的旧版回答",
  };
  const target: StoredNode = {
    ...structuredClone(root),
    id: "reference-target",
    parentId: root.id,
    prompt: "根据所选资料继续分析",
    response: "分析结论",
    status: "completed",
    revision: 2,
    contextIds: [root.id],
    contextReferences: [reference],
    messages: [
      {
        role: "user",
        content: contextReferencePrompt("根据所选资料继续分析", [reference]),
        timestamp: 100,
      },
      fauxAssistantMessage("分析结论", { timestamp: 101 }),
    ],
  };
  target.previousRuns = [
    { ...structuredClone(target), revision: 1, archivedAt: 102 },
  ];
  workspace.nodes.push(source, target);
  return { version: 1, workspace };
}

test("imports reference snapshots and remaps existing sources consistently across run history", () => {
  const exported = fixture();
  const before = structuredClone(exported);
  const imported = importWorkspace(exported);
  const source = imported.nodes[1];
  const target = imported.nodes[2];
  assert.deepEqual(exported, before);
  assert.notEqual(source.id, exported.workspace.nodes[1].id);
  assert.deepEqual(target.contextReferences, [
    { ...before.workspace.nodes[2].contextReferences![0], nodeId: source.id },
  ]);
  assert.deepEqual(
    target.previousRuns![0].contextReferences,
    target.contextReferences,
  );
  assert.deepEqual(target.messages, exported.workspace.nodes[2].messages);
  assert.equal(target.parentId, imported.nodes[0].id);
  assert.deepEqual(target.contextIds, [imported.nodes[0].id]);
  const context = JSON.stringify(buildContext(imported, target.id).messages);
  assert.match(context, /提交时的旧版回答/);
  assert.doesNotMatch(context, /改写后的新方案/);

  const store = new Store("/tmp/panel-reference-import-snapshot-only");
  store.data.workspaces.push(imported);
  assert.deepEqual(
    store.snapshot().workspaces[0].nodes[2].contextReferences,
    target.contextReferences,
  );
});

test("deleted reference sources receive independent historical IDs without losing their text", () => {
  const exported = fixture();
  const oldSourceId = exported.workspace.nodes[1].id;
  exported.workspace.nodes.splice(1, 1);
  const first = importWorkspace(exported);
  const target = first.nodes[1];
  const reference = target.contextReferences![0];
  assert.match(reference.nodeId, /^historical-reference:/);
  assert.notEqual(reference.nodeId, oldSourceId);
  assert.equal(
    first.nodes.some((node) => node.id === reference.nodeId),
    false,
  );
  assert.equal(
    target.previousRuns![0].contextReferences![0].nodeId,
    reference.nodeId,
  );
  assert.equal(reference.response, "提交时的旧版回答");

  const second = importWorkspace({ version: 1, workspace: first });
  const nextReference = second.nodes[1].contextReferences![0];
  assert.match(nextReference.nodeId, /^historical-reference:/);
  assert.notEqual(nextReference.nodeId, reference.nodeId);
  assert.equal(
    second.nodes.some((node) => node.id === nextReference.nodeId),
    false,
  );
  assert.equal(
    second.nodes[1].previousRuns![0].contextReferences![0].nodeId,
    nextReference.nodeId,
  );
  assert.equal(nextReference.response, reference.response);
});

test("source failures or stale state do not invalidate snapshots from earlier revisions", () => {
  const exported = fixture();
  const source = exported.workspace.nodes[1];
  const target = exported.workspace.nodes[2];
  source.status = "failed";
  source.contextStale = true;
  const previousReference = target.previousRuns![0].contextReferences![0];
  previousReference.revision = 0;
  previousReference.response = "更早一次运行使用的内容";
  const imported = importWorkspace(exported);
  const current = imported.nodes[2].contextReferences![0];
  const previous = imported.nodes[2].previousRuns![0].contextReferences![0];
  assert.equal(current.nodeId, imported.nodes[1].id);
  assert.equal(previous.nodeId, current.nodeId);
  assert.equal(current.revision, 1);
  assert.equal(current.response, "提交时的旧版回答");
  assert.equal(previous.revision, 0);
  assert.equal(previous.response, "更早一次运行使用的内容");
});

test("distinct deleted sources stay distinct while shared sources map to one historical ID", () => {
  const exported = fixture();
  const target = exported.workspace.nodes[2];
  target.contextReferences!.push({
    nodeId: "another-deleted-source",
    revision: 0,
    prompt: "另一个旧问题",
    response: "另一个历史回答",
  });
  target.previousRuns![0].contextReferences!.push(
    structuredClone(target.contextReferences![1]),
  );
  exported.workspace.nodes.splice(1, 1);
  const imported = importWorkspace(exported).nodes[1];
  const ids = imported.contextReferences!.map((reference) => reference.nodeId);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(
    imported.previousRuns![0].contextReferences!.map(
      (reference) => reference.nodeId,
    ),
    ids,
  );
});

test("rejects malformed reference snapshots in current and historical runs", () => {
  const original = fixture();
  const reference = original.workspace.nodes[2].contextReferences![0];
  const malformed: unknown[] = [
    null,
    {},
    [null],
    [{ ...reference, nodeId: " " }],
    [{ ...reference, nodeId: 1 }],
    [{ ...reference, revision: -1 }],
    [{ ...reference, revision: 0.5 }],
    [{ ...reference, revision: Number.NaN }],
    [{ ...reference, revision: undefined }],
    [{ ...reference, prompt: {} }],
    [{ ...reference, response: null }],
    [reference, reference],
    Array.from({ length: 21 }, (_, index) => ({
      ...reference,
      nodeId: `source-${index}`,
    })),
  ];
  for (const value of malformed) {
    for (const historical of [false, true]) {
      const source = structuredClone(original);
      const current = source.workspace.nodes[2];
      const run = historical ? current.previousRuns![0] : current;
      run.contextReferences = value as ContextReference[];
      assert.throws(() => importWorkspace(source), /引用卡片/);
    }
  }
});

test("imports only reference text and provenance, stripping arbitrary attached state", () => {
  const exported = fixture();
  Object.assign(exported.workspace.nodes[2].contextReferences![0], {
    toolCalls: [{ name: "bash", arguments: { command: "unwanted" } }],
    attachments: [{ path: "/unexpected" }],
    contextReferences: [{ response: "递归引用不应携带" }],
  });
  const reference = importWorkspace(exported).nodes[2].contextReferences![0];
  assert.deepEqual(Object.keys(reference).sort(), [
    "nodeId",
    "prompt",
    "response",
    "revision",
  ]);
});

test("missing provider transcripts rebuild reference snapshots together with attachments", async () => {
  const exported = fixture();
  const target = exported.workspace.nodes[2];
  delete target.messages;
  delete target.previousRuns![0].messages;
  target.attachmentData = await prepareAttachments([
    {
      name: "notes.txt",
      mediaType: "text/plain",
      data: Buffer.from("本轮自带附件的证据").toString("base64"),
    },
  ]);
  target.attachments = target.attachmentData.map((item) => item.metadata);
  exported.workspace.nodes.splice(1, 1);
  const imported = importWorkspace(exported);
  const restored = imported.nodes[1];
  const messages = JSON.stringify(buildContext(imported, restored.id).messages);
  assert.match(messages, /以下是从 JSON 导入的历史轮次/);
  assert.match(messages, /提交时的旧版回答/);
  assert.match(messages, /本轮自带附件的证据/);
  assert.match(messages, /historical-reference:/);
  assert.doesNotMatch(messages, /改写后的新方案/);
  assert.match(
    JSON.stringify(restored.previousRuns![0].messages),
    /提交时的旧版回答/,
  );
});

test("old exports do not invent reference fields", () => {
  const imported = importWorkspace({
    version: 1,
    workspace: createWorkspace("旧空间", "无引用"),
  });
  assert.equal(imported.nodes[0].contextReferences, undefined);
});
