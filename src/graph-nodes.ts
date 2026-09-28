import type { Node } from "@xyflow/react";

/** Keep React Flow's measured geometry when server snapshots refresh node data. */
export function reconcileGraphNodes<T extends Node>(
  current: T[],
  incoming: T[],
): T[] {
  const previousById = new Map(current.map((node) => [node.id, node]));
  return incoming.map((node) => {
    const previous = previousById.get(node.id);
    if (!previous || previous.type !== node.type) return node;
    // Omitting measured resets handle bounds in React Flow and hides auto-sized
    // cards until ResizeObserver runs again. Streaming must update their data
    // without restarting that measurement cycle on every snapshot.
    return {
      ...node,
      measured: node.measured ?? previous.measured,
      ...(previous.dragging
        ? { position: previous.position, dragging: true }
        : {}),
    };
  });
}
