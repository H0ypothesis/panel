import type { ContextParent } from "../shared/types.ts";

/** Validate wire data without imposing an arbitrary branch-count limit. */
export function contextParentInput(
  value: unknown,
): ContextParent[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length)
    throw new Error("请选择至少一个上下文分支。");
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("上下文分支格式无效。");
    const { nodeId, contextCheckpointId, contextMode, revision } = item;
    if (typeof nodeId !== "string" || !nodeId.trim() || nodeId.length > 80)
      throw new Error("上下文分支节点无效。");
    if (seen.has(nodeId)) throw new Error("不能重复接入同一个分支节点。");
    seen.add(nodeId);
    if (
      contextCheckpointId !== undefined &&
      (typeof contextCheckpointId !== "string" ||
        !contextCheckpointId.trim() ||
        contextCheckpointId.length > 100)
    )
      throw new Error("上下文分支摘要无效。");
    if (contextMode !== undefined && contextMode !== "raw")
      throw new Error("上下文分支选择无效。");
    if (contextMode && contextCheckpointId !== undefined)
      throw new Error("原文和压缩摘要不能同时选择。");
    if (
      revision !== undefined &&
      (!Number.isSafeInteger(revision) || revision < 0)
    )
      throw new Error("上下文分支版本无效。");
    return { nodeId, contextCheckpointId, contextMode, revision };
  });
}

/** Omitted versions may replay a request; explicit versions must match its snapshot. */
export function contextParentsMatch(
  stored: ContextParent[] | undefined,
  input: ContextParent[] | undefined,
): boolean {
  if (!stored || !input) return stored === input;
  return (
    stored.length === input.length &&
    stored.every(
      (parent, i) =>
        parent.nodeId === input[i].nodeId &&
        parent.contextCheckpointId === input[i].contextCheckpointId &&
        parent.contextMode === input[i].contextMode &&
        (input[i].revision === undefined ||
          parent.revision === input[i].revision),
    )
  );
}
