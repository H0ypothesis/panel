import type { Message } from "@earendil-works/pi-ai";
import { ancestorPath } from "../shared/types.ts";
import type { StoredWorkspace } from "./store.ts";

export const SYSTEM_PROMPT =
  "你是 Panel 工作台中的协作助手。使用用户的语言清晰、具体地回答。当前对话只包含根到当前分支的上下文，不要假设自己读过其他分支。不声称已执行你没有能力执行的操作。使用 Markdown 排版。";

export function buildContext(
  workspace: StoredWorkspace,
  parentId: string,
): { ids: string[]; messages: Message[] } {
  const path = ancestorPath(workspace.nodes, parentId);
  const messages: Message[] = [];
  for (const visible of path) {
    const node = workspace.nodes.find((item) => item.id === visible.id)!;
    if (node.contextStale)
      throw new Error("此路径包含已失效的上下文，请从最早失效的节点重新生成。");
    if (node.status !== "root" && node.status !== "completed")
      throw new Error("该节点尚未完成，请从其父节点创建分支。");
    if (node.status === "root") {
      messages.push({
        role: "user",
        content: `探索主题：${node.prompt}\n背景：${node.response}`,
        timestamp: node.createdAt,
      });
    } else if (node.messages?.length) {
      messages.push(...structuredClone(node.messages));
    } else {
      // The editorial example has no provider transcript. Preserve it as clearly identified history.
      messages.push({
        role: "user",
        content: `以下是本路径中的示例历史轮次：\n用户：${node.prompt}\n助手：${node.response}`,
        timestamp: node.createdAt,
      });
    }
  }
  return { ids: path.map((node) => node.id), messages };
}

export function estimateTokens(messages: Message[], prompt = ""): number {
  // Conservative bound for multilingual text; actual provider usage is displayed after completion.
  return Math.ceil(
    (JSON.stringify(messages).length + prompt.length + SYSTEM_PROMPT.length) *
      1.2,
  );
}
