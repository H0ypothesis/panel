import type { BranchColor, RunConfig, TurnNode } from "../shared/types";
import {
  buildCompressionNodes,
  COMPRESSION_NODE_SIZE,
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
export function branchDraftHeight(fileCount: number, referenceCount = 0) {
  return (
    350 +
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
) {
  // Leave extra room for multiline validation or submission feedback.
  const height = branchDraftHeight(fileCount, referenceCount) + 48;
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
