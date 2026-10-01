import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import type { SafetyReviewRequest } from "../shared/types.ts";

type PreviousTool = NonNullable<SafetyReviewRequest["recentTools"]>[number];
export const SAFETY_HISTORY_TOKEN_BUDGET = 32_768;
const SEARCH_TOOLS = new Set([
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
]);

function resources(args: Record<string, unknown>, cwd?: string) {
  return Object.entries(args).flatMap(([key, value]) => {
    if (!/^(path|file_path|filePath|directory|url|urls)$/.test(key)) return [];
    return (Array.isArray(value) ? value : [value]).flatMap((item) =>
      typeof item !== "string"
        ? []
        : /^https?:\/\//.test(item)
          ? [item]
          : [resolve(cwd ?? ".", item)],
    );
  });
}

function referencedByCommand(path: string, command: string) {
  const escaped = basename(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    !!escaped &&
    new RegExp(`(?:^|[\\s/'\"])${escaped}(?=$|[\\s'\";|&)])`).test(command)
  );
}

function boundedText(text: string, limit: number) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[后续 ${text.length - limit} 字符未提供；不能假定未展示内容安全]`;
}

function fingerprint(value: unknown) {
  return createHash("sha256")
    .update(
      typeof value === "string"
        ? value
        : JSON.stringify(value, (_key, item) =>
            item && typeof item === "object" && !Array.isArray(item)
              ? Object.fromEntries(
                  Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
                )
              : item,
          ),
    )
    .digest("hex");
}

function omitted(value: unknown) {
  return {
    omitted: true,
    characters:
      typeof value === "string" ? value.length : JSON.stringify(value).length,
    sha256: fingerprint(value),
    ...(Array.isArray(value) ? { items: value.length } : {}),
  };
}

/** Only history is summarized; current arguments never pass through this function. */
function historicalArguments(call: PreviousTool, keepFileContent: boolean) {
  let visited = 0;
  const compact = (value: unknown, key: string, depth: number): unknown => {
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "string")
    )
      return value;
    if (++visited > 128 || depth > 6) return omitted(value);
    if (typeof value === "string") {
      const fileContent = ["content", "newText", "oldText"].includes(key);
      if (fileContent && !keepFileContent) return omitted(value);
      if (value.length <= 2048) return value;
      if (keepFileContent && fileContent) return boundedText(value, 16000);
      return omitted(value);
    }
    if (Array.isArray(value)) {
      const items = value
        .slice(0, 12)
        .map((item) => compact(item, key, depth + 1));
      return value.length <= 12 ? items : { ...omitted(value), preview: items };
    }
    const entries = Object.entries(value);
    return Object.fromEntries([
      ...entries
        .slice(0, 32)
        .map(([name, item]) => [name, compact(item, name, depth + 1)]),
      ...(entries.length > 32 ? [["$omittedFields", omitted(value)]] : []),
    ]);
  };
  const result = compact(call.arguments, "", 0);
  // Bound wide trees of individually short values as well as long leaves.
  return JSON.stringify(result).length <= (keepFileContent ? 32_000 : 8_000)
    ? result
    : omitted(call.arguments);
}

type HistoryTool = {
  call: PreviousTool;
  index: number;
  referencedFile: boolean;
  related: boolean;
  denied: boolean;
  sameTarget: boolean;
  actionFingerprint: string;
};

function historyKey(item: HistoryTool) {
  const call = item.call;
  return JSON.stringify({
    action: item.actionFingerprint,
    scope: [
      call.nodeId,
      call.revision,
      call.workingDirectory,
      call.subagentId,
      call.fromAncestor,
    ],
    approval: call.approval,
    status: call.status,
    review: call.safetyReview?.decision,
    reason: call.safetyReview?.reason && fingerprint(call.safetyReview.reason),
    error: call.error && fingerprint(call.error),
  });
}

function deduplicate(items: HistoryTool[], includeOutput = false) {
  const groups = new Map<
    string,
    { item: HistoryTool; occurrences: number; firstTimestamp?: number }
  >();
  for (const item of items) {
    const key =
      historyKey(item) +
      (includeOutput && item.referencedFile && item.call.output
        ? fingerprint(item.call.output)
        : "");
    const previous = groups.get(key);
    groups.set(key, {
      item,
      occurrences: (previous?.occurrences ?? 0) + 1,
      firstTimestamp: previous?.firstTimestamp ?? item.call.startedAt,
    });
  }
  return [...groups.values()];
}

/** Deterministic selection: model-generated summaries never replace user authorization. */
export function compactSafetyContext(
  request: SafetyReviewRequest,
  historyTokenBudget = SAFETY_HISTORY_TOKEN_BUDGET,
) {
  historyTokenBudget = Math.max(
    0,
    Math.min(SAFETY_HISTORY_TOKEN_BUDGET, Math.floor(historyTokenBudget)),
  );
  const tools = [
    ...request.ancestry.flatMap((ancestor) =>
      (ancestor.toolDecisions ?? []).map((call) => ({
        ...call,
        fromAncestor: true,
      })),
    ),
    ...(request.recentTools ?? []),
  ];
  const currentResources = resources(
    request.tool.arguments,
    request.workingDirectory,
  );
  const currentAction = fingerprint({
    name: request.tool.name,
    arguments: request.tool.arguments,
  });
  const command =
    typeof request.tool.arguments.command === "string"
      ? request.tool.arguments.command
      : "";
  const relatedIds = new Set(
    [request.subagent?.id, ...(request.relatedSubagentIds ?? [])].filter(
      Boolean,
    ),
  );
  const enriched: HistoryTool[] = tools.map((call, index) => {
    const paths = resources(
      call.arguments,
      call.workingDirectory ?? request.workingDirectory,
    );
    const referencedFile = paths.some((path) =>
      referencedByCommand(path, command),
    );
    const actionFingerprint = fingerprint({
      name: call.name,
      arguments: call.arguments,
    });
    const sameTarget =
      paths.some((path) => currentResources.includes(path)) ||
      (actionFingerprint === currentAction &&
        (call.workingDirectory ?? request.workingDirectory) ===
          request.workingDirectory);
    const own = !call.fromAncestor && relatedIds.has(call.subagentId);
    const denied =
      call.approval === "denied" ||
      call.status === "denied" ||
      call.safetyReview?.decision === "deny";
    return {
      call,
      index,
      referencedFile,
      sameTarget,
      actionFingerprint,
      related:
        own ||
        (!call.subagentId && !call.fromAncestor) ||
        sameTarget ||
        referencedFile,
      denied,
    };
  });
  // Cross-agent denials remain visible to prevent delegation from hiding a refusal.
  const approvals = deduplicate(
    enriched.filter(
      ({ call, related, denied }) =>
        denied || (related && !!(call.approval || call.safetyReview)),
    ),
  );
  const approvalRows = approvals.map(
    ({ item, occurrences, firstTimestamp }) => {
      const { call, actionFingerprint } = item;
      return {
        item,
        row: {
          id: call.id,
          subagentId: call.subagentId,
          workingDirectory: call.workingDirectory,
          name: call.name,
          // Code evidence belongs in recentTools, not a second copy in each decision.
          arguments: historicalArguments(call, false),
          actionHash: call.actionHash ?? actionFingerprint,
          actionFingerprint,
          approval: call.approval,
          status: call.status,
          error: call.error ? boundedText(call.error, 2048) : undefined,
          review: call.safetyReview
            ? {
                decision: call.safetyReview.decision,
                reason: boundedText(call.safetyReview.reason, 2048),
              }
            : undefined,
          timestamp: call.startedAt,
          occurrences,
          firstTimestamp,
          scope: {
            nodeId: call.nodeId,
            revision: call.revision,
            workingDirectory: call.workingDirectory,
            fromAncestor: call.fromAncestor ?? false,
          },
        },
      };
    },
  );
  const related = deduplicate(
    enriched.filter((item) => item.related),
    true,
  )
    .map((group) => group.item)
    .sort((a, b) => a.index - b.index);
  const candidates = new Set([
    ...related.slice(-12),
    ...related.filter((item) => item.referencedFile),
  ]);
  const recentRows = related
    .filter((item) => candidates.has(item))
    .map((item) => {
      const { call, referencedFile } = item;
      return {
        item,
        row: {
          id: call.id,
          subagentId: call.subagentId,
          workingDirectory: call.workingDirectory ?? null,
          fromAncestor: call.fromAncestor ?? false,
          nodeId: call.nodeId,
          revision: call.revision,
          name: call.name,
          arguments: historicalArguments(call, referencedFile),
          status: call.status,
          error: call.error ? boundedText(call.error, 2048) : undefined,
          output:
            !SEARCH_TOOLS.has(call.name) && referencedFile && call.output
              ? boundedText(call.output, 16000)
              : undefined,
        },
      };
    });
  // One shared token ledger: refusals, code evidence, same-target decisions,
  // then recent history. Old low-priority records cannot crowd out a refusal.
  const ordered = [
    ...approvalRows.map((entry) => ({
      ...entry,
      kind: "approval" as const,
      priority: entry.item.denied
        ? 0
        : entry.item.sameTarget || entry.item.referencedFile
          ? 2
          : 5,
    })),
    ...recentRows.map((entry) => ({
      ...entry,
      kind: "recent" as const,
      priority: entry.item.referencedFile ? 1 : entry.item.sameTarget ? 3 : 4,
    })),
  ].sort((a, b) => a.priority - b.priority || b.item.index - a.item.index);
  let used = 0,
    omittedDenials = 0,
    omittedReferencedEvidence = 0;
  const selected = ordered
    .filter((entry) => {
      const cost = safetyContextTokens(JSON.stringify(entry.row) + ",");
      if (used + cost <= historyTokenBudget) {
        used += cost;
        return true;
      }
      if (entry.kind === "approval" && entry.item.denied) omittedDenials++;
      if (entry.kind === "recent" && entry.item.referencedFile)
        omittedReferencedEvidence++;
      return false;
    })
    .sort((a, b) => a.item.index - b.item.index);
  const approvalHistory = selected
    .filter((entry) => entry.kind === "approval")
    .map((entry) => entry.row);
  const recentTools = selected
    .filter((entry) => entry.kind === "recent")
    .map((entry) => entry.row);
  const historyTokens =
    safetyContextTokens(JSON.stringify({ approvalHistory, recentTools })) -
    safetyContextTokens(
      JSON.stringify({ approvalHistory: [], recentTools: [] }),
    );
  return {
    workingDirectory: request.workingDirectory ?? null,
    workspaceTitle: request.workspaceTitle,
    workspaceDescription: request.workspaceDescription,
    userRequest: request.userRequest,
    ancestry: request.ancestry.map(({ prompt }) => ({ prompt })),
    approvalHistory,
    recentTools,
    contextSelection: {
      previousTools: tools.length,
      selectedTools: recentTools.length,
      omittedTools: tools.length - recentTools.length,
      historyTokenBudget,
      historyTokens,
      selectedApprovals: approvalHistory.length,
      omittedApprovals: approvals.length - approvalHistory.length,
      deduplicatedApprovals:
        enriched.filter(
          (item) =>
            item.denied ||
            (item.related && !!(item.call.approval || item.call.safetyReview)),
        ).length - approvals.length,
      omittedDenials,
      omittedReferencedEvidence,
      assistantResponsesIncluded: false,
      toolOutputsAreAuthorization: false,
      historyIsPartial: true,
    },
    tool: request.tool,
    subagent: request.subagent
      ? {
          ...request.subagent,
          task: boundedText(request.subagent.task, 2048),
        }
      : undefined,
    computerUseContext: request.computerUseContext,
  };
}

/** A conservative multilingual estimate, matching Panel's context accounting. */
export function safetyContextTokens(text: string) {
  return Math.ceil(text.length * 1.2);
}
