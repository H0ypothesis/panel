import type { ToolCall, TurnNode } from "../shared/types";
import { isComputerUseCall } from "./computer-use";
import type { SpinnerVerbGroup } from "./spinner-verbs";

export type GenerationPhase =
  | "idle"
  | "queued"
  | "answer"
  | "tool"
  | "safety"
  | "approval";

export interface GenerationActivity {
  /** Changes at an activity boundary, never for streamed text or tool output. */
  key: string;
  phase: GenerationPhase;
  phraseGroup: SpinnerVerbGroup;
  toolName?: string;
}

/**
 * Pi runs tools sequentially. A tool ID identifies both its execution and the
 * answer that follows it; the first answer belongs to the run itself. Using
 * these IDs avoids a second transition when usage's preparation timestamp is
 * replaced with the provider's message timestamp for the same answer.
 */
export function getGenerationActivity(
  node: Pick<
    TurnNode,
    | "id"
    | "revision"
    | "requestId"
    | "startedAt"
    | "createdAt"
    | "status"
    | "toolCalls"
    | "lastRequestUsage"
  >,
  subagentId?: string,
): GenerationActivity {
  const defaultGroup = subagentId ? "subagent" : "thinking";
  // A card also carries its children's tools. Each loader follows only the
  // current owner, including after a child resumes with a new execution ID.
  const calls = node.toolCalls?.filter((call) =>
    subagentId ? call.subagentId === subagentId : !call.subagentId,
  );
  const run = [
    node.id,
    node.revision ?? 0,
    node.requestId ?? null,
    node.startedAt ?? node.createdAt,
  ];
  const activity = (
    phase: GenerationPhase,
    event: unknown[] = [phase],
    toolName?: string,
    phraseGroup: SpinnerVerbGroup = defaultGroup,
  ): GenerationActivity => ({
    key: JSON.stringify([...run, ...event]),
    phase,
    phraseGroup,
    ...(toolName ? { toolName } : {}),
  });

  if (node.status === "queued") return activity("queued");
  if (node.status !== "running") return activity("idle");

  const activeCall = calls?.findLast((call) =>
    ["reviewing", "awaiting_approval", "running"].includes(call.status),
  );
  if (activeCall) {
    if (activeCall.status === "reviewing") {
      return activity(
        "safety",
        [
          "safety",
          activeCall.id,
          activeCall.safetyReview?.startedAt ?? activeCall.startedAt,
        ],
        activeCall.name,
      );
    }
    const phase =
      activeCall.status === "awaiting_approval" ? "approval" : "tool";
    return activity(
      phase,
      [phase, activeCall.id],
      activeCall.name,
      phase === "tool"
        ? toolPhraseGroup(activeCall, defaultGroup)
        : defaultGroup,
    );
  }

  const lastCall = calls?.at(-1);
  if (!lastCall) return activity("answer", ["answer", "initial"]);

  const requestStart = node.lastRequestUsage?.timestamp;
  const toolEnd = lastCall.finishedAt ?? lastCall.startedAt;
  if (
    requestStart !== undefined &&
    Number.isFinite(requestStart) &&
    requestStart > toolEnd
  ) {
    return activity("answer", ["answer", lastCall.id]);
  }

  // Finishing a tool is not another generation event. Keep its word while the
  // next request is prepared, including snapshots from older backends without
  // request usage. The phase still tells the UI that execution has ended.
  return activity(
    "answer",
    [lastToolPhase(lastCall), lastCall.id],
    undefined,
    lastCall.status === "denied"
      ? defaultGroup
      : toolPhraseGroup(lastCall, defaultGroup),
  );
}

function toolPhraseGroup(
  call: ToolCall,
  fallback: SpinnerVerbGroup,
): SpinnerVerbGroup {
  if (isComputerUseCall(call)) return "computer-use";
  if (call.name === "bg_wait" || /^subagents?(?:_|$)/.test(call.name))
    return "delegation";
  return fallback;
}

function lastToolPhase(call: ToolCall): "tool" | "approval" {
  return call.status === "denied" ? "approval" : "tool";
}
