import assert from "node:assert/strict";
import { test } from "node:test";
import type { Node } from "@xyflow/react";
import {
  adoptUserNodes,
  nodeHasDimensions,
  type InternalNodeBase,
} from "@xyflow/system";
import { reconcileGraphNodes } from "./graph-nodes";

function card(id: string, response: string): Node {
  return {
    id,
    type: "turn",
    position: { x: 0, y: 0 },
    data: { response },
  };
}

test("streaming updates retain the dimensions that keep auto-sized cards visible", () => {
  const initial = [
    { ...card("a", "first"), measured: { width: 282, height: 218 } },
    { ...card("b", "second"), measured: { width: 282, height: 244 } },
  ];
  const nodeLookup = new Map<string, InternalNodeBase>();
  const parentLookup = new Map();
  adoptUserNodes(initial, nodeLookup, parentLookup);
  let current: Node[] = initial;
  for (let update = 0; update < 100; update++) {
    current = reconcileGraphNodes(current, [
      card("a", `first ${update}`),
      card("b", `second ${update}`),
    ]);
    adoptUserNodes(current, nodeLookup, parentLookup);
    assert.ok(nodeHasDimensions(nodeLookup.get("a")!));
    assert.ok(nodeHasDimensions(nodeLookup.get("b")!));
    assert.equal(nodeLookup.get("a")!.data.response, `first ${update}`);
    assert.deepEqual(nodeLookup.get("b")!.measured, {
      width: 282,
      height: 244,
    });
  }
});

test("new measurements and persisted positions are respected without interrupting a drag", () => {
  const current: Node[] = [
    {
      ...card("drag", "before"),
      measured: { width: 282, height: 218 },
      dragging: true,
      position: { x: 123, y: 456 },
    },
    {
      ...card("idle", "before"),
      measured: { width: 282, height: 218 },
    },
  ];
  const incoming = [
    card("drag", "after"),
    {
      ...card("idle", "after"),
      position: { x: 500, y: 600 },
      measured: { width: 282, height: 260 },
    },
  ];
  const reconciled = reconcileGraphNodes(current, incoming);
  assert.deepEqual(reconciled[0].position, { x: 123, y: 456 });
  assert.equal(reconciled[0].dragging, true);
  assert.equal(reconciled[0].data.response, "after");
  assert.deepEqual(reconciled[1].position, { x: 500, y: 600 });
  assert.deepEqual(reconciled[1].measured, { width: 282, height: 260 });
});

test("removed and replaced nodes never retain unrelated geometry", () => {
  const current = [
    { ...card("old", "old"), measured: { width: 282, height: 218 } },
    { ...card("replace", "old"), measured: { width: 282, height: 218 } },
  ];
  const incoming = [
    { ...card("replace", "new"), type: "compression", width: 56, height: 56 },
    card("new", "new"),
  ];
  const reconciled = reconcileGraphNodes(current, incoming);
  assert.deepEqual(reconciled, incoming);
  assert.equal(reconciled[0], incoming[0]);
  assert.equal(reconciled[1], incoming[1]);
});
