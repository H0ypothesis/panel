import type {
  BranchColor,
  ContextCheckpoint,
  ContextParent,
  RunConfig,
  TurnNode,
} from "../shared/types";
import { ancestorPath } from "../shared/types";
import { canBranchFrom } from "../shared/node-branching";
import {
  buildCompressionNodes,
  COMPRESSION_NODE_SIZE,
  preparedCheckpoints,
  type CompressionGraphEntry,
} from "../shared/context-graph";

export type CanvasBranchDraft = {
  id: string;
  workspaceId: string;
  parentId: string;
  parentRevision: number;
  parentTitle: string;
  parentPosition: { x: number; y: number };
  /** A circle freezes the exact summary used when this draft is submitted. */
  contextCheckpointId?: string;
  /** An explicit card entry before a summary retains its original context. */
  contextMode?: "raw";
  /** Complete, ordered branch inputs, including the original parent. */
  contextParents?: ContextParent[];
  /** A prepared summary of all branch inputs, used for this draft's answer. */
  mergedCheckpoint?: ContextCheckpoint;
  color: BranchColor;
  text: string;
  files: File[];
  referenceNodeIds: string[];
  config: RunConfig;
  requestId: string;
  error: string;
  focusVersion: number;
};

/** Include the bounded, scrollable attachment list when reserving canvas space. */
export function branchDraftHeight(
  fileCount: number,
  referenceCount = 0,
  parentCount = 1,
  mergedSummaryOpen = false,
) {
  return (
    374 +
    (parentCount > 1 ? Math.min(parentCount * 28, 112) + 24 : 0) +
    (parentCount >= 2 ? 44 : 0) +
    (parentCount >= 2 && mergedSummaryOpen ? 160 : 0) +
    (fileCount ? Math.min(fileCount * 47, 158) + 7 : 0) +
    (referenceCount ? Math.min(referenceCount * 34, 110) + 25 : 0)
  );
}

/** Reserve space for the full editor without moving existing conversation nodes. */
export function branchDraftPosition(
  nodes: TurnNode[],
  parentPosition: { x: number; y: number },
  compressionPosition?: { x: number; y: number },
  fileCount = 0,
  referenceCount = 0,
  parentCount = 1,
  mergedSummaryOpen = false,
) {
  // Leave extra room for multiline validation or submission feedback.
  const height =
    branchDraftHeight(
      fileCount,
      referenceCount,
      parentCount,
      mergedSummaryOpen,
    ) + 48;
  const x = compressionPosition
    ? Math.max(
        parentPosition.x + 500,
        compressionPosition.x + COMPRESSION_NODE_SIZE + 80,
      )
    : parentPosition.x + 360;
  let y = compressionPosition
    ? compressionPosition.y + COMPRESSION_NODE_SIZE / 2 - height / 2
    : parentPosition.y;
  const occupied = [
    ...nodes.map((node) => ({
      ...node.position,
      width: 282,
      height: node.status === "root" ? 203 : 218,
    })),
    ...buildCompressionNodes(nodes).map((node) => ({
      ...node.position,
      width: 86,
      height: COMPRESSION_NODE_SIZE,
    })),
  ];
  for (;;) {
    const collisions = occupied.filter(
      (node) =>
        x < node.x + node.width + 24 &&
        x + 320 + 24 > node.x &&
        y < node.y + node.height + 24 &&
        y + height + 24 > node.y,
    );
    if (!collisions.length) return { x, y };
    y = Math.max(...collisions.map((node) => node.y + node.height + 32));
  }
}

export function draftContextParents(
  draft: Pick<
    CanvasBranchDraft,
    | "contextParents"
    | "parentId"
    | "parentRevision"
    | "contextCheckpointId"
    | "contextMode"
  >,
): ContextParent[] {
  return draft.contextParents?.length
    ? draft.contextParents
    : [
        {
          nodeId: draft.parentId,
          revision: draft.parentRevision,
          contextCheckpointId: draft.contextCheckpointId,
          contextMode: draft.contextMode,
        },
      ];
}

/** Translate the visible output connector into the exact branch entry it represents. */
export function draftConnectionParent(
  sourceId: string,
  nodes: TurnNode[],
  compressionNodes: CompressionGraphEntry[],
): ContextParent | undefined {
  const compression = compressionNodes.find((entry) => entry.id === sourceId);
  if (compression && (!compression.usable || compression.kind === "merge"))
    return;
  const node = nodes.find(
    (entry) => entry.id === (compression?.parentId ?? sourceId),
  );
  if (!canBranchFrom(node) || !node) return;
  if (!ancestorPath(nodes, node.id).every(canBranchFrom)) return;
  return {
    nodeId: node.id,
    revision: node.revision ?? 0,
    ...(compression
      ? { contextCheckpointId: compression.checkpoint.id }
      : preparedCheckpoints(node).length
        ? { contextMode: "raw" as const }
        : {}),
  };
}

/** Switching between a card and one of its summaries replaces that input. */
export function canConnectDraftParent(
  parents: ContextParent[],
  candidate: ContextParent,
): boolean {
  return !parents.some(
    (parent) =>
      parent.nodeId === candidate.nodeId &&
      parent.contextCheckpointId === candidate.contextCheckpointId &&
      parent.contextMode === candidate.contextMode &&
      parent.revision === candidate.revision,
  );
}
