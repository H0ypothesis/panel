import type { AppState, TurnNode, Workspace } from "../shared/types";
import type { AppStatePatch } from "../shared/state-events";

/** Keep unchanged JSON values stable so streaming does not invalidate every card. */
function shareValue<T>(previous: T, next: T): T {
  if (previous === next) return previous;
  if (
    !previous ||
    !next ||
    typeof previous !== "object" ||
    typeof next !== "object"
  )
    return next;
  if (Array.isArray(previous) !== Array.isArray(next)) return next;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let unchanged = keys.length === Object.keys(before).length;
  const result: Record<string, unknown> = Array.isArray(next)
    ? ([] as unknown as Record<string, unknown>)
    : { ...after };
  for (const key of keys) {
    result[key] = shareValue(before[key], after[key]);
    if (!Object.hasOwn(before, key) || result[key] !== before[key])
      unchanged = false;
  }
  return unchanged ? previous : (result as T);
}

export function reconcileAppState(
  current: AppState | null,
  next: AppState,
  streamInstanceId?: string,
): AppState | null {
  // Ignore delayed HTTP replies from the process replaced by the live stream.
  if (streamInstanceId && next.instanceId !== streamInstanceId) return current;
  if (!current || current.instanceId !== next.instanceId) return next;
  if (next.revision < current.revision) return current;
  const existing = new Map(
    current.workspaces.map((workspace) => [workspace.id, workspace]),
  );
  const workspaces = next.workspaces.map((workspace) => {
    const previous = existing.get(workspace.id);
    if (!previous || previous === workspace) return workspace;
    const byId = new Map(previous.nodes.map((node) => [node.id, node]));
    const nodes = workspace.nodes.map(
      (node) => shareValue(byId.get(node.id), node)!,
    );
    return shareValue(previous, { ...workspace, nodes });
  });
  return shareValue(current, { ...next, workspaces });
}

/** Apply against the SSE baseline, separately from optimistic edits/API replies. */
export function applyStatePatch(
  current: AppState | null,
  patch: AppStatePatch,
): AppState | null {
  if (
    !current ||
    current.instanceId !== patch.instanceId ||
    current.revision !== patch.baseRevision ||
    patch.revision <= patch.baseRevision
  )
    return null;
  const workspaces = new Map(
    current.workspaces.map((workspace) => [workspace.id, workspace]),
  );
  for (const id of patch.removedWorkspaceIds) workspaces.delete(id);
  for (const change of patch.workspaces) {
    const previous = workspaces.get(change.workspace.id);
    const nodes = new Map<string, TurnNode>(
      previous?.nodes.map((node) => [node.id, node]),
    );
    for (const id of change.removedNodeIds) nodes.delete(id);
    for (const node of change.nodes) nodes.set(node.id, node);
    if (
      new Set(change.nodeIds).size !== change.nodeIds.length ||
      change.nodeIds.length !== nodes.size ||
      change.nodeIds.some((id) => !nodes.has(id))
    )
      return null;
    workspaces.set(change.workspace.id, {
      ...change.workspace,
      nodes: change.nodeIds.map((id) => nodes.get(id)!),
    });
  }
  if (
    new Set(patch.workspaceIds).size !== patch.workspaceIds.length ||
    patch.workspaceIds.length !== workspaces.size ||
    patch.workspaceIds.some((id) => !workspaces.has(id))
  )
    return null;
  return {
    instanceId: patch.instanceId,
    revision: patch.revision,
    ...(patch.storageError === undefined
      ? {}
      : { storageError: patch.storageError }),
    workspaces: patch.workspaceIds.map(
      (id) => workspaces.get(id)!,
    ) as Workspace[],
  };
}
