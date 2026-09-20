import type { TurnNode } from "./types.ts";

/** A settled turn can be continued without replacing its history or file effects. */
export function canBranchFrom(
  node: Pick<TurnNode, "status" | "contextStale" | "retryRestore"> | undefined,
): boolean {
  return Boolean(
    node &&
      !node.contextStale &&
      !node.retryRestore &&
      ["root", "completed", "failed", "cancelled"].includes(node.status),
  );
}
