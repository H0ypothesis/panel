import type { ContextState, ModelOption, TurnNode } from "./types.ts";

export interface ContextUsage {
  tokens: number;
  limit: number | null;
  percentage: number | null;
  stale: boolean;
  /** The latest request input plus its output; never cumulative billing totals. */
  source: "provider" | "estimate" | "archive";
  inputTokens?: number;
  outputTokens?: number;
  rawTokens: number;
  compressionStatus?: ContextState["status"];
  originalTokens?: number;
}

// This is the same conservative visible-text heuristic used in the inspector.
// Provider usage is cumulative across tool turns and must not be summed here.
function visibleCharacters(node: TurnNode): number {
  return (
    node.prompt.length +
    node.response.length +
    (node.contextReferences ?? []).reduce(
      (total, reference) =>
        total + reference.prompt.length + reference.response.length,
      0,
    ) +
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

function validTokens(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

/** Count the latest request's input and output once, then fall back to estimates. */
export function contextUsageForNode(
  node: TurnNode,
  rawTokens: number,
  modelCapacity: number | undefined,
  stale = Boolean(node.contextStale),
): ContextUsage {
  const state = node.contextState;
  const measured = node.lastRequestUsage;
  const currentMeasurement =
    measured &&
    validTokens(measured.inputTokens) &&
    Number.isFinite(measured.timestamp) &&
    (!state || measured.timestamp >= state.updatedAt);
  const estimated = validTokens(state?.inputTokens);
  const inputTokens = currentMeasurement
    ? measured.inputTokens
    : estimated
      ? state!.inputTokens!
      : undefined;
  const outputTokens =
    currentMeasurement && validTokens(measured.outputTokens)
      ? measured.outputTokens
      : undefined;
  const source = currentMeasurement
    ? measured.estimated || outputTokens === undefined
      ? "estimate"
      : "provider"
    : estimated
      ? "estimate"
      : "archive";
  const tokens =
    inputTokens === undefined ? rawTokens : inputTokens + (outputTokens ?? 0);
  const capacity = state?.contextWindow ?? modelCapacity;
  const limit =
    capacity !== undefined && Number.isFinite(capacity) && capacity > 0
      ? capacity
      : null;
  return {
    tokens,
    inputTokens,
    outputTokens,
    rawTokens,
    limit,
    percentage: limit === null ? null : (tokens / limit) * 100,
    source,
    compressionStatus: state?.status,
    originalTokens: state?.originalTokens,
    stale,
  };
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
      const rawTokens = Math.ceil(total.characters * 1.2);
      // The root has no model run; use the current composer's model as its basis.
      const capacity = byModel.get(
        node.status === "root" ? rootModelId : node.config.model,
      )?.contextWindow;
      return [
        node.id,
        contextUsageForNode(node, rawTokens, capacity, total.stale),
      ];
    }),
  );
}
