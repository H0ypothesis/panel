import type { Message } from "@earendil-works/pi-ai";
import type { ThinkingContent, TurnNode } from "../shared/types.ts";

export function thinkingText(messages: readonly Message[]): string {
  return messages
    .flatMap((message) => (message.role === "assistant" ? message.content : []))
    .filter((part) => part.type === "thinking")
    .map((part) => part.thinking)
    .filter((text) => text.trim())
    .join("\n\n");
}

/** Backfill readable thinking for saved conversations from earlier versions. */
export function snapshotThinking(
  node: Pick<TurnNode, "thinking" | "status">,
  messages: readonly Message[] = [],
): ThinkingContent | undefined {
  const thinking = node.thinking ?? {
    text: thinkingText(messages),
    active: false,
  };
  if (!thinking.text) return undefined;
  return {
    text: thinking.text,
    active: node.status === "running" && thinking.active,
  };
}
