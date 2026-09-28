import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ContextCheckpoint,
  ContextParent,
  TurnNode,
} from "../shared/types";
import { buildCompressionNodes } from "../shared/context-graph";
import {
  branchDraftHeight,
  canConnectDraftParent,
  draftConnectionParent,
  draftContextParents,
} from "./branch-draft";

const node = (
  id: string,
  status: TurnNode["status"] = "completed",
): TurnNode => ({
  id,
  parentId: status === "root" ? null : "root",
  prompt: id,
  response: "response",
  status,
  revision: 2,
  position: { x: 0, y: 0 },
  createdAt: 1,
  contextIds: [],
  config: { model: "demo/pi-demo", thinking: "off" },
  color: "sage",
});
const checkpoint: ContextCheckpoint = {
  id: "summary",
  version: 1,
  sourceHash: "hash",
  messageCount: 2,
  sources: [
    { nodeId: "root", revision: 2, messageCount: 1 },
    { nodeId: "a", revision: 2, messageCount: 1 },
  ],
  summary: "summary",
  model: "demo/pi-demo",
  thinking: "off",
  createdAt: 1,
  tokensBefore: 100,
  tokensAfter: 10,
};

test("legacy drafts retain their exact frozen source while multiple inputs retain order", () => {
  const draft = {
    parentId: "a",
    parentRevision: 2,
    contextCheckpointId: "summary",
  };
  assert.deepEqual(draftContextParents(draft), [
    {
      nodeId: "a",
      revision: 2,
      contextCheckpointId: "summary",
      contextMode: undefined,
    },
  ]);
  const parents: ContextParent[] = [
    { nodeId: "a", contextMode: "raw" },
    { nodeId: "b" },
  ];
  assert.equal(
    draftContextParents({ ...draft, contextParents: parents }),
    parents,
  );
});

test("connector resolution rejects live, stale and automatic merge summaries", () => {
  const a = { ...node("a"), preparedCompaction: checkpoint };
  const nodes = [
    node("root", "root"),
    a,
    node("running", "running"),
    node("queued", "queued"),
    { ...node("stale"), contextStale: true },
    { ...node("stale-child"), parentId: "stale" },
  ];
  const entries = buildCompressionNodes(nodes);
  assert.deepEqual(draftConnectionParent("a", nodes, entries), {
    nodeId: "a",
    revision: 2,
    contextMode: "raw",
  });
  assert.deepEqual(draftConnectionParent(entries[0].id, nodes, entries), {
    nodeId: "a",
    revision: 2,
    contextCheckpointId: "summary",
  });
  for (const id of ["running", "queued", "stale", "stale-child", "missing"])
    assert.equal(draftConnectionParent(id, nodes, entries), undefined);
  assert.equal(
    draftConnectionParent(entries[0].id, nodes, [
      { ...entries[0], usable: false },
    ]),
    undefined,
  );
  assert.equal(
    draftConnectionParent(entries[0].id, nodes, [
      { ...entries[0], kind: "merge" },
    ]),
    undefined,
  );
});

test("exact duplicates are blocked but a different summary replaces the same branch", () => {
  const parents: ContextParent[] = [
    { nodeId: "a", revision: 2, contextMode: "raw" },
  ];
  assert.equal(canConnectDraftParent(parents, { ...parents[0] }), false);
  assert.equal(
    canConnectDraftParent(parents, {
      nodeId: "a",
      revision: 2,
      contextCheckpointId: "summary",
    }),
    true,
  );
  assert.equal(
    canConnectDraftParent(parents, {
      nodeId: "a",
      revision: 3,
      contextMode: "raw",
    }),
    true,
  );
  const many = Array.from({ length: 150 }, (_, index) => ({
    nodeId: `source-${index}`,
  }));
  assert.equal(canConnectDraftParent(many, { nodeId: "another" }), true);
});

test("source list reserves bounded scroll space without limiting input count", () => {
  assert.ok(branchDraftHeight(0, 0, 2) > branchDraftHeight(0, 0, 1));
  assert.ok(branchDraftHeight(0, 0, 2, true) > branchDraftHeight(0, 0, 2));
  assert.equal(branchDraftHeight(0, 0, 1, true), branchDraftHeight(0, 0, 1));
  assert.equal(branchDraftHeight(0, 0, 5), branchDraftHeight(0, 0, 100));
});
