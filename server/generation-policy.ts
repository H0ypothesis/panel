import { createHash } from "node:crypto";
import type {
  Agent,
  AgentMessage,
  AgentTurnContext,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
type StreamFunction = Agent["streamFunction"];

/** A request ceiling, not a promise that the provider can generate this much. */
export function outputTokenBudget(
  model: Pick<Model<string>, "contextWindow">,
): number {
  if (!Number.isFinite(model.contextWindow) || model.contextWindow < 1)
    throw new Error("模型上下文窗口无效，无法设置输出上限。");
  return Math.floor(model.contextWindow);
}

/** Compaction needs headroom, not a reservation of the entire output ceiling. */
export function contextOutputReserve(
  model: Pick<Model<string>, "contextWindow">,
): number {
  return Math.max(1, Math.min(16384, Math.floor(model.contextWindow / 4)));
}

export const MAX_OUTPUT_CONTINUATIONS = 3;
const continuation =
  "Panel 自动续写：上一条回复达到单次输出上限，已生成的内容和工具记录均已保留。继续完成原任务，从中断处接着写，不要重复已有段落或重复已成功执行的操作。截断的工具调用没有执行，必要时重新提交完整参数；大文件按章节分多次写入，最后简短汇报结果。这是运行状态通知，不是新的用户授权。";

/** One budget for the whole prompt, shared across tool calls and length stops. */
export class OutputContinuation {
  count = 0;
  private text: string[] = [];
  private previous?: string;
  afterTurn(
    turn: Pick<AgentTurnContext, "message">,
    steer: (text: string) => void,
  ) {
    if (turn.message.stopReason !== "length") return;
    const content = turn.message.content.filter(
      (part) => part.type !== "thinking",
    );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(content))
      .digest("hex");
    if (this.count >= MAX_OUTPUT_CONTINUATIONS || this.previous === fingerprint)
      throw new Error(
        `输出未完成：达到单次输出限制，${this.previous === fingerprint ? "自动续写没有产生新内容" : `已自动续写 ${this.count} 次仍未完成`}。部分回答、工具记录和已保存文件均已保留，可继续任务或缩小单个子任务。`,
      );
    this.previous = fingerprint;
    this.count++;
    this.text.push(
      turn.message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join(""),
    );
    steer(continuation);
    return { action: "continue" as const };
  }

  projectFinal(messages: readonly AgentMessage[]): readonly AgentMessage[] {
    const last = messages.findLastIndex(
      (message) => message.role === "assistant",
    );
    const message = messages[last];
    if (
      !this.text.length ||
      message?.role !== "assistant" ||
      message.stopReason !== "stop"
    )
      return messages;
    return messages.map((item, index) =>
      index === last
        ? {
            ...message,
            content: [
              {
                type: "text" as const,
                text:
                  this.text.join("") +
                  message.content
                    .flatMap((part) =>
                      part.type === "text" ? [part.text] : [],
                    )
                    .join(""),
              },
              ...message.content.filter((part) => part.type !== "text"),
            ],
          }
        : item,
    );
  }
}

export function generationError(message: string): string {
  if (/^(输入上下文超限|服务端输出参数限制|输出未完成)：/.test(message))
    return message;
  if (
    /context[_ ](?:length|window|limit)|prompt is too long|input.{0,30}(too long|too large)|too many (input )?tokens/i.test(
      message,
    )
  )
    return `输入上下文超限：输入历史超出模型容量，请压缩上下文或减少输入。原始错误：${message}`;
  if (
    /(max[_ ](?:output[_ ]|completion[_ ])?tokens|maximum output tokens)[\s\S]{0,180}(exceed|at most|less than|must be|maximum|range|limit)|(?:exceed|at most|less than|maximum)[\s\S]{0,100}max[_ ](?:output[_ ]|completion[_ ])?tokens/i.test(
      message,
    )
  )
    return `服务端输出参数限制：模型接口拒绝了请求的输出预算。Panel 默认上限跟随模型上下文，接口仍有自己的限制。原始错误：${message}`;
  return message;
}

/** Only accept an explicitly stated OUTPUT bound, never guess from context errors. */
export function providerOutputLimit(error: string): number | undefined {
  const patterns = [
    /max[_ ](?:output[_ ]|completion[_ ])?tokens[\s\S]{0,100}?(?:less than or equal to|at most|maximum(?: value)?(?: of)?|<=)\s*[:=]?\s*(\d[\d,]*)/i,
    /(?:supports|maximum|limit(?: is)?)[\s\S]{0,60}?(\d[\d,]*)\s*(?:completion|output) tokens/i,
    /max[_ ](?:output[_ ]|completion[_ ])?tokens\s*[:=]\s*\d[\d,]*\s*>\s*(\d[\d,]*)/i,
    /max[_ ](?:output[_ ]|completion[_ ])?tokens[\s\S]{0,60}?between\s+\d+\s+and\s+(\d[\d,]*)/i,
    /maximum(?: number of)? output tokens\s*(?:is|:|=)\s*(\d[\d,]*)/i,
  ];
  for (const pattern of patterns) {
    const value = Number(pattern.exec(error)?.[1]?.replaceAll(",", ""));
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
}

/** Retry a rejected output parameter once, before any generated content exists. */
export function withProviderOutputLimit(
  stream: StreamFunction,
): StreamFunction {
  const learned = new Map<string, number>();
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      const key = `${model.provider}/${model.id}/${model.contextWindow}`;
      let maxTokens = Math.min(
        options?.maxTokens ?? outputTokenBudget(model),
        learned.get(key) ?? Infinity,
      );
      let generated = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        let retry = false;
        const events = await stream({ ...model, maxTokens }, context, {
          ...options,
          maxTokens,
        });
        for await (const event of events) {
          if (event.type === "error") {
            const limit = providerOutputLimit(event.error.errorMessage ?? "");
            if (
              !generated &&
              !options?.signal?.aborted &&
              attempt === 0 &&
              limit &&
              limit < maxTokens
            ) {
              maxTokens = limit;
              learned.set(key, limit);
              retry = true;
              break;
            }
            output.push({
              ...event,
              error: {
                ...event.error,
                errorMessage: generationError(
                  event.error.errorMessage ?? "模型请求失败。",
                ),
              },
            });
          } else {
            if (
              (event.type === "text_delta" ||
                event.type === "thinking_delta" ||
                event.type === "toolcall_delta") &&
              event.delta.length
            )
              generated = true;
            output.push(event);
          }
        }
        if (!retry) return;
      }
    })().catch((error) => {
      output.push({
        type: "error",
        reason: options?.signal?.aborted ? "aborted" : "error",
        error: {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [],
          timestamp: Date.now(),
          stopReason: options?.signal?.aborted ? "aborted" : "error",
          errorMessage: generationError(
            error instanceof Error ? error.message : String(error),
          ),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
      });
    });
    return output;
  };
}

/** Preserve SDK hooks and explicit summary budgets; change only answer requests. */
export function installGenerationPolicy(agent: Agent) {
  let recovery = new OutputContinuation();
  const stream = withProviderOutputLimit(agent.streamFunction);
  agent.streamFunction = (model, context, options) => {
    const maxTokens = options?.maxTokens ?? outputTokenBudget(model);
    return stream({ ...model, maxTokens }, context, { ...options, maxTokens });
  };
  const finish = agent.finishTurn;
  agent.finishTurn = async (turn, signal) => {
    const decision = await finish?.(turn, signal);
    if (decision?.action === "end") return decision;
    signal?.throwIfAborted();
    return (
      recovery.afterTurn(turn, (text) =>
        agent.steer({ role: "user", content: text, timestamp: Date.now() }),
      ) ??
      (decision || undefined)
    );
  };
  return {
    reset: () => {
      recovery = new OutputContinuation();
    },
    projectFinal: (messages: readonly AgentMessage[]) =>
      recovery.projectFinal(messages),
  };
}
