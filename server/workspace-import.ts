import { randomUUID } from "node:crypto";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  ContextCheckpoint,
  ContextSource,
  RunConfig,
  ToolCall,
  TurnNode,
} from "../shared/types.ts";
import { buildContext } from "./context.ts";
import { checkpointMatches, contextSourceHash } from "./compaction.ts";
import type { StoredNode, StoredRun, StoredWorkspace } from "./store.ts";

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const MAX_NODES = 10_000;
const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const runStatuses = [
  "root",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
const toolStatuses = [
  "reviewing",
  "awaiting_approval",
  "running",
  "completed",
  "failed",
  "denied",
  "cancelled",
] as const;

type ObjectValue = Record<string, unknown>;

function invalid(label: string): never {
  throw new Error(
    `导入失败：${label}格式无效，请选择 Panel 导出的 JSON 文件。`,
  );
}

function object(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(label);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(label);
  return value as ObjectValue;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(label);
  return value;
}

function string(value: unknown, label: string, nonempty = false): string {
  if (typeof value !== "string" || (nonempty && !value.trim())) invalid(label);
  return value;
}

function number(value: unknown, label: string, signed = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (!signed && value < 0)
  )
    invalid(label);
  return value;
}

function integer(value: unknown, label: string): number {
  const result = number(value, label);
  if (!Number.isSafeInteger(result)) invalid(label);
  return result;
}

function coordinate(value: unknown, label: string): number {
  const result = number(value, label, true);
  if (Math.abs(result) > 1_000_000) invalid(label);
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(label);
  return value;
}

function enumeration<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) invalid(label);
  return value as T;
}

function optional<T>(
  value: unknown,
  label: string,
  parse: (value: unknown, label: string) => T,
): T | undefined {
  return value === undefined ? undefined : parse(value, label);
}

/** Only JSON data may appear in tool arguments/details. Never retain object prototypes. */
function jsonValue(value: unknown, label: string, depth = 0): unknown {
  if (depth > 100) invalid(`${label}嵌套层级`);
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") return number(value, label, true);
  if (Array.isArray(value))
    return value.map((item) => jsonValue(item, label, depth + 1));
  return Object.fromEntries(
    Object.entries(object(value, label)).map(([key, item]) => [
      key,
      jsonValue(item, label, depth + 1),
    ]),
  );
}

function jsonObject(value: unknown, label: string): ObjectValue {
  object(value, label);
  return jsonValue(value, label) as ObjectValue;
}

function config(value: unknown, label: string): RunConfig {
  const source = object(value, label);
  return {
    model: string(source.model, `${label}模型`, true),
    thinking: enumeration(source.thinking, thinkingLevels, `${label}思考强度`),
  };
}

function nodeUsage(
  value: unknown,
  label: string,
): NonNullable<TurnNode["usage"]> {
  const source = object(value, label);
  return {
    input: number(source.input, label),
    output: number(source.output, label),
    total: number(source.total, label),
    ...(source.cost === undefined ? {} : { cost: number(source.cost, label) }),
  };
}

function messageUsage(value: unknown, label: string): Usage {
  const source = object(value, label);
  const cost = object(source.cost, `${label}费用`);
  return {
    input: number(source.input, label),
    output: number(source.output, label),
    cacheRead: number(source.cacheRead, label),
    cacheWrite: number(source.cacheWrite, label),
    ...(source.cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h: number(source.cacheWrite1h, label) }),
    ...(source.reasoning === undefined
      ? {}
      : { reasoning: number(source.reasoning, label) }),
    totalTokens: number(source.totalTokens, label),
    cost: {
      input: number(cost.input, label),
      output: number(cost.output, label),
      cacheRead: number(cost.cacheRead, label),
      cacheWrite: number(cost.cacheWrite, label),
      total: number(cost.total, label),
    },
  };
}

function textContent(value: ObjectValue, label: string): TextContent {
  return {
    type: "text",
    text: string(value.text, label),
    ...(value.textSignature === undefined
      ? {}
      : { textSignature: string(value.textSignature, label) }),
  };
}

function inputContent(
  value: unknown,
  label: string,
): (TextContent | ImageContent)[] {
  return array(value, label).map((item) => {
    const content = object(item, label);
    if (content.type === "text") return textContent(content, label);
    if (content.type === "image") {
      return {
        type: "image",
        data: string(content.data, label),
        mimeType: string(content.mimeType, label, true),
      };
    }
    return invalid(`${label}内容类型`);
  });
}

function assistantContent(
  value: unknown,
  label: string,
): AssistantMessage["content"] {
  return array(value, label).map((item) => {
    const content = object(item, label);
    if (content.type === "text") return textContent(content, label);
    if (content.type === "thinking") {
      return {
        type: "thinking",
        thinking: string(content.thinking, label),
        ...(content.thinkingSignature === undefined
          ? {}
          : { thinkingSignature: string(content.thinkingSignature, label) }),
        ...(content.redacted === undefined
          ? {}
          : { redacted: boolean(content.redacted, label) }),
      };
    }
    if (content.type === "toolCall") {
      return {
        type: "toolCall",
        id: string(content.id, label, true),
        name: string(content.name, label, true),
        arguments: jsonObject(content.arguments, label),
        ...(content.thoughtSignature === undefined
          ? {}
          : { thoughtSignature: string(content.thoughtSignature, label) }),
        ...(content.namespace === undefined
          ? {}
          : { namespace: string(content.namespace, label) }),
      };
    }
    return invalid(`${label}内容类型`);
  });
}

function diagnostics(
  value: unknown,
  label: string,
): NonNullable<AssistantMessage["diagnostics"]> {
  return array(value, label).map((item) => {
    const source = object(item, label);
    const error =
      source.error === undefined ? undefined : object(source.error, label);
    const code = error?.code;
    if (
      code !== undefined &&
      typeof code !== "string" &&
      typeof code !== "number"
    )
      invalid(label);
    return {
      type: string(source.type, label),
      timestamp: number(source.timestamp, label),
      ...(source.details === undefined
        ? {}
        : { details: jsonObject(source.details, label) }),
      ...(error === undefined
        ? {}
        : {
            error: {
              message: string(error.message, label),
              ...(error.name === undefined
                ? {}
                : { name: string(error.name, label) }),
              ...(error.stack === undefined
                ? {}
                : { stack: string(error.stack, label) }),
              ...(code === undefined
                ? {}
                : {
                    code:
                      typeof code === "number"
                        ? number(code, label, true)
                        : code,
                  }),
            },
          }),
    };
  });
}

function messages(value: unknown, label: string): Message[] {
  return array(value, label).map((item) => {
    const source = object(item, label);
    const timestamp = number(source.timestamp, `${label}时间`);
    if (source.role === "user") {
      return {
        role: "user",
        content:
          typeof source.content === "string"
            ? source.content
            : inputContent(source.content, label),
        timestamp,
      };
    }
    if (source.role === "system") {
      // Historical prompt text is readable context. Exported tool declarations
      // cannot add/remove local capabilities when this transcript is reused.
      const content =
        typeof source.content === "string"
          ? source.content
          : array(source.content, label).map((part) => {
              const block = object(part, label);
              if (block.type !== "text") invalid(label);
              return textContent(block, label);
            });
      const sections =
        source.sections === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(object(source.sections, label)).map(
                ([key, value]) => [
                  key,
                  value === null ? null : string(value, label),
                ],
              ),
            );
      return {
        role: "system",
        content,
        ...(sections === undefined ? {} : { sections }),
        timestamp,
      };
    }
    if (source.role === "toolResult") {
      return {
        role: "toolResult",
        toolCallId: string(source.toolCallId, label, true),
        toolName: string(source.toolName, label, true),
        content: inputContent(source.content, label),
        ...(source.details === undefined
          ? {}
          : { details: jsonValue(source.details, label) }),
        ...(source.usage === undefined
          ? {}
          : { usage: messageUsage(source.usage, label) }),
        isError: boolean(source.isError, label),
        timestamp,
      };
    }
    if (source.role !== "assistant") invalid(`${label}角色`);
    return {
      role: "assistant",
      content: assistantContent(source.content, label),
      api: string(source.api, label, true),
      provider: string(source.provider, label, true),
      model: string(source.model, label, true),
      usage: messageUsage(source.usage, label),
      stopReason: enumeration(
        source.stopReason,
        [
          "pending",
          "stop",
          "length",
          "toolUse",
          "error",
          "aborted",
          "deferred",
        ] as const,
        label,
      ),
      ...(source.responseModel === undefined
        ? {}
        : { responseModel: string(source.responseModel, label) }),
      ...(source.responseId === undefined
        ? {}
        : { responseId: string(source.responseId, label) }),
      ...(source.providerThinkingLevel === undefined
        ? {}
        : {
            providerThinkingLevel: string(source.providerThinkingLevel, label),
          }),
      ...(source.errorMessage === undefined
        ? {}
        : { errorMessage: string(source.errorMessage, label) }),
      ...(source.rawStopReason === undefined
        ? {}
        : { rawStopReason: string(source.rawStopReason, label) }),
      ...(source.endTurn === undefined
        ? {}
        : { endTurn: boolean(source.endTurn, label) }),
      ...(source.diagnostics === undefined
        ? {}
        : { diagnostics: diagnostics(source.diagnostics, label) }),
      // A provider deferred handle may resume remote execution; it is not history.
      timestamp,
    };
  });
}

function toolCalls(value: unknown, label: string, now: number): ToolCall[] {
  const ids = new Set<string>();
  return array(value, label).map((item) => {
    const source = object(item, label);
    const id = string(source.id, `${label}ID`, true);
    if (ids.has(id)) invalid(`${label}重复 ID`);
    ids.add(id);
    const status = enumeration(source.status, toolStatuses, `${label}状态`);
    const interrupted =
      status === "reviewing" ||
      status === "awaiting_approval" ||
      status === "running";
    const review =
      source.safetyReview === undefined
        ? undefined
        : object(source.safetyReview, `${label}安全审核`);
    const decision =
      review === undefined
        ? undefined
        : enumeration(
            review.decision,
            ["reviewing", "approve", "deny", "error", "cancelled"] as const,
            `${label}安全审核决定`,
          );
    const finishedAt = optional(source.finishedAt, `${label}结束时间`, number);
    const error = optional(source.error, `${label}错误`, string);
    const approval =
      source.approval === undefined
        ? undefined
        : enumeration(
            source.approval,
            ["auto", "policy", "safety_model", "approved", "denied"] as const,
            `${label}历史审批`,
          );
    const reviewReason =
      review === undefined
        ? undefined
        : string(review.reason, `${label}安全审核原因`);
    const reviewFinishedAt =
      review === undefined
        ? undefined
        : optional(review.finishedAt, `${label}安全审核结束时间`, number);
    return {
      id,
      name: string(source.name, `${label}名称`, true),
      arguments: jsonObject(source.arguments, `${label}参数`),
      status: interrupted ? "cancelled" : status,
      startedAt: number(source.startedAt, `${label}开始时间`),
      ...(finishedAt === undefined && !interrupted
        ? {}
        : { finishedAt: interrupted ? now : finishedAt }),
      ...(source.output === undefined
        ? {}
        : { output: string(source.output, `${label}输出`) }),
      ...(error === undefined && !interrupted
        ? {}
        : {
            error: interrupted
              ? "导入时已取消未完成的工具操作，未执行或重放。"
              : error,
          }),
      ...(approval === undefined ? {} : { approval }),
      ...(source.sources === undefined
        ? {}
        : {
            sources: array(source.sources, `${label}来源`).map((item) => {
              const source = object(item, `${label}来源`);
              return {
                title: string(source.title, label),
                url: string(source.url, label),
              };
            }),
          }),
      ...(review === undefined
        ? {}
        : {
            safetyReview: {
              model: string(review.model, label, true),
              decision: decision === "reviewing" ? "cancelled" : decision!,
              reason:
                decision === "reviewing"
                  ? "导入时已取消安全审核，未执行工具。"
                  : reviewReason!,
              startedAt: number(review.startedAt, label),
              ...(reviewFinishedAt === undefined && decision !== "reviewing"
                ? {}
                : {
                    finishedAt:
                      decision === "reviewing" ? now : reviewFinishedAt,
                  }),
            },
          }),
      // Authorization, fileSnapshot and waitingFor are never imported. The
      // approval enum above is display-only audit data, never live authorization.
      // In particular, no old snapshot marker may bypass retry's Git audit.
    };
  });
}

/** Parse a Panel export into an independent, inert local exploration. */
export function importWorkspace(value: unknown): StoredWorkspace {
  const envelope = object(value, "JSON 文件");
  if (envelope.version !== 1)
    throw new Error(
      "导入失败：不支持此导出版本，请选择版本 1 的 Panel JSON 文件。",
    );
  if (
    envelope.exportedAt !== undefined &&
    !Number.isFinite(Date.parse(string(envelope.exportedAt, "导出时间")))
  )
    invalid("导出时间");
  const source = object(envelope.workspace, "探索");
  string(source.id, "探索 ID", true);
  const nodes = array(source.nodes, "节点列表");
  if (!nodes.length || nodes.length > MAX_NODES)
    throw new Error(`导入失败：探索需包含 1 至 ${MAX_NODES} 个节点。`);
  const ids = new Map<string, string>();
  const originals = nodes.map((item, index) => {
    const node = object(item, `第 ${index + 1} 个节点`);
    const id = string(node.id, "节点 ID", true);
    if (ids.has(id)) throw new Error("导入失败：节点 ID 重复。");
    ids.set(id, randomUUID());
    return node;
  });
  const byId = new Map(originals.map((node) => [node.id as string, node]));
  const roots = originals.filter((node) => node.parentId === null);
  if (roots.length !== 1 || roots[0].status !== "root")
    throw new Error("导入失败：探索必须包含且仅包含一个有效的起点。");
  const root = roots[0];
  for (const node of originals) {
    if (node === root) continue;
    if (
      node.status === "root" ||
      !byId.has(string(node.parentId, "父节点 ID", true))
    )
      throw new Error("导入失败：存在无效或缺失的父节点。");
  }
  // Iterative colouring proves every node reaches the unique root in O(nodes).
  const visited = new Set<string>([root.id as string]);
  for (const node of originals) {
    const path = new Set<string>();
    let current = node.id as string;
    while (!visited.has(current)) {
      if (path.has(current)) throw new Error("导入失败：节点关系存在循环。");
      path.add(current);
      current = byId.get(current)!.parentId as string;
    }
    for (const id of path) visited.add(id);
  }
  const now = Date.now();
  function remap(value: unknown, label: string): string {
    const id = ids.get(string(value, label, true));
    if (!id) invalid(`${label}引用`);
    return id;
  }
  function parseNode(original: ObjectValue, label: string): StoredNode {
    const position = object(original.position, `${label}位置`);
    const status = enumeration(original.status, runStatuses, `${label}状态`);
    const interrupted = status === "queued" || status === "running";
    const createdAt = number(original.createdAt, `${label}创建时间`);
    const prompt = string(original.prompt, `${label}问题`);
    const response = string(original.response, `${label}回答`);
    const contextIds = array(original.contextIds, `${label}上下文`).map((id) =>
      string(id, `${label}上下文 ID`, true),
    );
    // Validate the exported context against the actual parent chain, walking only
    // the IDs already present in the payload, never recursively expanding trees.
    let parent = original.parentId;
    for (let i = contextIds.length - 1; i >= 0; i--) {
      if (contextIds[i] !== parent) invalid(`${label}上下文父链`);
      parent = byId.get(contextIds[i])?.parentId;
    }
    if (parent !== null) invalid(`${label}上下文父链`);
    const contextSet = new Set(contextIds);
    const sources: ContextSource[] | undefined =
      original.contextSources === undefined
        ? undefined
        : array(original.contextSources, `${label}上下文来源`).map((item) => {
            const source = object(item, `${label}上下文来源`);
            if (
              source.nodeId !== original.id &&
              !contextSet.has(source.nodeId as string)
            )
              invalid(`${label}上下文来源`);
            return {
              nodeId: remap(source.nodeId, label),
              revision: integer(source.revision, label),
              messageCount: integer(source.messageCount, label),
            };
          });
    const transcript = optional(
      original.messages,
      `${label}完整消息`,
      messages,
    );
    const startedAt = optional(original.startedAt, `${label}开始时间`, number);
    const finishedAt = optional(
      original.finishedAt,
      `${label}结束时间`,
      number,
    );
    const error = optional(original.error, `${label}错误`, string);
    const node: StoredNode = {
      id: remap(original.id, label),
      parentId:
        original.parentId === null ? null : remap(original.parentId, label),
      prompt,
      response,
      status: interrupted ? "failed" : status,
      config: config(original.config, `${label}配置`),
      color: enumeration(
        original.color,
        ["sage", "violet", "blue", "amber"] as const,
        `${label}颜色`,
      ),
      position: {
        x: coordinate(position.x, `${label}横坐标`),
        y: coordinate(position.y, `${label}纵坐标`),
      },
      contextIds: contextIds.map((id) => remap(id, label)),
      createdAt,
      ...(original.revision === undefined
        ? {}
        : { revision: integer(original.revision, `${label}版本`) }),
      ...(original.contextStale === undefined
        ? {}
        : {
            contextStale: boolean(original.contextStale, `${label}上下文状态`),
          }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(finishedAt === undefined && !interrupted
        ? {}
        : { finishedAt: interrupted ? now : finishedAt }),
      ...(error === undefined && !interrupted
        ? {}
        : {
            error: interrupted
              ? "此运行在导出时尚未完成，导入后已停止，未自动执行。"
              : error,
          }),
      ...(original.usage === undefined
        ? {}
        : { usage: nodeUsage(original.usage, `${label}用量`) }),
      ...(original.toolCalls === undefined
        ? {}
        : {
            toolCalls: toolCalls(original.toolCalls, `${label}工具记录`, now),
          }),
      ...(sources === undefined ? {} : { contextSources: sources }),
      ...(original.contextAutoCompact === undefined
        ? {}
        : { contextAutoCompact: boolean(original.contextAutoCompact, label) }),
      ...(original.contextMode === undefined
        ? {}
        : {
            contextMode: enumeration(
              original.contextMode,
              ["raw"] as const,
              label,
            ),
          }),
      ...(original.effectiveContextMode === undefined
        ? {}
        : {
            effectiveContextMode: enumeration(
              original.effectiveContextMode,
              ["raw"] as const,
              label,
            ),
          }),
      ...(transcript?.length
        ? { messages: transcript }
        : status === "root"
          ? {}
          : {
              messages: [
                {
                  role: "user",
                  content: `以下是从 JSON 导入的历史轮次：\n用户：${prompt}\n助手：${response}`,
                  timestamp: createdAt,
                },
              ],
            }),
      // Explicit allowlist: source paths, pending actions, request IDs, execution
      // snapshots cannot become live local state. Summaries are verified and
      // remapped separately after the complete raw graph has been parsed.
    };
    return node;
  }
  const importedNodes = [
    root,
    ...originals.filter((node) => node !== root),
  ].map((original, index) => {
    const label = `第 ${index + 1} 个节点`;
    const node = parseNode(original, label);
    if (original.previousRuns !== undefined) {
      node.previousRuns = array(original.previousRuns, `${label}历史版本`).map(
        (item): StoredRun => {
          const run = object(item, `${label}历史版本`);
          if (run.id !== original.id || run.parentId !== original.parentId)
            invalid(`${label}历史版本节点`);
          return {
            ...parseNode(run, `${label}历史版本`),
            archivedAt: number(run.archivedAt, `${label}归档时间`),
          };
        },
      );
    }
    return node;
  });
  if (source.example !== undefined) boolean(source.example, "探索示例标记");
  const imported: StoredWorkspace = {
    id: randomUUID(),
    title: string(source.title, "探索标题", true),
    description: string(source.description, "探索背景"),
    createdAt: number(source.createdAt, "探索创建时间"),
    updatedAt: number(source.updatedAt, "探索更新时间"),
    example: false,
    approvalMode: "ask",
    ...(source.autoCompact === undefined
      ? {}
      : { autoCompact: boolean(source.autoCompact, "自动压缩设置") }),
    nodes: importedNodes,
  };
  restoreImportedSummaries(imported, originals, ids);
  return imported;
}

/** A summary is inert data, but it can only become an input projection if its
 * original hash verifies and the remapped sources still describe the same raw
 * messages. Request ledgers and pending summary work are never restored. */
function restoreImportedSummaries(
  imported: StoredWorkspace,
  originals: ObjectValue[],
  ids: Map<string, string>,
) {
  const reverseIds = new Map(
    [...ids].map(([before, after]) => [after, before]),
  );
  const oldView: StoredWorkspace = {
    ...imported,
    nodes: imported.nodes.map((node) => ({
      ...node,
      id: reverseIds.get(node.id)!,
      parentId: node.parentId ? reverseIds.get(node.parentId)! : null,
    })),
  };
  const remapped = new Map<string, ContextCheckpoint>();
  const restoredByNode = new Map<string, Set<string>>();
  for (const original of originals) {
    const node = imported.nodes.find(
      (item) => item.id === ids.get(original.id as string),
    )!;
    let before: ReturnType<typeof buildContext>;
    let after: ReturnType<typeof buildContext>;
    try {
      before = buildContext(oldView, original.id as string);
      after = buildContext(imported, node.id);
    } catch {
      continue;
    }
    const restore = (value: unknown): ContextCheckpoint | undefined => {
      try {
        const source = object(value, "摘要");
        if (source.version !== 1) return;
        const candidate: ContextCheckpoint = {
          id: string(source.id, "摘要 ID", true),
          version: 1,
          sourceHash: string(source.sourceHash, "摘要来源", true),
          messageCount: integer(source.messageCount, "摘要消息数"),
          sources: array(source.sources, "摘要来源").map((item) => {
            const origin = object(item, "摘要来源");
            return {
              nodeId: string(origin.nodeId, "摘要节点", true),
              revision: integer(origin.revision, "摘要版本"),
              messageCount: integer(origin.messageCount, "摘要消息数"),
            };
          }),
          summary: string(source.summary, "摘要正文", true),
          model: string(source.model, "摘要模型", true),
          thinking: enumeration(
            source.thinking,
            thinkingLevels,
            "摘要思考强度",
          ),
          createdAt: number(source.createdAt, "摘要时间"),
          tokensBefore: number(source.tokensBefore, "摘要用量"),
          tokensAfter: number(source.tokensAfter, "摘要用量"),
          ...(source.usage === undefined
            ? {}
            : { usage: nodeUsage(source.usage, "摘要用量") }),
        };
        if (!checkpointMatches(candidate, before.messages, before.sources))
          return;
        const existing = remapped.get(candidate.id);
        const checkpoint: ContextCheckpoint = {
          ...candidate,
          id: existing?.id ?? randomUUID(),
          sources: candidate.sources.map((origin) => ({
            ...origin,
            nodeId: ids.get(origin.nodeId)!,
          })),
          sourceHash: contextSourceHash(
            after.messages,
            after.sources,
            candidate.messageCount,
          ),
        };
        if (!checkpointMatches(checkpoint, after.messages, after.sources))
          return;
        if (
          existing &&
          (existing.sourceHash !== checkpoint.sourceHash ||
            existing.summary !== checkpoint.summary)
        )
          return;
        remapped.set(candidate.id, checkpoint);
        const available = restoredByNode.get(node.id) ?? new Set<string>();
        available.add(checkpoint.id);
        restoredByNode.set(node.id, available);
        return checkpoint;
      } catch {
        return;
      }
    };
    const restoreList = (value: unknown) =>
      Array.isArray(value)
        ? value.flatMap((item) => {
            const checkpoint = restore(item);
            return checkpoint ? [checkpoint] : [];
          })
        : [];
    const compactions = restoreList(original.compactions);
    if (compactions.length) node.compactions = compactions;
    const prepared = [
      ...restoreList(original.preparedCompactions),
      ...(Array.isArray(original.preparationRequests)
        ? original.preparationRequests.flatMap((item) => {
            if (
              !item ||
              typeof item !== "object" ||
              item.status !== "completed"
            )
              return [];
            const checkpoint = restore(item.checkpoint);
            return checkpoint ? [checkpoint] : [];
          })
        : []),
    ];
    const latest = restore(original.preparedCompaction);
    if (latest) {
      node.preparedCompaction = latest;
      prepared.push(latest);
    }
    if (prepared.length)
      node.preparedCompactions = [
        ...new Map(prepared.map((item) => [item.id, item])).values(),
      ];
  }
  for (const original of originals) {
    const node = imported.nodes.find(
      (item) => item.id === ids.get(original.id as string),
    )!;
    if ((node.effectiveContextMode ?? node.contextMode) === "raw") {
      node.contextAutoCompact = false;
      continue;
    }
    const allowed = new Set(
      node.contextIds.flatMap((id) => [...(restoredByNode.get(id) ?? [])]),
    );
    const requested =
      typeof original.requestedContextCheckpointId === "string"
        ? remapped.get(original.requestedContextCheckpointId)
        : undefined;
    const effective =
      typeof original.effectiveContextCheckpointId === "string"
        ? remapped.get(original.effectiveContextCheckpointId)
        : requested;
    if (requested && allowed.has(requested.id))
      node.requestedContextCheckpointId = requested.id;
    if (effective && allowed.has(effective.id))
      node.effectiveContextCheckpointId = effective.id;
    if (original.contextState && typeof original.contextState === "object") {
      const state = original.contextState as ObjectValue;
      const checkpoint =
        typeof state.checkpointId === "string"
          ? remapped.get(state.checkpointId)
          : undefined;
      if (
        state.status === "compacted" &&
        checkpoint &&
        node.compactions?.some((item) => item.id === checkpoint.id)
      )
        node.contextState = {
          status: "compacted",
          updatedAt: Date.now(),
          checkpointId: checkpoint.id,
        };
    }
  }
}
