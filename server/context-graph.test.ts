import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompressionNodes,
  checkpointMatchesPath,
  compressionNodeId,
  preparedCheckpoints,
} from "../shared/context-graph.ts";
import {
  DEFAULT_CONFIG,
  type ContextCheckpoint,
  type TurnNode,
} from "../shared/types.ts";
import { branchDraftPosition } from "../src/branch-draft.ts";

function node(id: string, parentId: string | null, x = 0, y = 0): TurnNode {
  return {
    id,
    parentId,
    prompt: id,
    response: "answer",
    status: parentId ? "completed" : "root",
    config: { ...DEFAULT_CONFIG },
    color: "sage",
    position: { x, y },
    contextIds: [],
    createdAt: 0,
  };
}
function checkpoint(
  id: string,
  nodes: TurnNode[],
  createdAt = 0,
): ContextCheckpoint {
  return {
    id,
    version: 1,
    sourceHash: id,
    messageCount: nodes.length,
    sources: nodes.map((node) => ({
      nodeId: node.id,
      revision: node.revision ?? 0,
      messageCount: 1,
    })),
    summary: "summary",
    model: DEFAULT_CONFIG.model,
    thinking: "medium",
    createdAt,
    tokensBefore: 10000,
    tokensAfter: 1000,
  };
}

test("manual summary nodes retain every successful checkpoint and deduplicate the latest", () => {
  const root = node("root", null);
  const parent = node("parent", "root", 360);
  const first = checkpoint("first", [root, parent], 1);
  const second = checkpoint("second", [root, parent], 2);
  parent.preparedCompactions = [second, first];
  parent.preparedCompaction = second;
  parent.compactions = [checkpoint("automatic", [root, parent], 3)];
  assert.deepEqual(
    preparedCheckpoints(parent).map((item) => item.id),
    ["first", "second"],
  );
  const entries = buildCompressionNodes([root, parent]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].id, compressionNodeId("parent", "first"));
  assert.equal(entries[0].usable, true);
  assert.equal(entries[1].position.x, parent.position.x + 330);
  assert.ok(entries[1].position.y >= entries[0].position.y + 56 + 24);
  assert.equal(parent.parentId, "root");
});

test("expired summaries remain visible without allowing branches or matching a sibling", () => {
  const root = node("root", null);
  const parent = node("parent", "root", 360);
  parent.preparedCompaction = checkpoint("summary", [root, parent]);
  const sibling = node("sibling", "root", 360, 300);
  assert.equal(
    checkpointMatchesPath(
      parent.preparedCompaction,
      [root, parent, sibling],
      sibling.id,
    ),
    false,
  );
  parent.revision = 1;
  const entries = buildCompressionNodes([root, parent, sibling]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].usable, false);
  parent.revision = 0;
  parent.contextStale = true;
  assert.equal(buildCompressionNodes([root, parent])[0].usable, false);
  parent.contextStale = false;
  parent.status = "running";
  assert.equal(buildCompressionNodes([root, parent])[0].usable, false);
});

test("new compressed branches leave the circle and its add button between both cards", () => {
  const root = node("root", null);
  const parent = node("parent", "root", 360, 100);
  parent.preparedCompaction = checkpoint("summary", [root, parent]);
  const child = node("child", "parent", 860, 200);
  child.requestedContextCheckpointId = "summary";
  const entries = buildCompressionNodes([root, parent, child]);
  const circle = entries[0];
  assert.equal(circle.position.y + 28, child.position.y + 109);
  assert.ok(circle.position.x >= parent.position.x + 282 + 24);
  assert.ok(circle.position.x + 86 + 24 <= child.position.x);
});

test("legacy narrow layouts move the circle below cards rather than covering them", () => {
  const root = node("root", null);
  const parent = node("parent", "root", 360);
  parent.preparedCompaction = checkpoint("summary", [root, parent]);
  const child = node("child", "parent", 720);
  child.requestedContextCheckpointId = "summary";
  const sibling = node("sibling", "parent", 720, 270);
  const circle = buildCompressionNodes([root, parent, child, sibling])[0];
  assert.ok(circle.position.y >= sibling.position.y + 218 + 24);
  assert.deepEqual(
    child.position,
    { x: 720, y: 0 },
    "existing card positions stay untouched",
  );
});

test("used summary keeps its child alignment ahead of spare summaries without renumbering", () => {
  const root = node("root", null);
  const parent = node("parent", "root", 360, 100);
  parent.preparedCompactions = [
    checkpoint("first", [root, parent], 1),
    checkpoint("second", [root, parent], 2),
    checkpoint("third", [root, parent], 3),
  ];
  parent.preparedCompaction = parent.preparedCompactions[2];
  const child = node("compressed-child", parent.id, 860, 100);
  child.requestedContextCheckpointId = "third";
  const sibling = node("raw-child", parent.id, 720, 380);
  const entries = buildCompressionNodes([root, parent, child, sibling]);
  assert.deepEqual(
    entries.map((entry) => entry.checkpoint.id),
    ["first", "second", "third"],
  );
  assert.equal(entries[2].position.y + 28, child.position.y + 109);
  assert.ok(entries[2].position.y + 56 + 24 <= sibling.position.y);
  assert.ok(entries[0].position.y >= entries[2].position.y + 56 + 24);
  assert.ok(entries[1].position.y >= sibling.position.y + 218 + 24);
});

test("summary drafts follow the circle origin and avoid existing cards and circles", () => {
  const root = node("root", null);
  const parent = node("parent", "root", 360);
  parent.preparedCompaction = checkpoint("summary", [root, parent]);
  const child = node("child", "parent", 860);
  child.requestedContextCheckpointId = "summary";
  const nodes = [root, parent, child];
  const circle = buildCompressionNodes(nodes)[0];
  const summaryDraft = branchDraftPosition(
    nodes,
    parent.position,
    circle.position,
  );
  assert.equal(summaryDraft.x, parent.position.x + 500);
  assert.ok(summaryDraft.y >= child.position.y + 218 + 24);
  const rawDraft = branchDraftPosition(nodes, parent.position);
  assert.equal(rawDraft.x, parent.position.x + 360);
  assert.ok(rawDraft.y >= circle.position.y + 56 + 24);
});

test("virtual ids cannot collide when persisted identifiers contain separators", () => {
  assert.notEqual(compressionNodeId("a:b", "c"), compressionNodeId("a", "b:c"));
});
