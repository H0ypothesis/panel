import { MarkerType, type Edge } from "@xyflow/react";
import type { TurnNode } from "../shared/types";

/** References are visual links to saved snapshots, not additional branch inputs. */
export function buildReferenceEdges(
  nodes: TurnNode[],
  draft?: { id: string; referenceNodeIds: string[] } | null,
): Edge[] {
  const existing = new Set(nodes.map((node) => node.id));
  const targets = nodes.map((node) => ({
    id: node.id,
    references:
      node.contextReferences?.map((reference) => reference.nodeId) ?? [],
  }));
  if (draft) targets.push({ id: draft.id, references: draft.referenceNodeIds });
  return targets.flatMap(({ id: target, references }) =>
    [...new Set(references)]
      .filter((source) => source !== target && existing.has(source))
      .map(
        (source): Edge => ({
          id: `reference:${JSON.stringify([source, target])}`,
          source,
          target,
          sourceHandle: "reference-source",
          targetHandle: "reference-target",
          type: "default",
          className: "reference-edge",
          selectable: false,
          focusable: false,
          deletable: false,
          reconnectable: false,
          label: "@",
          labelStyle: { fill: "var(--branch-purple)", fontSize: 11 },
          labelBgStyle: { fill: "var(--canvas-control-background)" },
          style: {
            stroke: "var(--branch-purple)",
            strokeWidth: 1.5,
            strokeDasharray: "6 5",
          },
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: "var(--branch-purple)",
            width: 18,
            height: 18,
          },
        }),
      ),
  );
}
