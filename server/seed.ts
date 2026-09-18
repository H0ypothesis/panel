import { randomUUID } from "node:crypto";
import {
  DEFAULT_CONFIG,
  layoutTree,
  type BranchColor,
  type Workspace,
} from "../shared/types.ts";

export function createWorkspace(title: string, description: string): Workspace {
  const now = Date.now();
  return {
    id: randomUUID(),
    title,
    description,
    createdAt: now,
    updatedAt: now,
    example: false,
    nodes: [
      {
        id: randomUUID(),
        parentId: null,
        prompt: title,
        response: description,
        status: "root",
        config: { ...DEFAULT_CONFIG },
        color: "sage",
        position: { x: 80, y: 200 },
        contextIds: [],
        createdAt: now,
      },
    ],
  };
}

export function exampleWorkspace(): Workspace {
  const workspace = createWorkspace(
    "重新想象 AI 工作流",
    "如果思考不必沿着一条线进行，人和 AI 可以怎样一起探索？",
  );
  workspace.example = true;
  const root = workspace.nodes[0];
  const add = (
    parentId: string,
    prompt: string,
    response: string,
    color: BranchColor,
    thinking: "medium" | "high" = "medium",
  ) => {
    const id = randomUUID();
    const parent = workspace.nodes.find((node) => node.id === parentId)!;
    workspace.nodes.push({
      id,
      parentId,
      prompt,
      response,
      color,
      config: { ...DEFAULT_CONFIG, thinking },
      status: "completed",
      position: { x: 0, y: 0 },
      contextIds: [...parent.contextIds, parentId],
      createdAt: Date.now(),
      finishedAt: Date.now(),
    });
    return id;
  };
  const a = add(
    root.id,
    "从用户的真实工作方式出发",
    "### 思考本来就不是一条直线\n\n研究问题时，我们会提出假设、比较方案，也会退回早先的分歧点。线性聊天让这些动作变得昂贵。\n\n- **保留分歧**：每个值得追问的方向成为分支。\n- **看见来源**：每个结论都能沿路径追溯。\n- **自由切换**：一个方向生成时，可以继续另一个方向。\n\n先从一个具体场景开始：产品团队同时探索用户需求、交互方案与技术边界。",
    "sage",
  );
  const b = add(
    root.id,
    "探索非线性的交互方式",
    "### 让对话成为一张可以操作的地图\n\n画布承载全局结构，侧边面板承载深度阅读。一个节点只展示本轮的核心信息，完整回答在选中后展开。\n\n创建分支应该像在纸上画一根线一样自然：选择一个历史节点，写下新的问题。\n\n**关键原则**：界面始终告诉用户，现在从哪里出发，以及模型会读到什么。",
    "violet",
    "high",
  );
  const c = add(
    root.id,
    "如何让多条探索同时推进？",
    "### 独立上下文，独立执行\n\n每条新分支都从父节点复制自己的上下文快照，交给独立的 Pi Agent 执行。\n\n1. 收集根到父节点的消息。\n2. 固定本轮模型与思考强度。\n3. 在后台运行并流式更新节点。\n4. 将结果保存回当前节点。\n\n取消某一条分支，不应该中断其他探索。",
    "blue",
  );
  add(
    a,
    "把「方案比较」作为第一个场景",
    "### 从同一份背景，走向不同的答案\n\n在同一节点下分别探索两种方案，能保留一致的前提，并清楚看见取舍。\n\n建议先比较：\n- 以画布为中心的工作方式。\n- 以文档为中心的工作方式。\n\n下一步可以为每种方案提出同一个约束：第一次使用，能否在一分钟内理解？",
    "sage",
  );
  add(
    b,
    "画布和阅读面板如何配合？",
    "### 全局可见，局部专注\n\n画布负责回答“我在哪里”；详情面板负责回答“这一轮说了什么”。\n\n节点卡片保留问题、简短回答、模型和状态。选中后，高亮从根到当前节点的路径，让上下文边界可见。\n\n输入区固定在面板底部，不因回答变长而丢失。",
    "violet",
  );
  add(
    c,
    "避免不同分支的上下文串线",
    "### 由父链决定上下文\n\n不从全局聊天记录截取消息，而是由服务端从 parentId 沿树回溯。\n\n```text\n起点 → A → B → 新问题\n        ↘ C（不会被继承）\n```\n\n为这个规则编写测试：兄弟分支、后代节点与其他探索空间的内容，都不能进入本轮请求。",
    "blue",
    "high",
  );
  const positions = layoutTree(workspace.nodes);
  workspace.nodes.forEach((node) => {
    node.position = positions.get(node.id)!;
  });
  return workspace;
}
