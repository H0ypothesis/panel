import assert from "node:assert/strict";
import test from "node:test";
import type { AppState, Workspace, TurnNode } from "../shared/types";
import type { AppStatePatch } from "../shared/state-events";
import { applyStatePatch, reconcileAppState } from "./state-sync.ts";

const node = (id: string): TurnNode => ({
  id,
  parentId: null,
  prompt: id,
  response: "saved",
  status: "completed",
  config: { model: "test", thinking: "off" },
  color: "sage",
  position: { x: 0, y: 0 },
  contextIds: [],
  createdAt: 1,
});
const workspace = (id: string, nodes: TurnNode[]): Workspace => ({
  id,
  example: false,
  title: id,
  description: "",
  nodes,
  createdAt: 1,
  updatedAt: 1,
});
const fixture = (): AppState => ({
  instanceId: "server",
  revision: 10,
  workspaces: [
    workspace("one", [node("a"), node("b")]),
    workspace("two", [node("c")]),
  ],
});
function patchFor(state: AppState, changed: TurnNode): AppStatePatch {
  const { nodes: _, ...metadata } = state.workspaces[0];
  return {
    instanceId: state.instanceId,
    baseRevision: state.revision,
    revision: state.revision + 1,
    workspaceIds: state.workspaces.map((w) => w.id),
    removedWorkspaceIds: [],
    workspaces: [
      {
        workspace: metadata,
        nodes: [changed],
        removedNodeIds: [],
        nodeIds: state.workspaces[0].nodes.map((n) => n.id),
      },
    ],
  };
}

test("stream patches replace only changed cards and preserve stable sibling/workspace identity", () => {
  const state = fixture();
  const patch = patchFor(state, {
    ...state.workspaces[0].nodes[0],
    response: "streaming",
  });
  const next = applyStatePatch(state, patch)!;
  assert.equal(next.workspaces[0].nodes[0].response, "streaming");
  assert.equal(next.workspaces[0].nodes[1], state.workspaces[0].nodes[1]);
  assert.equal(next.workspaces[1], state.workspaces[1]);
  assert.equal(state.workspaces[0].nodes[0].response, "saved");
});

test("patches support addition, removal, ordering and clearing errors without resurrecting stale nodes", () => {
  const state = fixture();
  state.storageError = "previous save failed";
  const patch = patchFor(state, node("new"));
  patch.removedWorkspaceIds = ["two"];
  patch.workspaceIds = ["three", "one"];
  patch.workspaces[0].removedNodeIds = ["a"];
  patch.workspaces[0].nodeIds = ["new", "b"];
  const { nodes, ...metadata } = workspace("three", [node("new-root")]);
  patch.workspaces.push({
    workspace: metadata,
    nodes,
    removedNodeIds: [],
    nodeIds: ["new-root"],
  });
  const next = applyStatePatch(state, patch)!;
  assert.deepEqual(
    next.workspaces.map((w) => w.id),
    ["three", "one"],
  );
  assert.deepEqual(
    next.workspaces[1].nodes.map((n) => n.id),
    ["new", "b"],
  );
  assert.equal(next.storageError, undefined);
  assert.equal(next.workspaces[1].nodes[1], state.workspaces[0].nodes[1]);
});

test("wrong baselines, restarts and incomplete patches require a fresh full snapshot", () => {
  const state = fixture();
  const patch = patchFor(state, node("a"));
  assert.equal(applyStatePatch(null, patch), null);
  assert.equal(applyStatePatch(state, { ...patch, baseRevision: 9 }), null);
  assert.equal(
    applyStatePatch(state, { ...patch, instanceId: "restarted" }),
    null,
  );
  const incomplete = structuredClone(patch);
  incomplete.workspaces[0].nodeIds.push("missing");
  assert.equal(applyStatePatch(state, incomplete), null);
});

test("stream baseline remains independent when an API reply arrives ahead of streamed changes", () => {
  const stream = fixture();
  const advanced = {
    ...stream,
    revision: 12,
    workspaces: [
      workspace("one", [{ ...node("a"), response: "latest" }, node("b")]),
      stream.workspaces[1],
    ],
  };
  const pending = applyStatePatch(
    stream,
    patchFor(stream, { ...node("a"), response: "middle" }),
  )!;
  assert.equal(reconcileAppState(advanced, pending), advanced);
  const caughtUp = applyStatePatch(
    pending,
    patchFor(pending, { ...node("a"), response: "latest" }),
  )!;
  assert.equal(reconcileAppState(advanced, caughtUp), advanced);
});

test("full snapshots and updated tool arrays retain unchanged records without losing removed fields", () => {
  const state = fixture();
  state.workspaces[0].nodes[0].error = "old";
  state.workspaces[0].nodes[0].toolCalls = [
    {
      id: "tool",
      name: "read",
      arguments: JSON.parse('{"__proto__":{"safe":"data"}}'),
      status: "completed",
      startedAt: 1,
    },
  ];
  const next = structuredClone(state);
  next.revision++;
  delete next.workspaces[0].nodes[0].error;
  next.workspaces[0].nodes[0].response = "updated";
  const merged = reconcileAppState(state, next)!;
  assert.equal(
    merged.workspaces[0].nodes[0].toolCalls,
    state.workspaces[0].nodes[0].toolCalls,
  );
  assert.equal(
    merged.workspaces[0].nodes[0].config,
    state.workspaces[0].nodes[0].config,
  );
  assert.equal(merged.workspaces[1], state.workspaces[1]);
  assert.equal("error" in merged.workspaces[0].nodes[0], false);
  assert.equal(reconcileAppState(merged, structuredClone(merged)), merged);
});

test("delayed HTTP replies cannot replace the current SSE instance after restart", () => {
  const old = fixture();
  const restarted = { ...fixture(), instanceId: "restarted", revision: 1 };
  const current = reconcileAppState(old, restarted, "restarted");
  assert.equal(current, restarted);
  assert.equal(
    reconcileAppState(current, { ...old, revision: 999 }, "restarted"),
    restarted,
  );
  assert.equal(reconcileAppState(null, old, "restarted"), null);
});

test("streamed answers retain persisted computer screenshots and target metadata", () => {
  const state = fixture();
  const tool = {
    id: "screenshot",
    name: "computer_use_call",
    arguments: { tool: "screenshot" },
    status: "completed" as const,
    startedAt: 1,
    images: [
      {
        id: "capture",
        url: "/api/workspaces/one/nodes/a/tool-images/screenshot/0?revision=0",
        mimeType: "image/png",
      },
    ],
    computerUse: {
      scope: "window" as const,
      targetLabel: "Safari · 文档",
      windowId: 42,
    },
  };
  state.workspaces[0].nodes[0].toolCalls = [tool];
  const changed = structuredClone(state.workspaces[0].nodes[0]);
  changed.response += " more";
  const patched = applyStatePatch(state, patchFor(state, changed))!;
  const reconciled = reconcileAppState(state, patched)!;
  assert.equal(reconciled.workspaces[0].nodes[0].toolCalls?.[0], tool);
  assert.equal(
    reconciled.workspaces[0].nodes[0].toolCalls?.[0].images,
    tool.images,
  );
  assert.deepEqual(
    reconciled.workspaces[0].nodes[0].toolCalls?.[0].computerUse,
    tool.computerUse,
  );
});
