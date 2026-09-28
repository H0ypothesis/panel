import {
  ancestorPath,
  type ContextCheckpoint,
  type ContextParent,
  type TurnNode,
} from "./types";

export const COMPRESSION_NODE_SIZE = 56;
const CARD_WIDTH = 282;
const CIRCLE_FOOTPRINT_WIDTH = 86;
const GAP = 24;

/** All successful manual summaries remain independent canvas entry points. */
export function preparedCheckpoints(node: TurnNode): ContextCheckpoint[] {
  const checkpoints = new Map<string, ContextCheckpoint>();
  for (const checkpoint of node.preparedCompactions ?? []) {
    checkpoints.set(checkpoint.id, checkpoint);
  }
  if (node.preparedCompaction) {
    checkpoints.set(node.preparedCompaction.id, node.preparedCompaction);
  }
  return [...checkpoints.values()].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
}

export function checkpointMatchesPath(
  checkpoint: ContextCheckpoint,
  nodes: TurnNode[],
  parentId: string,
): boolean {
  const path = ancestorPath(nodes, parentId);
  return (
    checkpoint.sources.length > 0 &&
    checkpoint.sources.length <= path.length &&
    path.every((node) => !node.contextStale) &&
    checkpoint.sources.every(
      (source, index) =>
        path[index]?.id === source.nodeId &&
        (path[index]?.revision ?? 0) === source.revision,
    )
  );
}

export function compressionNodeId(parentId: string, checkpointId: string) {
  return `compression:${encodeURIComponent(parentId)}:${encodeURIComponent(checkpointId)}`;
}

export interface CompressionGraphEntry {
  id: string;
  parentId: string;
  checkpoint: ContextCheckpoint;
  position: { x: number; y: number };
  usable: boolean;
  /** Automatically compressed merged inputs, shown immediately before the answer. */
  kind?: "merge";
  contextParents?: ContextParent[];
  targetNodeId?: string;
}

type Bounds = { x: number; y: number; width: number; height: number };

function collides(a: Bounds, b: Bounds) {
  return (
    a.x < b.x + b.width + GAP &&
    a.x + a.width + GAP > b.x &&
    a.y < b.y + b.height + GAP &&
    a.y + a.height + GAP > b.y
  );
}

/** Virtual nodes never change raw-message ancestry or persisted card positions. */
export function buildCompressionNodes(
  nodes: TurnNode[],
): CompressionGraphEntry[] {
  const entries: CompressionGraphEntry[] = [];
  const occupied: Bounds[] = nodes.map((node) => ({
    ...node.position,
    width: CARD_WIDTH,
    height: node.status === "root" ? 203 : 218,
  }));
  for (const node of nodes) {
    if ((node.contextParents?.length ?? 0) < 2) continue;
    const checkpoint = node.compactions?.find(
      (item) => item.purpose === "merge",
    );
    if (!checkpoint) continue;
    const bounds: Bounds = {
      x: node.position.x - 140,
      y: node.position.y + (218 - COMPRESSION_NODE_SIZE) / 2,
      width: CIRCLE_FOOTPRINT_WIDTH,
      height: COMPRESSION_NODE_SIZE,
    };
    for (;;) {
      const collisions = occupied.filter((other) => collides(bounds, other));
      if (!collisions.length) break;
      bounds.y = Math.max(
        ...collisions.map((other) => other.y + other.height + GAP),
      );
    }
    occupied.push(bounds);
    entries.push({
      id: compressionNodeId(node.id, checkpoint.id),
      parentId: node.id,
      checkpoint,
      position: { x: bounds.x, y: bounds.y },
      usable: false,
      kind: "merge",
      contextParents: node.contextParents,
      targetNodeId: node.id,
    });
  }
  const manualOffset = entries.length;
  const candidates = nodes
    .flatMap((parent) =>
      preparedCheckpoints(parent).map((checkpoint) => ({
        parent,
        checkpoint,
        child: nodes.find(
          (node) =>
            (node.parentId === parent.id &&
              node.requestedContextCheckpointId === checkpoint.id) ||
            node.contextParents?.some(
              (input) =>
                input.nodeId === parent.id &&
                input.contextCheckpointId === checkpoint.id,
            ),
        ),
      })),
    )
    .map((candidate, index) => ({ ...candidate, index }));
  // Keep used entry points aligned with their children before placing spare
  // summaries. Their output indices preserve chronological numbering in the UI.
  candidates.sort(
    (a, b) => Number(Boolean(b.child)) - Number(Boolean(a.child)),
  );
  for (const { parent, checkpoint, child, index } of candidates) {
    const target = child ?? parent;
    const bounds: Bounds = {
      x: parent.position.x + 330,
      y:
        target.position.y +
        ((target.status === "root" ? 203 : 218) - COMPRESSION_NODE_SIZE) / 2,
      width: CIRCLE_FOOTPRINT_WIDTH,
      height: COMPRESSION_NODE_SIZE,
    };
    for (;;) {
      const collisions = occupied.filter((other) => collides(bounds, other));
      if (!collisions.length) break;
      bounds.y = Math.max(
        ...collisions.map((other) => other.y + other.height + GAP),
      );
    }
    occupied.push(bounds);
    entries[manualOffset + index] = {
      id: compressionNodeId(parent.id, checkpoint.id),
      parentId: parent.id,
      checkpoint,
      position: { x: bounds.x, y: bounds.y },
      usable:
        parent.status === "completed" &&
        checkpointMatchesPath(checkpoint, nodes, parent.id),
    };
  }
  return entries;
}
