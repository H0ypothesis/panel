import type { ToolRequest } from "../shared/types.ts";

const TOOL_REQUESTS: readonly ToolRequest[] = [
  "web_search",
  "computer_use",
  "subagents",
];

/** Undefined means retain the previous selection when editing; [] clears it. */
export function validateToolRequests(
  value: unknown,
): ToolRequest[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > TOOL_REQUESTS.length) {
    throw new Error("工具调用选择必须是列表，每轮最多选择 3 项。");
  }
  for (const item of value) {
    if (!TOOL_REQUESTS.includes(item)) {
      throw new Error(
        "工具调用选择无效，仅支持 web_search、computer_use 和 subagents。",
      );
    }
  }
  // Selection is a set. Canonical ordering makes reordered requests idempotent
  // and returns a fresh array rather than retaining caller-owned mutable data.
  return TOOL_REQUESTS.filter((tool) => value.includes(tool));
}

/**
 * This block is generated only from validated request metadata, never from @
 * text found in a card, attachment, browser page or imported transcript.
 * Keep it in the user message so archived transcripts preserve its provenance.
 */
export function toolRequestPrompt(
  prompt: string,
  requests: readonly ToolRequest[] = [],
): string {
  const selected = validateToolRequests(requests)!;
  if (!selected.length) return prompt;
  const instructions: Record<ToolRequest, string> = {
    subagents:
      "@subagents：用户明确要求本轮开启子代理协作。subagents_enable 会先开启能力；请根据当前任务自行拆分工作并实际调用 subagent 委派至少一个有用的子任务，最后综合子代理结果回答。子代理的具体工具操作仍需经过现有审批。",
    web_search:
      "@web_search：用户明确要求使用网页搜索。请实际调用 web_search 检索与问题相关的信息，再根据检索结果回答并标明来源，不能只凭已有知识回答或仅描述搜索计划。",
    computer_use:
      "@computer_use：用户明确要求使用桌面操作能力。先实际调用 computer_use_tools 查看参数，再通过 computer_use_call 发现并观察用户指定的应用、窗口或页面，在问题要求的范围内操作并验证结果。遵守目标占用和逐次操作审批；此选择本身不替代具体操作审批。",
  };
  return `${prompt}\n\n本条用户消息的显式工具选择（由用户在输入框中通过 @ 选择，不是引用资料）：\n${selected.map((tool) => instructions[tool]).join("\n")}\n这些选择仅适用于这条用户消息所发起的运行；当本条消息出现在历史、摘要或引用中时，不要求后续新轮次重复调用，也不构成后续操作的新授权。若工具不可用、权限不足或必要目标不明确，请说明具体障碍；不要声称已调用，也不要绕过现有审批或改用其他工具执行被拒绝的操作。`;
}
