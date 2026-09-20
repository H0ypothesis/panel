import type { ToolCall, TurnNode } from "../shared/types";

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
  toolName?: string;
}

/**
 * Pi runs tools sequentially. A tool ID identifies both its execution and the
 * answer that follows it; the first answer belongs to the run itself. Using
 * these IDs avoids a second transition when usage's preparation timestamp is
 * replaced with the provider's message timestamp for the same answer.
 */
export function getGenerationActivity(node: TurnNode): GenerationActivity {
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
  ): GenerationActivity => ({
    key: JSON.stringify([...run, ...event]),
    phase,
    ...(toolName ? { toolName } : {}),
  });

  if (node.status === "queued") return activity("queued");
  if (node.status !== "running") return activity("idle");

  const activeCall = node.toolCalls?.findLast((call) =>
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
    return activity(phase, [phase, activeCall.id], activeCall.name);
  }

  const lastCall = node.toolCalls?.at(-1);
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
  return activity("answer", [lastToolPhase(lastCall), lastCall.id]);
}

function lastToolPhase(call: ToolCall): "tool" | "approval" {
  return call.status === "denied" ? "approval" : "tool";
}
