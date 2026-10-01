import { setTimeout as delay } from "node:timers/promises";
import type { Agent } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  isRetryableAssistantError,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type { ConnectionRetry } from "../shared/types.ts";

type StreamFunction = Agent["streamFunction"];
export const MAX_CONNECTION_RETRIES = 5;

function retryable(message: AssistantMessage) {
  if (
    /^(输入上下文超限|服务端输出参数限制|输出未完成)：/.test(
      message.errorMessage ?? "",
    )
  )
    return false;
  return (
    isRetryableAssistantError(message) ||
    (message.stopReason === "error" &&
      /\bconnect error\b|\bECONN(?:RESET|REFUSED|ABORTED)\b|\bETIMEDOUT\b|\bUND_ERR_(?:CONNECT_TIMEOUT|SOCKET)\b/i.test(
        message.errorMessage ?? "",
      ))
  );
}

function failedMessage(
  model: Model<string>,
  error: unknown,
  aborted: boolean,
  partial?: AssistantMessage,
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...partial,
    stopReason: aborted ? "aborted" : "error",
    errorMessage: aborted
      ? "Request was aborted"
      : error instanceof Error
        ? error.message
        : String(error),
  };
}

/** Retry only the current model request; completed tools stay in its context. */
export function withConnectionRetries(
  stream: StreamFunction,
  options: {
    onRetry?: (retry?: ConnectionRetry) => void;
    baseDelayMs?: number;
  } = {},
): StreamFunction {
  return (model, context, requestOptions) => {
    const output = createAssistantMessageEventStream();
    const signal = requestOptions?.signal;
    let partial: AssistantMessage | undefined;
    let started = false;
    let retrying = false;
    const clearRetry = () => {
      if (!retrying) return;
      retrying = false;
      options.onRetry?.();
    };
    void (async () => {
      for (let attempt = 0; ; attempt++) {
        let failure: AssistantMessage;
        try {
          signal?.throwIfAborted();
          const events = await stream(model, context, requestOptions);
          let terminal: AssistantMessage | undefined;
          for await (const event of events) {
            if (event.type === "error") {
              terminal = event.error;
              break;
            }
            if (event.type === "done") {
              clearRetry();
              output.push(event);
              return;
            }
            partial = event.partial;
            if (event.type === "start" && started) {
              // Keep one assistant message in Pi's transcript. An empty delta
              // replaces the failed draft with this attempt's fresh partial.
              output.push({
                type: "text_delta",
                contentIndex: 0,
                delta: "",
                partial,
              });
            } else {
              if (event.type === "start") started = true;
              output.push(event);
            }
            if (
              (event.type === "text_delta" ||
                event.type === "thinking_delta" ||
                event.type === "toolcall_delta") &&
              event.delta.length
            )
              clearRetry();
          }
          failure =
            terminal ??
            failedMessage(
              model,
              "Model stream ended before a terminal response event",
              Boolean(signal?.aborted),
              partial,
            );
        } catch (error) {
          failure = failedMessage(
            model,
            error,
            Boolean(signal?.aborted),
            partial,
          );
        }
        if (signal?.aborted) failure = { ...failure, stopReason: "aborted" };
        const transient = retryable(failure);
        if (!transient || attempt >= MAX_CONNECTION_RETRIES) {
          clearRetry();
          output.push({
            type: "error",
            reason: failure.stopReason === "aborted" ? "aborted" : "error",
            error:
              transient && attempt >= MAX_CONNECTION_RETRIES
                ? {
                    ...failure,
                    errorMessage: `连接失败：已自动重连 ${MAX_CONNECTION_RETRIES} 次仍未恢复。原始错误：${failure.errorMessage}`,
                  }
                : failure,
          });
          return;
        }
        retrying = true;
        options.onRetry?.({
          attempt: attempt + 1,
          maxAttempts: MAX_CONNECTION_RETRIES,
        });
        await delay(
          Math.min((options.baseDelayMs ?? 1000) * 2 ** attempt, 8000),
          undefined,
          { signal },
        );
      }
    })().catch((error) => {
      clearRetry();
      const failure = failedMessage(
        model,
        error,
        Boolean(signal?.aborted),
        partial,
      );
      output.push({
        type: "error",
        reason: failure.stopReason === "aborted" ? "aborted" : "error",
        error: failure,
      });
    });
    return output;
  };
}
