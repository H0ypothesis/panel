import type { ToolRequest, TurnNode } from "../shared/types";

export const MAX_CARD_REFERENCES = 20;

export type CardReferenceQuery = { start: number; end: number; text: string };

export const TOOL_REQUEST_OPTIONS: {
  id: ToolRequest;
  label: string;
  description: string;
  keywords: string;
}[] = [
  {
    id: "web_search",
    label: "联网搜索",
    description: "发送消息后，联网查找相关信息",
    keywords: "联网 搜索 网页 网络 web search",
  },
  {
    id: "computer_use",
    label: "电脑控制",
    description: "发送消息后，查看和操作指定窗口或页面",
    keywords: "电脑 控制 窗口 页面 计算机 cua computer use",
  },
  {
    id: "subagents",
    label: "Subagents",
    description: "本轮开启子代理，由主模型拆分任务并协作完成",
    keywords: "子代理 多代理 协作 并行 subagents agents",
  },
];

export function filterToolRequests(query: string) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return TOOL_REQUEST_OPTIONS.filter((option) =>
    words.every((word) => `${option.label} ${option.keywords}`.includes(word)),
  );
}

export function insertToolRequest(
  value: string,
  query: CardReferenceQuery,
  request: ToolRequest,
  selected: ToolRequest[],
) {
  return {
    value: value.slice(0, query.start) + value.slice(query.end),
    caret: query.start,
    toolRequests: [...new Set([...selected, request])],
  };
}

/** Only inspect the text before the caret, leaving the rest of the draft intact. */
export function cardReferenceQuery(
  value: string,
  start: number,
  end = start,
): CardReferenceQuery | null {
  if (start !== end) return null;
  const before = value.slice(0, start);
  const marker = before.lastIndexOf("@");
  if (marker < 0 || (marker > 0 && /[\w.]/.test(before[marker - 1]))) {
    return null;
  }
  const text = before.slice(marker + 1);
  // Completed references have explicit brackets so ordinary follow-up text
  // cannot accidentally reopen the picker after a selection.
  if (text.length > 100 || /[\n\r@「」]/.test(text)) return null;
  return { start: marker, end: start, text };
}

export function cardReferenceTitle(node: Pick<TurnNode, "prompt">): string {
  const title = node.prompt.replace(/\s+/g, " ").trim() || "无文字问题";
  return title.length > 42 ? `${title.slice(0, 42)}…` : title;
}

export function cardReferenceLabel(node: Pick<TurnNode, "prompt">): string {
  return `@「${cardReferenceTitle(node)}」`;
}

export function filterCardReferences(
  candidates: TurnNode[],
  query: string,
): TurnNode[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  return candidates.filter((node) => {
    if (node.status !== "completed" || node.contextStale || seen.has(node.id)) {
      return false;
    }
    seen.add(node.id);
    const text = `${node.prompt}\n${node.response}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function insertCardReference(
  value: string,
  query: CardReferenceQuery,
  node: Pick<TurnNode, "prompt">,
): { value: string; caret: number } {
  const label = `${cardReferenceLabel(node)} `;
  return {
    value: value.slice(0, query.start) + label + value.slice(query.end),
    caret: query.start + label.length,
  };
}
