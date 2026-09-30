import { createHash, randomUUID } from "node:crypto";
import {
  estimateTokens as estimatePiTokens,
  findCutPoint,
  type Entry,
} from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type {
  ContextCheckpoint,
  ContextSource,
  ContextState,
  ThinkingLevel,
  TurnNode,
} from "../shared/types.ts";

export interface ContextCompactorOptions {
  model: string;
  thinking: ThinkingLevel;
  contextWindow: number;
  /** Headroom reserved for generation; independent of the request's maximum output. */
  maxOutputTokens: number;
  systemPrompt: string;
  tools: unknown[];
  sources: ContextSource[];
  currentPromptIndex?: number;
  autoCompact: boolean;
  /** Content-only model projection; checkpoints still bind the original transcript. */
  projectMessages?: (
    messages: Message[],
    signal: AbortSignal,
  ) => Promise<Message[]>;
  checkpoints?: ContextCheckpoint[];
  requestedCheckpointId?: string;
  /** Explicit summaries for individual inputs of a merged branch. */
  branchCheckpoints?: ContextCheckpoint[];
  /** Explicit raw inputs take precedence when summaries overlap their history. */
  rawSourceIds?: string[];
  /** Merged inputs compact only when they exceed the usable input window. */
  mergeContext?: boolean;
  summarize: (
    messages: Message[],
    previousSummary: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ text: string; usage?: TurnNode["usage"] }>;
  onState?: (state: ContextState) => Promise<void>;
  onCheckpoint?: (checkpoint: ContextCheckpoint) => Promise<void>;
}

export interface ContextBudget {
  contextWindow: number;
  reservedTokens: number;
  outputTokens: number;
  thresholdTokens: number;
  maxInputTokens: number;
  overheadTokens: number;
  keepRecentTokens: number;
}

function textTokens(text: string): number {
  // Pi's characters / 4 fallback works for English. Account separately for
  // non-ASCII text so Chinese prompts are not underestimated by that factor.
  const nonAscii = text.replace(/[\x00-\x7F]/g, "").length;
  return Math.ceil((text.length - nonAscii) / 4 + nonAscii * 1.2);
}

function messageTokens(message: Message): number {
  const content = message.content;
  let text = typeof content === "string" ? content : "";
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "thinking") text += block.thinking;
      else if (block.type === "toolCall")
        text += block.name + JSON.stringify(block.arguments);
    }
  }
  const images = Array.isArray(content)
    ? content.filter((block) => block.type === "image").length
    : 0;
  return (
    Math.max(estimatePiTokens(message), textTokens(text) + images * 1200) + 8
  );
}

/** Estimates this projection, never the usage of an older, larger request. */
export function estimateContextInputTokens(
  messages: Message[],
  systemPrompt = "",
  tools: unknown[] = [],
): number {
  return (
    messages.reduce((total, message) => total + messageTokens(message), 0) +
    textTokens(systemPrompt) +
    (tools.length ? textTokens(JSON.stringify(tools)) : 0) +
    32
  );
}

export function contextBudget(
  options: Pick<
    ContextCompactorOptions,
    "contextWindow" | "maxOutputTokens" | "systemPrompt" | "tools"
  >,
): ContextBudget {
  const contextWindow = Math.floor(options.contextWindow);
  if (!Number.isFinite(contextWindow) || contextWindow < 1)
    throw new Error("模型上下文窗口无效，无法计算压缩预算。");
  const outputTokens = Math.max(1, Math.floor(options.maxOutputTokens));
  if (!Number.isFinite(outputTokens) || outputTokens >= contextWindow)
    throw new Error("模型输出预留超过上下文窗口，无法准备上下文。");
  const reservedTokens = Math.max(
    outputTokens,
    Math.min(16384, Math.floor(contextWindow / 4)),
  );
  const overheadTokens = estimateContextInputTokens(
    [],
    options.systemPrompt,
    options.tools,
  );
  const thresholdTokens = contextWindow - reservedTokens;
  const available = Math.max(0, thresholdTokens - overheadTokens);
  return {
    contextWindow,
    reservedTokens,
    outputTokens,
    thresholdTokens,
    maxInputTokens: contextWindow - outputTokens,
    overheadTokens,
    keepRecentTokens: Math.min(20000, Math.floor(available / 2)),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** Sources are clipped to the same original-message prefix as the checkpoint. */
export function contextPrefixSources(
  sources: ContextSource[],
  messageCount: number,
  totalMessages: number,
): ContextSource[] {
  if (
    !Number.isInteger(messageCount) ||
    messageCount < 0 ||
    messageCount > totalMessages
  )
    throw new Error("上下文摘要的消息范围无效。");
  let remaining = messageCount;
  let position = 0;
  const result: ContextSource[] = [];
  for (const [index, source] of sources.entries()) {
    if (remaining === 0) break;
    if (
      !Number.isInteger(source.messageCount) ||
      source.messageCount < 0 ||
      !Number.isInteger(source.revision) ||
      source.revision < 0
    )
      throw new Error("上下文来源版本或消息数量无效。");
    const count =
      index === sources.length - 1 && source.messageCount === 0
        ? totalMessages - position
        : source.messageCount;
    const take = Math.min(count, remaining);
    if (take > 0) result.push({ ...source, messageCount: take });
    remaining -= take;
    position += count;
  }
  if (remaining !== 0) throw new Error("上下文来源不能覆盖摘要的消息范围。");
  return result;
}

export function contextSourceHash(
  messages: Message[],
  sources: ContextSource[],
  messageCount: number,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        version: 1,
        messages: messages.slice(0, messageCount),
        sources: contextPrefixSources(sources, messageCount, messages.length),
      }),
    )
    .digest("hex");
}

export function checkpointMatches(
  checkpoint: ContextCheckpoint,
  messages: Message[],
  sources: ContextSource[],
): boolean {
  try {
    return (
      checkpoint.version === 1 &&
      checkpoint.messageCount > 1 &&
      checkpoint.messageCount <= messages.length &&
      checkpoint.summary.trim().length > 0 &&
      completeBoundaries(messages.slice(0, checkpoint.messageCount)).includes(
        checkpoint.messageCount,
      ) &&
      canonicalJson(checkpoint.sources) ===
        canonicalJson(
          contextPrefixSources(
            sources,
            checkpoint.messageCount,
            messages.length,
          ),
        ) &&
      checkpoint.sourceHash ===
        contextSourceHash(messages, sources, checkpoint.messageCount)
    );
  } catch {
    return false;
  }
}

function projectContext(
  messages: Message[],
  checkpoint: ContextCheckpoint,
  currentPromptIndex: number | undefined,
): Message[] {
  const protectedPrompt =
    currentPromptIndex !== undefined &&
    currentPromptIndex > 0 &&
    currentPromptIndex < checkpoint.messageCount
      ? [messages[currentPromptIndex]]
      : [];
  return [
    messages[0],
    {
      role: "user",
      content: `此前本路径的对话已压缩为以下摘要。以摘要和保留的原始消息继续工作。\n<summary>\n${checkpoint.summary}\n</summary>`,
      timestamp: checkpoint.createdAt,
    },
    ...protectedPrompt,
    ...messages.slice(checkpoint.messageCount),
  ];
}

/** Resolve a branch's prefix inside a deduplicated DAG without treating it as
 * the prefix of the entire merge. Hashes still verify the exact original text. */
export function projectBranchCheckpoints(
  messages: Message[],
  sources: ContextSource[],
  checkpoints: ContextCheckpoint[],
  currentPromptIndex?: number,
  rawSourceIds: string[] = [],
): { messages: Message[]; coveredMessageCount: number } {
  const ranges = new Map<string, { source: ContextSource; start: number }>();
  const preserveSources = new Set(rawSourceIds);
  const preserved = new Set<number>();
  let position = 0;
  for (const source of contextPrefixSources(
    sources,
    messages.length,
    messages.length,
  )) {
    if (ranges.has(source.nodeId))
      throw new Error("合并上下文包含重复来源，无法安全应用分支摘要。");
    ranges.set(source.nodeId, { source, start: position });
    if (preserveSources.has(source.nodeId))
      for (let offset = 0; offset < source.messageCount; offset++)
        preserved.add(position + offset);
    position += source.messageCount;
  }
  const hidden = new Set<number>();
  const insertions = new Map<number, Message[]>();
  let coveredMessageCount = 1;
  for (const checkpoint of new Map(
    checkpoints.map((item) => [item.id, item]),
  ).values()) {
    const covered: Message[] = [];
    const indices: number[] = [];
    for (const source of checkpoint.sources) {
      const range = ranges.get(source.nodeId);
      if (
        !range ||
        range.source.revision !== source.revision ||
        source.messageCount > range.source.messageCount ||
        source.messageCount < 1
      )
        throw new Error(
          "指定的分支摘要已过期或不属于当前合并路径，请重新压缩。",
        );
      for (let offset = 0; offset < source.messageCount; offset++) {
        const index = range.start + offset;
        indices.push(index);
        covered.push(messages[index]);
      }
    }
    if (
      indices[0] !== 0 ||
      !checkpointMatches(checkpoint, covered, checkpoint.sources)
    )
      throw new Error("指定的分支摘要已过期或不属于当前合并路径，请重新压缩。");
    const summaryIndices = indices.filter(
      (index) => index !== 0 && index !== currentPromptIndex,
    );
    if (!summaryIndices.length) continue;
    const replaced = summaryIndices.filter((index) => !preserved.has(index));
    const anchor = summaryIndices.reduce(
      (minimum, index) => Math.min(minimum, index),
      messages.length,
    );
    for (const index of indices)
      coveredMessageCount = Math.max(coveredMessageCount, index + 1);
    for (const index of replaced) hidden.add(index);
    const summaries = insertions.get(anchor) ?? [];
    summaries.push({
      role: "user",
      content: `以下是接入分支的历史摘要（来源：${checkpoint.sources.map((source) => source.nodeId).join("、")}）。结合其他分支和保留的原始消息回答；保留不同分支之间的分歧。\n<summary>\n${checkpoint.summary}\n</summary>`,
      timestamp: checkpoint.createdAt,
    });
    insertions.set(anchor, summaries);
  }
  return {
    messages: messages.flatMap((message, index) => [
      ...(insertions.get(index) ?? []),
      ...(hidden.has(index) ? [] : [message]),
    ]),
    coveredMessageCount,
  };
}

/** Legal boundaries keep every assistant tool-call batch with all its results. */
function completeBoundaries(messages: Message[]): number[] {
  const pending = new Set<string>();
  const boundaries = [0];
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      if (pending.size)
        throw new Error("工具调用批次尚未完成，暂时无法压缩上下文。");
      for (const block of message.content) {
        if (block.type === "toolCall") pending.add(block.id);
      }
    } else if (message.role === "toolResult") {
      if (!pending.delete(message.toolCallId))
        throw new Error("工具结果缺少对应调用，无法安全压缩上下文。");
    } else if (pending.size) {
      throw new Error("工具调用批次尚未完成，暂时无法压缩上下文。");
    }
    if (pending.size === 0) boundaries.push(index + 1);
  }
  if (pending.size)
    throw new Error("工具调用批次尚未完成，暂时无法压缩上下文。");
  return boundaries;
}

export class ContextCompactor {
  private readonly options: ContextCompactorOptions;
  private readonly budget: ContextBudget;
  private activeCheckpoint?: ContextCheckpoint;
  private usageCorrection = 0;
  private lastRequest?: {
    rawCount: number;
    sourceHash: string;
    estimatedInput: number;
    checkpointId?: string;
  };

  constructor(options: ContextCompactorOptions) {
    this.options = {
      ...options,
      sources: structuredClone(options.sources),
      checkpoints: structuredClone(options.checkpoints ?? []),
      branchCheckpoints: structuredClone(options.branchCheckpoints ?? []),
      rawSourceIds: [...(options.rawSourceIds ?? [])],
    };
    this.budget = contextBudget(options);
  }

  private calibrateFromLastRequest(messages: Message[]): void {
    const previous = this.lastRequest;
    if (!previous || messages.length <= previous.rawCount) return;
    if (
      previous.checkpointId !== this.activeCheckpoint?.id ||
      contextSourceHash(messages, this.options.sources, previous.rawCount) !==
        previous.sourceHash
    ) {
      this.usageCorrection = 0;
      this.lastRequest = undefined;
      return;
    }
    // Only the response immediately after our own previous projection can
    // measure that projection. Ancestor usage and other models never qualify.
    const response = messages[previous.rawCount];
    if (
      response.role !== "assistant" ||
      `${response.provider}/${response.model}` !== this.options.model ||
      response.stopReason === "error" ||
      response.stopReason === "aborted" ||
      response.stopReason === "pending" ||
      response.stopReason === "deferred"
    )
      return;
    const actualInput =
      response.usage.input +
      response.usage.cacheRead +
      response.usage.cacheWrite;
    if (Number.isFinite(actualInput) && actualInput > 0)
      this.usageCorrection = actualInput - previous.estimatedInput;
  }

  private rememberRequest(raw: Message[], projection: Message[]): void {
    this.lastRequest = {
      rawCount: raw.length,
      sourceHash: contextSourceHash(raw, this.options.sources, raw.length),
      estimatedInput: estimateContextInputTokens(
        projection,
        this.options.systemPrompt,
        this.options.tools,
      ),
      checkpointId: this.activeCheckpoint?.id,
    };
  }

  async prepare(
    messages: Message[],
    signal: AbortSignal,
    force = false,
  ): Promise<Message[]> {
    const raw = structuredClone(messages);
    const { options, budget } = this;
    const project = (messages: Message[]) =>
      options.projectMessages?.(messages, signal) ?? Promise.resolve(messages);
    const thresholdTokens = options.mergeContext
      ? budget.maxInputTokens
      : budget.thresholdTokens;
    const autoCompact = options.mergeContext || options.autoCompact;
    const estimate = (projection: Message[]) =>
      estimateContextInputTokens(
        projection,
        options.systemPrompt,
        options.tools,
      );
    const originalTokens = estimate(raw);
    let projection = raw;
    let branchCoverage = 1;
    let recoverableSummaryFailure = false;
    const calibratedTokens = () =>
      Math.max(
        budget.overheadTokens,
        estimate(projection) + this.usageCorrection,
      );
    const state = async (
      status: ContextState["status"],
      inputTokens = calibratedTokens(),
      extra: Partial<ContextState> = {},
    ) =>
      options.onState?.({
        status,
        updatedAt: Date.now(),
        originalTokens,
        inputTokens,
        contextWindow: budget.contextWindow,
        reservedTokens: options.mergeContext
          ? budget.outputTokens
          : budget.reservedTokens,
        ...(this.activeCheckpoint
          ? { checkpointId: this.activeCheckpoint.id }
          : {}),
        ...extra,
      });
    try {
      signal.throwIfAborted();
      if (force && !options.requestedCheckpointId) {
        // A manual request generates a fresh summary with the selected model;
        // an ancestor's cached summary is not the result of that request.
        this.activeCheckpoint = undefined;
        this.lastRequest = undefined;
        this.usageCorrection = 0;
      }
      this.calibrateFromLastRequest(raw);
      if (
        options.currentPromptIndex !== undefined &&
        (!Number.isInteger(options.currentPromptIndex) ||
          options.currentPromptIndex < 0 ||
          options.currentPromptIndex >= raw.length ||
          raw[options.currentPromptIndex].role !== "user")
      )
        throw new Error("当前问题在原始上下文中的位置无效。");
      if (this.activeCheckpoint) {
        if (!checkpointMatches(this.activeCheckpoint, raw, options.sources))
          throw new Error("已启用的上下文摘要已过期，请重新生成摘要。");
        projection = projectContext(
          raw,
          this.activeCheckpoint,
          options.currentPromptIndex,
        );
      } else if (options.branchCheckpoints?.length) {
        const projected = projectBranchCheckpoints(
          raw,
          options.sources,
          options.branchCheckpoints,
          options.currentPromptIndex,
          options.rawSourceIds,
        );
        projection = projected.messages;
        branchCoverage = projected.coveredMessageCount;
      }
      projection = await project(projection);
      const needsCompaction = calibratedTokens() > thresholdTokens;
      const shouldActivate =
        Boolean(options.requestedCheckpointId) ||
        (!force &&
          autoCompact &&
          needsCompaction &&
          !options.branchCheckpoints?.length);
      if (!this.activeCheckpoint && shouldActivate) {
        completeBoundaries(raw);
        const requested = options.requestedCheckpointId;
        const candidates = (options.checkpoints ?? []).filter((checkpoint) =>
          checkpointMatches(checkpoint, raw, options.sources),
        );
        const selected = requested
          ? candidates.find((checkpoint) => checkpoint.id === requested)
          : candidates.sort((a, b) => b.messageCount - a.messageCount)[0];
        if (requested && !selected)
          throw new Error(
            "指定的上下文摘要已过期或不属于当前路径，请重新压缩。",
          );
        if (selected) {
          const candidate = await project(
            projectContext(raw, selected, options.currentPromptIndex),
          );
          if (estimate(candidate) < originalTokens) {
            signal.throwIfAborted();
            const candidateTokens = estimate(candidate);
            const adopted = structuredClone(selected);
            if (
              !force &&
              options.mergeContext &&
              needsCompaction &&
              options.currentPromptIndex === raw.length - 1
            ) {
              // Record the transition for this merged request without changing
              // the ancestor's cached summary or its raw-message provenance.
              adopted.purpose = "merge";
              adopted.tokensBefore = calibratedTokens();
              adopted.tokensAfter = candidateTokens;
            }
            // A checkpoint from a larger model may need further compaction.
            // Publish its adoption only if this projection can actually run.
            if (candidateTokens <= budget.maxInputTokens)
              await options.onCheckpoint?.(structuredClone(adopted));
            signal.throwIfAborted();
            this.activeCheckpoint = adopted;
            this.usageCorrection = 0;
            projection = candidate;
          } else if (requested) {
            throw new Error("指定的上下文摘要没有缩小当前输入，请重新压缩。");
          }
        }
      }

      const inputTokens = calibratedTokens();
      if (!force && this.activeCheckpoint && inputTokens <= thresholdTokens) {
        await state("compacted", inputTokens);
        signal.throwIfAborted();
        this.rememberRequest(raw, projection);
        return projection;
      }
      if (!force && (!autoCompact || inputTokens <= thresholdTokens)) {
        if (inputTokens > budget.maxInputTokens)
          throw new Error("上下文超过模型可用窗口，请先手动压缩或缩小输入。");
        await state(
          this.activeCheckpoint || options.branchCheckpoints?.length
            ? "compacted"
            : "full",
          inputTokens,
        );
        signal.throwIfAborted();
        this.rememberRequest(raw, projection);
        return projection;
      }

      await state("compacting", inputTokens);
      signal.throwIfAborted();
      const boundaries = completeBoundaries(raw);
      const previous = this.activeCheckpoint;
      const minimum = previous?.messageCount ?? 1;
      const entries: Entry[] = raw.map((message, index) => ({
        type: "message",
        id: String(index),
        parentId: index === 0 ? null : String(index - 1),
        seq: index,
        timestamp: message.timestamp,
        message,
      }));
      const suggested = findCutPoint(
        entries,
        minimum,
        entries.length,
        budget.keepRecentTokens,
      ).firstKeptEntryIndex;
      // Leave room for the summary, root, and original current question. The
      // content estimate refines Pi's cut for multilingual text and tool batches.
      let cut = boundaries.find(
        (boundary) => boundary >= suggested && boundary > minimum,
      );
      const viable = boundaries.filter(
        (boundary) => boundary > minimum && boundary > 1,
      );
      if (cut === undefined || cut < 2) cut = viable[0];
      if (cut === undefined)
        throw new Error("当前上下文没有可安全压缩的历史消息。");
      if (force && options.currentPromptIndex === undefined) {
        // A manual merge summarizes every selected branch together, including
        // the last branch even when Pi would normally retain its recent tail.
        // Other manual preparations keep complete question-answer turns.
        cut =
          options.mergeContext || suggested <= minimum
            ? raw.length
            : (viable.find(
                (boundary) =>
                  boundary >= cut! && raw[boundary]?.role === "user",
              ) ?? raw.length);
      }
      if (!previous && branchCoverage > cut)
        cut =
          viable.find((boundary) => boundary >= branchCoverage) ?? raw.length;
      const summaryAllowance = Math.max(
        64,
        Math.min(2048, Math.floor(thresholdTokens / 8)),
      );
      while (cut < raw.length) {
        const provisional: ContextCheckpoint = {
          id: "budget",
          version: 1,
          sourceHash: "",
          messageCount: cut,
          sources: [],
          summary: "",
          model: options.model,
          thinking: options.thinking,
          createdAt: Date.now(),
          tokensBefore: originalTokens,
          tokensAfter: 0,
        };
        if (
          estimate(
            await project(
              projectContext(raw, provisional, options.currentPromptIndex),
            ),
          ) +
            summaryAllowance <=
          thresholdTokens
        )
          break;
        const next = viable.find((boundary) => boundary > cut!);
        if (next === undefined) break;
        cut = next;
      }
      const sources = contextPrefixSources(options.sources, cut, raw.length);
      const sourceHash = contextSourceHash(raw, options.sources, cut);
      recoverableSummaryFailure = true;
      const summaryMessages =
        !previous && options.branchCheckpoints?.length
          ? projectBranchCheckpoints(
              raw.slice(0, cut),
              sources,
              options.branchCheckpoints,
              options.currentPromptIndex,
              options.rawSourceIds,
            ).messages.slice(1)
          : raw.slice(minimum, cut);
      const summarized = await options.summarize(
        await project(structuredClone(summaryMessages)),
        previous?.summary,
        signal,
      );
      signal.throwIfAborted();
      const summary = summarized.text.trim();
      if (!summary) throw new Error("上下文压缩没有返回有效摘要。");
      const checkpoint: ContextCheckpoint = {
        id: randomUUID(),
        version: 1,
        sourceHash,
        messageCount: cut,
        sources,
        summary,
        model: options.model,
        thinking: options.thinking,
        createdAt: Date.now(),
        tokensBefore: inputTokens,
        tokensAfter: 0,
        ...(options.mergeContext &&
        options.currentPromptIndex === raw.length - 1
          ? { purpose: "merge" as const }
          : {}),
        ...(summarized.usage ? { usage: summarized.usage } : {}),
      };
      const compacted = await project(
        projectContext(raw, checkpoint, options.currentPromptIndex),
      );
      const compactedTokens = estimate(compacted);
      if (compactedTokens >= inputTokens)
        throw new Error("压缩后的上下文没有变小，已保留原始消息。");
      if (compactedTokens > budget.maxInputTokens)
        throw new Error("压缩后仍超过模型可用窗口，请缩小当前问题或工具输出。");
      checkpoint.tokensAfter = compactedTokens;
      recoverableSummaryFailure = false;
      signal.throwIfAborted();
      await options.onCheckpoint?.(structuredClone(checkpoint));
      signal.throwIfAborted();
      this.activeCheckpoint = checkpoint;
      this.usageCorrection = 0;
      projection = compacted;
      await state("compacted", compactedTokens);
      signal.throwIfAborted();
      this.rememberRequest(raw, projection);
      return projection;
    } catch (error) {
      if (signal.aborted) {
        await state("cancelled", calibratedTokens(), {
          error: "上下文压缩已取消，原始消息已保留。",
        });
        signal.throwIfAborted();
      }
      const reason = error instanceof Error ? error.message : String(error);
      await state("failed", calibratedTokens(), { error: reason });
      // An explicit request must report failure. Automatic preparation can
      // continue only with an intact context that still fits the input budget.
      if (
        !recoverableSummaryFailure ||
        force ||
        options.requestedCheckpointId ||
        calibratedTokens() > budget.maxInputTokens
      )
        throw error;
      this.rememberRequest(raw, projection);
      return projection;
    }
  }
}
