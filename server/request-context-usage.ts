import type { Message } from "@earendil-works/pi-ai";
import type { ContextRequestUsage, TurnNode } from "../shared/types.ts";

function validTokens(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

/** Estimate only this response, including thinking and tool-call arguments. */
function generatedTokens(
  message: Extract<Message, { role: "assistant" }>,
): number {
  const text = message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return block.thinking;
      if (block.type === "toolCall")
        return block.name + JSON.stringify(block.arguments ?? {});
      return "";
    })
    .join("");
  const nonAscii = text.replace(/[\x00-\x7F]/g, "").length;
  return Math.ceil((text.length - nonAscii) / 4 + nonAscii * 1.2);
}

/** Counters for exactly one assistant response, never the concatenated run text. */
export function requestUsage(
  message: Message,
  model: string,
  inputTokens?: number,
  streaming = false,
): ContextRequestUsage | undefined {
  if (
    message.role !== "assistant" ||
    `${message.provider}/${message.model}` !== model ||
    !Number.isFinite(message.timestamp) ||
    message.timestamp < 0
  )
    return;
  const usage = message.usage;
  const reportedInput =
    usage && [usage.input, usage.cacheRead, usage.cacheWrite].every(validTokens)
      ? usage.input + usage.cacheRead + usage.cacheWrite
      : undefined;
  const hasReportedInput = validTokens(reportedInput) && reportedInput > 0;
  if (
    !streaming &&
    message.provider !== "demo" &&
    hasReportedInput &&
    validTokens(usage?.output)
  ) {
    return {
      inputTokens: reportedInput,
      outputTokens: usage.output,
      timestamp: message.timestamp,
    };
  }
  const fallbackInput =
    message.provider !== "demo" && hasReportedInput
      ? reportedInput
      : inputTokens;
  if (!validTokens(fallbackInput)) return;
  return {
    inputTokens: fallbackInput,
    outputTokens: generatedTokens(message),
    timestamp: message.timestamp,
    estimated: true,
  };
}

/** Read only the latest response in this run, not ancestors or accumulated billing. */
export function lastRequestUsage(
  messages: Message[] | undefined,
  model: string,
  inputTokens?: number,
): ContextRequestUsage | undefined {
  if (!messages) return;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    return requestUsage(message, model, inputTokens);
  }
}

/** Prefer newer streaming counters; complete raw messages win when timestamps match. */
export function snapshotRequestUsage(
  node: TurnNode,
  messages: Message[] | undefined,
): ContextRequestUsage | undefined {
  const derived = lastRequestUsage(
    messages,
    node.config.model,
    node.contextState?.inputTokens,
  );
  const live = node.lastRequestUsage;
  const validLive =
    live &&
    validTokens(live.inputTokens) &&
    validTokens(live.outputTokens) &&
    Number.isFinite(live.timestamp) &&
    live.timestamp >= 0;
  if (!validLive) return derived;
  if (!derived || derived.timestamp < live.timestamp) return { ...live };
  if (
    derived.timestamp === live.timestamp &&
    derived.estimated &&
    !live.estimated
  )
    return { ...live };
  return derived;
}
