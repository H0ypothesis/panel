import type { BranchColor, RunConfig, TurnNode } from "../shared/types";

export type CanvasBranchDraft = {
  id: string;
  workspaceId: string;
  parentId: string;
  parentRevision: number;
  parentTitle: string;
  parentPosition: { x: number; y: number };
  color: BranchColor;
  text: string;
  config: RunConfig;
  requestId: string;
  error: string;
  focusVersion: number;
};

/** Reserve space for the full editor without moving existing conversation nodes. */
export function branchDraftPosition(
  nodes: TurnNode[],
  parentPosition: { x: number; y: number },
) {
  const x = parentPosition.x + 360;
  let y = parentPosition.y;
  for (;;) {
    const collisions = nodes.filter(
      (node) =>
        x < node.position.x + 282 + 24 &&
        x + 320 + 24 > node.position.x &&
        y < node.position.y + (node.status === "root" ? 203 : 218) + 24 &&
        y + 300 + 24 > node.position.y,
    );
    if (!collisions.length) return { x, y };
    y = Math.max(
      ...collisions.map(
        (node) => node.position.y + (node.status === "root" ? 203 : 218) + 32,
      ),
    );
  }
}
