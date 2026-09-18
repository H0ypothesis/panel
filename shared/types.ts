export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type RunStatus =
  | "root"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type BranchColor = "sage" | "violet" | "blue" | "amber";
export type ApprovalMode = "ask" | "auto";

export interface SafetyReviewRequest {
  model: string;
  workingDirectory?: string;
  workspaceTitle: string;
  workspaceDescription: string;
  userRequest: string;
  ancestry: { prompt: string; response: string }[];
  recentTools?: {
    name: string;
    arguments: Record<string, unknown>;
    status: string;
    output?: string;
  }[];
  tool: Pick<ToolCall, "id" | "name" | "arguments">;
}

export interface SafetyReviewResult {
  decision: "approve" | "deny";
  reason: string;
}

export interface SafetyReview {
  model: string;
  decision: "reviewing" | "approve" | "deny" | "error" | "cancelled";
  reason: string;
  startedAt: number;
  finishedAt?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status:
    | "reviewing"
    | "awaiting_approval"
    | "running"
    | "completed"
    | "failed"
    | "denied"
    | "cancelled";
  output?: string;
  error?: string;
  sources?: { title: string; url: string }[];
  approval?: "auto" | "policy" | "safety_model" | "approved" | "denied";
  safetyReview?: SafetyReview;
  // Audit metadata only. Live, single-use authorizations exist solely in memory.
  authorization?: {
    id: string;
    actionHash: string;
    policyVersion: string;
    issuedAt: number;
    expiresAt: number;
    consumedAt?: number;
    invalidatedAt?: number;
    invalidationReason?: string;
  };
  startedAt: number;
  finishedAt?: number;
}

export interface RunConfig {
  model: string;
  thinking: ThinkingLevel;
}

export interface TurnNode {
  id: string;
  /** In-place regeneration revision; legacy nodes start at zero. */
  revision?: number;
  /** An ancestor was regenerated; this answer must be regenerated before reuse. */
  contextStale?: boolean;
  parentId: string | null;
  prompt: string;
  response: string;
  status: RunStatus;
  config: RunConfig;
  color: BranchColor;
  position: { x: number; y: number };
  contextIds: string[];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  usage?: { input: number; output: number; total: number; cost?: number };
  requestId?: string;
  execution?: {
    workingDirectory?: string;
    approvalMode: ApprovalMode;
    safetyModel?: string;
  };
  toolCalls?: ToolCall[];
}

export interface Workspace {
  id: string;
  title: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  example: boolean;
  /** Server-derived, stable default directory named after this workspace's ID. */
  temporaryDirectory?: string;
  /** Explicit user-selected directory; otherwise temporaryDirectory is used. */
  workingDirectory?: string;
  approvalMode?: ApprovalMode;
  safetyModel?: string;
  gitHistory?: GitHistoryEntry[];
  nodes: TurnNode[];
}

export interface GitHistoryEntry {
  id: string;
  nodeId: string;
  nodeRevision: number;
  nodePrompt: string;
  toolCallId: string;
  toolName: string;
  workingDirectory: string;
  createdAt: number;
  summary: string;
  status: "recording" | "completed" | "failed";
  files: { path: string; status: "added" | "modified" | "deleted" }[];
  commit?: string;
  parentCommit?: string;
  error?: string;
  interrupted?: boolean;
}

export interface AppState {
  instanceId: string;
  revision: number;
  workspaces: Workspace[];
  storageError?: string;
}

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  available: boolean;
  demo: boolean;
  default?: boolean;
  thinkingLevels: ThinkingLevel[];
  contextWindow: number;
  envVar?: string;
}

export interface WebCapabilities {
  webFetch: boolean;
  webSearch: boolean;
  searchProvider: "Exa API" | "Exa MCP";
  searchKeyEnv: "EXA_API_KEY";
  searchKeyRequired: false;
  plugin: "pi-web-access";
  pluginVersion: "0.29.0";
  pdfRead: boolean;
}

export const thinkingLabels: Record<ThinkingLevel, string> = {
  off: "关闭",
  minimal: "极低",
  low: "轻量",
  medium: "标准",
  high: "深入",
  xhigh: "极高",
  max: "最高",
};

export const statusLabels: Record<RunStatus, string> = {
  root: "探索起点",
  queued: "排队中",
  running: "生成中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
};

export const DEFAULT_CONFIG: RunConfig = {
  model: "demo/pi-demo",
  thinking: "medium",
};

export function ancestorPath(nodes: TurnNode[], nodeId: string): TurnNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const path: TurnNode[] = [];
  let current: string | null = nodeId;
  while (current) {
    if (seen.has(current)) throw new Error("对话图存在循环。");
    seen.add(current);
    const node = byId.get(current);
    if (!node) throw new Error("上下文节点不存在。");
    path.unshift(node);
    current = node.parentId;
  }
  if (!path.length || path[0].status !== "root")
    throw new Error("上下文缺少根节点。");
  return path;
}

export function layoutTree(
  nodes: TurnNode[],
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const children = new Map<string, TurnNode[]>();
  for (const node of nodes) {
    if (node.parentId)
      children.set(node.parentId, [
        ...(children.get(node.parentId) ?? []),
        node,
      ]);
  }
  let row = 0;
  const visit = (node: TurnNode, depth: number): number => {
    const descendants = children.get(node.id) ?? [];
    const ys = descendants.map((child) => visit(child, depth + 1));
    const y = ys.length ? (ys[0] + ys[ys.length - 1]) / 2 : row++ * 250;
    positions.set(node.id, { x: depth * 360 + 80, y: y + 70 });
    return y;
  };
  const root = nodes.find((node) => node.parentId === null);
  if (root) visit(root, 0);
  return positions;
}
