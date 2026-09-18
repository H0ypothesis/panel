import type { ModelOption, TurnNode } from "./types.ts";

export interface ContextUsage {
  tokens: number;
  limit: number | null;
  percentage: number | null;
  stale: boolean;
}

// This is the same conservative visible-text heuristic used in the inspector.
// Provider usage is cumulative across tool turns and must not be summed here.
function visibleCharacters(node: TurnNode): number {
  return (
    node.prompt.length +
    node.response.length +
    (node.toolCalls ?? []).reduce(
      (total, call) =>
        total +
        call.name.length +
        JSON.stringify(call.arguments).length +
        (call.output || call.error || "").length,
      0,
    )
  );
}

export function estimatePathContextTokens(path: TurnNode[]): number {
  return Math.ceil(
    path.reduce((total, node) => total + visibleCharacters(node), 0) * 1.2,
  );
}

/** Each branch counts its ancestors once; siblings never consume its context. */
export function buildContextUsageMap(
  nodes: TurnNode[],
  models: ModelOption[],
  rootModelId: string,
): Map<string, ContextUsage> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byModel = new Map(models.map((model) => [model.id, model]));
  const totals = new Map<string, { characters: number; stale: boolean }>();
  const visiting = new Set<string>();
  const accumulate = (
    node: TurnNode,
  ): { characters: number; stale: boolean } => {
    const cached = totals.get(node.id);
    if (cached) return cached;
    if (visiting.has(node.id)) throw new Error("对话图存在循环。");
    visiting.add(node.id);
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const previous = parent
      ? accumulate(parent)
      : { characters: 0, stale: false };
    const total = {
      characters: previous.characters + visibleCharacters(node),
      stale: previous.stale || Boolean(node.contextStale),
    };
    visiting.delete(node.id);
    totals.set(node.id, total);
    return total;
  };
  return new Map(
    nodes.map((node) => {
      const total = accumulate(node);
      const tokens = Math.ceil(total.characters * 1.2);
      // The root has no model run; use the current composer's model as its basis.
      const capacity = byModel.get(
        node.status === "root" ? rootModelId : node.config.model,
      )?.contextWindow;
      const limit =
        capacity !== undefined && Number.isFinite(capacity) && capacity > 0
          ? capacity
          : null;
      return [
        node.id,
        {
          tokens,
          limit,
          percentage: limit === null ? null : (tokens / limit) * 100,
          stale: total.stale,
        },
      ];
    }),
  );
}
