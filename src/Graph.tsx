import { memo, useEffect, useMemo, useState } from "react";
import { thinkingDescription } from "../shared/thinking-controls";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  MiniMap,
  Panel,
  applyNodeChanges,
  useReactFlow,
  useStore,
  useStoreApi,
  ViewportPortal,
  getBezierPath,
  type Node,
  type NodeProps,
  type NodeChange,
  type Edge,
  type Connection,
} from "@xyflow/react";
import {
  ArrowUpRight,
  Check,
  Circle,
  GitBranch,
  LayoutGrid,
  Maximize,
  Minus,
  Plus,
  Scan,
  Sparkles,
  Square,
  AlertCircle,
  LoaderCircle,
  ShieldQuestion,
  FolderOpen,
  Pencil,
  Trash2,
  RefreshCw,
  Layers,
  Paperclip,
  AtSign,
} from "lucide-react";
import {
  ancestorPath,
  layoutTree,
  type TurnNode,
  type Workspace,
  type ModelOption,
  type RunConfig,
  type ToolRequest,
  type ContextParent,
} from "../shared/types";
import { readPreference, savePreference } from "./api";
import { toolWaitLabel } from "./computer-use";
import { responseText } from "../shared/response-parts";
import { canBranchFrom } from "../shared/node-branching";
import {
  buildContextUsageMap,
  type ContextUsage,
} from "../shared/context-usage";
import { ContextUsageRing } from "./ContextUsageRing";
import { formatContextWindow } from "./model-context";
import { GitHistoryPanel } from "./GitHistoryPanel";
import { BranchDraftCard, type BranchDraftNode } from "./BranchDraftCard";
import { LongTaskBadge } from "./LongTaskControls";
import { reconcileGraphNodes } from "./graph-nodes";
import { buildReferenceEdges } from "./reference-edges";
import {
  branchDraftHeight,
  branchDraftPosition,
  draftContextParents,
  draftConnectionParent,
  canConnectDraftParent,
  type CanvasBranchDraft,
} from "./branch-draft";
import {
  buildCompressionNodes,
  compressionNodeId,
  COMPRESSION_NODE_SIZE,
  type CompressionGraphEntry,
} from "../shared/context-graph";
import "./compression-graph.css";
import { SubagentAvatars } from "./Subagents";

type CardData = {
  turn: TurnNode;
  index: number;
  active: boolean;
  inPath: boolean;
  modelName: string;
  contextUsage: ContextUsage;
  showContext: (id: string) => void;
  showSubagents: (id: string, childId: string) => void;
  workingDirectory?: string;
  temporaryDirectory?: string;
  chooseDirectory: () => void;
  directoryDisabled: boolean;
  branch: (id: string) => void;
  branchDisabled: boolean;
  edit: (id: string) => void;
  delete: (id: string) => void;
  actionsDisabled: boolean;
  retry: (id: string) => void;
  retryBusy: boolean;
  retryDisabledReason: string;
  connectable: boolean;
  compressedEntry: boolean;
};
type TurnGraphNode = Node<CardData, "turn">;
type CompressionGraphNode = Node<
  {
    entry: CompressionGraphEntry;
    ordinal: number;
    parentTitle: string;
    active: boolean;
    inPath: boolean;
    branchDisabled: boolean;
    branch: (parentId: string, checkpointId: string) => void;
    show: (parentId: string, checkpointId: string) => void;
    connectable: boolean;
  },
  "compression"
>;
type GraphNode = TurnGraphNode | BranchDraftNode | CompressionGraphNode;
const colors = {
  sage: "var(--branch-green)",
  violet: "var(--branch-purple)",
  blue: "var(--branch-blue)",
  amber: "var(--branch-orange)",
};

export const StatusIcon = ({ status }: { status: TurnNode["status"] }) => {
  if (status === "running") return <LoaderCircle size={12} className="spin" />;
  if (status === "queued") return <Circle size={11} className="pulse" />;
  if (status === "completed") return <Check size={12} />;
  if (status === "failed") return <AlertCircle size={12} />;
  if (status === "cancelled") return <Square size={10} />;
  return <Sparkles size={12} />;
};

function plainText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[#*`>]/g, "")
    .replace(/\n+/g, " ")
    .trim();
}

const TurnCard = memo(function TurnCard({ data }: NodeProps<TurnGraphNode>) {
  const { turn, index, active, inPath, modelName, branch } = data;
  const root = turn.status === "root";
  const retryable = turn.status === "failed" || turn.status === "cancelled";
  const pendingApproval = turn.toolCalls?.some(
    (call) => call.status === "awaiting_approval",
  );
  const reviewing = turn.toolCalls?.some((call) => call.status === "reviewing");
  const waitingCall = turn.toolCalls?.find(
    (call) => call.status === "running" && call.waitingFor,
  );
  const waitingFor = waitingCall?.waitingFor;
  return (
    <div
      className={`turn-card ${root ? "root-card" : ""} color-${turn.color} ${active ? "active" : ""} ${inPath ? "in-path" : ""} ${data.compressedEntry ? "compression-entry-card" : ""} status-${turn.status} ${turn.subagents?.length ? "has-subagents" : ""}`}
    >
      {!root && (
        <Handle
          type="target"
          position={Position.Left}
          isConnectable={false}
          isConnectableStart={false}
          isConnectableEnd={false}
        />
      )}
      <div className="card-topline">
        <span className="card-kind">
          {root ? <Sparkles size={13} /> : <span className="branch-dot" />}
          {root ? "探索起点" : `对话 ${String(index).padStart(2, "0")}`}
        </span>
        <div className="card-topline-tools">
          {!!turn.attachments?.length && (
            <span
              className="card-attachment-count"
              aria-label={`${turn.attachments.length} 个附件`}
              title={turn.attachments
                .map((attachment) => attachment.name)
                .join("\n")}
            >
              <Paperclip size={11} />
              {turn.attachments.length}
            </span>
          )}
          <span
            className={`card-status ${turn.status} ${turn.contextStale ? "context-stale" : ""}`}
            title={
              turn.contextStale
                ? "上游节点已修改，请编辑此节点并重新生成后再创建分支"
                : turn.status === "completed"
                  ? "已完成"
                  : waitingFor
            }
          >
            {turn.contextStale ? (
              <AlertCircle size={12} />
            ) : pendingApproval ? (
              <ShieldQuestion size={12} />
            ) : (
              <StatusIcon status={turn.status} />
            )}
            {turn.contextStale
              ? "上下文已更新"
              : pendingApproval
                ? "等待批准"
                : reviewing
                  ? "安全审核中"
                  : waitingFor
                    ? toolWaitLabel(waitingCall!)
                    : turn.status === "running"
                      ? turn.connectionRetry
                        ? `正在重连 ${turn.connectionRetry.attempt}/${turn.connectionRetry.maxAttempts}`
                        : "生成中"
                      : turn.status === "queued"
                        ? "排队中"
                        : turn.status === "failed"
                          ? "失败"
                          : turn.status === "cancelled"
                            ? "已停止"
                            : ""}
          </span>
          {!root && (
            <div className="card-node-actions nodrag nopan">
              <button
                type="button"
                className="card-node-action nodrag nopan"
                disabled={data.actionsDisabled}
                aria-label={`编辑「${turn.prompt}」并重新生成`}
                title={`编辑「${turn.prompt}」并重新生成`}
                aria-haspopup="dialog"
                onClick={(event) => {
                  event.stopPropagation();
                  data.edit(turn.id);
                }}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                className="card-node-action delete nodrag nopan"
                disabled={data.actionsDisabled}
                aria-label={`删除「${turn.prompt}」`}
                title={`删除「${turn.prompt}」`}
                aria-haspopup="dialog"
                onClick={(event) => {
                  event.stopPropagation();
                  data.delete(turn.id);
                }}
                onKeyDown={(event) => event.stopPropagation()}
              >
                <Trash2 size={12} />
              </button>
            </div>
          )}
        </div>
      </div>
      <h3>{turn.prompt}</h3>
      <p className="card-preview">
        {plainText(
          root
            ? turn.response
            : responseText(turn.response, turn.status === "running"),
        ) ||
          (root
            ? "从一个问题开始探索，文件默认保存在空间临时目录。"
            : pendingApproval
              ? "工具操作等待你的批准，点击查看审核理由与操作详情。"
              : reviewing
                ? "安全模型正在审核工具操作，通过前不会执行。"
                : waitingFor
                  ? waitingFor
                  : turn.status === "failed"
                    ? turn.error
                    : turn.status === "queued"
                      ? "等待目录维护完成…"
                      : turn.status === "cancelled"
                        ? "这次探索已停止，原有分支依然保留。"
                        : "正在沿着这个方向思考…")}
      </p>
      {retryable && (
        <button
          type="button"
          className="card-retry-button nodrag nopan"
          disabled={
            data.retryBusy || data.actionsDisabled || !!data.retryDisabledReason
          }
          aria-label={`原地重试「${turn.prompt}」`}
          title={
            data.retryBusy
              ? "正在恢复文件并重新生成"
              : data.retryDisabledReason ||
                (data.actionsDisabled
                  ? "请等待当前操作或后续节点的任务结束"
                  : "恢复本卡片本轮修改的文件，再使用原指令和模型重新生成")
          }
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            data.retry(turn.id);
          }}
        >
          {data.retryBusy ? (
            <LoaderCircle size={12} className="spin" />
          ) : (
            <RefreshCw size={12} />
          )}
          {data.retryBusy ? "正在恢复…" : "原地重试"}
        </button>
      )}
      <SubagentAvatars
        runs={turn.subagents ?? []}
        onSelect={(childId) => data.showSubagents(turn.id, childId)}
      />
      <div className="card-footer">
        {root ? (
          <button
            type="button"
            className="card-directory nodrag nopan"
            disabled={data.directoryDisabled}
            aria-label={
              data.workingDirectory ? "更换本地项目" : "临时目录，选择本地项目"
            }
            aria-haspopup="dialog"
            title={
              data.directoryDisabled
                ? "请等待连接恢复或当前操作完成；有运行或排队任务时不能更换目录"
                : (data.workingDirectory ??
                  data.temporaryDirectory ??
                  "使用空间临时目录，也可选择本地项目")
            }
            onClick={(event) => {
              event.stopPropagation();
              data.chooseDirectory();
            }}
          >
            <FolderOpen size={13} />
            <span>
              {data.workingDirectory?.split(/[\\/]/).filter(Boolean).at(-1) ??
                (data.workingDirectory || "临时目录")}
            </span>
            <ArrowUpRight size={12} />
          </button>
        ) : (
          <span className="card-model">
            <span className="model-symbol">π</span>
            <span className="card-model-name" title={modelName}>
              {modelName}
            </span>
            <span className="footer-dot">·</span>
            <span className="card-thinking">
              {thinkingDescription(turn.config)}
            </span>
            <LongTaskBadge
              config={turn.config}
              status={turn.status}
              toolRequests={turn.toolRequests}
              toolCalls={turn.toolCalls}
              subagentsEnabled={turn.subagentsEnabled}
              compact
            />
          </span>
        )}
        <div className="card-footer-actions">
          {!root && (
            <button
              type="button"
              className="card-token-usage nodrag nopan"
              aria-label={`「${turn.prompt}」token 用量：${turn.usage ? `输入 ${turn.usage.input.toLocaleString("zh-CN")}，输出 ${turn.usage.output.toLocaleString("zh-CN")}` : "暂无计数"}，点击查看上下文`}
              title={
                turn.usage
                  ? `左侧：输入 ${turn.usage.input.toLocaleString("zh-CN")} tokens\n右侧：输出 ${turn.usage.output.toLocaleString("zh-CN")} tokens\n统计本卡片任务内各次模型调用的累计用量。\n点击查看上下文。`
                  : "左侧为输入 token 数，右侧为输出 token 数；当前暂无计数。点击查看上下文。"
              }
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                data.showContext(turn.id);
              }}
            >
              {turn.usage
                ? `${turn.usage.input === 0 ? "0" : formatContextWindow(turn.usage.input)} / ${turn.usage.output === 0 ? "0" : formatContextWindow(turn.usage.output)}`
                : "— / —"}
            </button>
          )}
          <ContextUsageRing
            usage={data.contextUsage}
            modelName={root ? `${modelName}（当前输入框模型）` : modelName}
          />
        </div>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={data.connectable}
        isConnectableStart={false}
        isConnectableEnd={data.connectable}
        aria-label={`接入「${turn.prompt}」的分支`}
      />
      <Handle
        id="reference-source"
        type="source"
        position={Position.Bottom}
        className="reference-handle"
        isConnectable={false}
        aria-hidden="true"
      />
      <Handle
        id="reference-target"
        type="target"
        position={Position.Top}
        className="reference-handle"
        isConnectable={false}
        aria-hidden="true"
      />
      {canBranchFrom(turn) && (
        <button
          type="button"
          className="card-branch-button nodrag nopan"
          disabled={data.branchDisabled}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            branch(turn.id);
          }}
          title={
            data.branchDisabled
              ? "问题正在提交，请稍候"
              : retryable
                ? "保留已有进度，从当前节点继续新分支"
                : "沿当前分支增加新问题"
          }
          aria-label={`从「${turn.prompt}」创建分支`}
        >
          <span className="card-branch-circle">
            <Plus size={17} />
          </span>
        </button>
      )}
    </div>
  );
});
const CompressionNode = memo(function CompressionNode({
  data,
}: NodeProps<CompressionGraphNode>) {
  const { entry } = data;
  return (
    <div
      className={`compression-node ${data.active ? "active" : ""} ${data.inPath ? "in-path" : ""} ${entry.usable || entry.kind === "merge" ? "" : "stale"}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        isConnectableStart={false}
        isConnectableEnd={false}
      />
      <button
        type="button"
        className="compression-node-body nodrag nopan"
        aria-label={`查看「${data.parentTitle}」的${entry.kind === "merge" ? "融合压缩" : "压缩摘要"} ${data.ordinal}`}
        title={`${entry.kind === "merge" ? "融合压缩" : "压缩摘要"} ${data.ordinal} · ${new Date(entry.checkpoint.createdAt).toLocaleString("zh-CN")}\n${entry.checkpoint.tokensBefore.toLocaleString("zh-CN")} → ${entry.checkpoint.tokensAfter.toLocaleString("zh-CN")} tokens\n${entry.kind === "merge" ? "多个分支已整体压缩，回答使用此摘要。点击查看摘要。" : entry.usable ? "点击查看摘要，悬停右侧连接点可新增分支" : "原路径已更新，可查看摘要，请重新压缩后继续"}`}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          data.show(entry.parentId, entry.checkpoint.id);
        }}
      >
        <Layers size={20} aria-hidden="true" />
      </button>
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={data.connectable}
        isConnectableStart={false}
        isConnectableEnd={data.connectable}
        aria-label={`接入「${data.parentTitle}」的压缩摘要 ${data.ordinal}`}
      />
      {entry.kind !== "merge" && (
        <button
          type="button"
          className="card-branch-button compression-node-branch nodrag nopan"
          disabled={data.branchDisabled || !entry.usable}
          aria-label={`从「${data.parentTitle}」的压缩摘要 ${data.ordinal} 创建分支`}
          title={
            !entry.usable
              ? "原路径已更新，请重新压缩"
              : data.branchDisabled
                ? "问题正在提交，请稍候"
                : "使用此压缩摘要增加新问题"
          }
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            data.branch(entry.parentId, entry.checkpoint.id);
          }}
        >
          <span className="card-branch-circle">
            <Plus size={17} aria-hidden="true" />
          </span>
        </button>
      )}
    </div>
  );
});
const nodeTypes = {
  turn: TurnCard,
  branchDraft: BranchDraftCard,
  compression: CompressionNode,
};

/** React Flow supports two-click connections; add a line that follows the pointer. */
function DraftClickConnection({
  draftId,
  color,
}: {
  draftId: string;
  color: string;
}) {
  const flow = useReactFlow();
  const started = useStore(
    (state) =>
      state.connectionClickStartHandle?.nodeId === draftId &&
      !state.connection.inProgress,
  );
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    setPointer(null);
    if (!started) return;
    const move = (event: PointerEvent) =>
      setPointer(
        flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      );
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, [started, flow]);
  const draft = flow.getNode(draftId);
  if (!started || !pointer || !draft) return null;
  const [path] = getBezierPath({
    sourceX: draft.position.x,
    sourceY:
      draft.position.y + (draft.measured?.height ?? draft.height ?? 374) / 2,
    sourcePosition: Position.Left,
    targetX: pointer.x,
    targetY: pointer.y,
    targetPosition: Position.Right,
  });
  return (
    <ViewportPortal>
      <svg
        className="draft-click-connection"
        width="1"
        height="1"
        aria-hidden="true"
      >
        <path
          d={path}
          fill="none"
          stroke={color}
          strokeWidth={1.8}
          strokeDasharray="5 5"
        />
      </svg>
    </ViewportPortal>
  );
}

interface Props {
  colorMode: "light" | "dark";
  workspace: Workspace;
  selectedId: string;
  selectedCompressionId?: string;
  models: ModelOption[];
  rootModelId: string;
  onSelect: (id: string) => void;
  onShowContext: (id: string) => void;
  onShowSubagents: (id: string, childId: string) => void;
  onShowCompression: (parentId: string, checkpointId: string) => void;
  onBranch: (id: string, checkpointId?: string) => void;
  branchDisabled: boolean;
  draft: CanvasBranchDraft | null;
  draftBusy: boolean;
  draftCompacting: boolean;
  draftCompactBlockedReason?: string;
  draftBlockedReason: string;
  onDraftTextChange: (text: string) => void;
  onDraftFilesChange: (files: File[]) => void;
  onDraftReferencesChange: (ids: string[]) => void;
  onDraftToolRequestsChange: (requests: ToolRequest[]) => void;
  onDraftConfigChange: (config: RunConfig) => void;
  onDraftSubmit: () => void;
  onDraftCancel: () => void;
  onDraftCompact: () => void;
  onDraftCompactCancel: () => void;
  onDraftConnect: (parent: ContextParent) => void;
  onDraftDisconnect: (nodeId: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  nodeActionsDisabled: boolean;
  onRetry: (id: string) => void;
  retryingId: string | null;
  retryDisabledReason: string;
  onChooseDirectory: () => void;
  directoryDisabled: boolean;
  onPositions: (positions: Record<string, { x: number; y: number }>) => void;
  focusId: string | null;
  focusVersion: number;
}

export function Graph({
  colorMode,
  workspace,
  selectedId,
  selectedCompressionId,
  models,
  rootModelId,
  onSelect,
  onShowContext,
  onShowSubagents,
  onShowCompression,
  onBranch,
  branchDisabled,
  draft,
  draftBusy,
  draftCompacting,
  draftCompactBlockedReason,
  draftBlockedReason,
  onDraftTextChange,
  onDraftFilesChange,
  onDraftReferencesChange,
  onDraftToolRequestsChange,
  onDraftConfigChange,
  onDraftSubmit,
  onDraftCancel,
  onDraftCompact,
  onDraftCompactCancel,
  onDraftConnect,
  onDraftDisconnect,
  onEdit,
  onDelete,
  nodeActionsDisabled,
  onRetry,
  retryingId,
  retryDisabledReason,
  onChooseDirectory,
  directoryDisabled,
  onPositions,
  focusId,
  focusVersion,
}: Props) {
  const flow = useReactFlow<GraphNode>();
  const flowStore = useStoreApi();
  const connecting = useStore((state) =>
    Boolean(state.connectionClickStartHandle || state.connection.inProgress),
  );
  const [zoom, setZoom] = useState(1);
  const [showMap, setShowMap] = useState(true);
  const [showReferences, setShowReferences] = useState(
    () => readPreference("show-reference-edges") === "true",
  );
  const [expandedDraftSummaryId, setExpandedDraftSummaryId] =
    useState<string>();
  const draftSummaryOpen = Boolean(
    draft?.mergedCheckpoint &&
      draft.mergedCheckpoint.id === expandedDraftSummaryId,
  );
  const compressionNodes = useMemo(
    () => buildCompressionNodes(workspace.nodes),
    [workspace.nodes],
  );
  const draftParents = useMemo(
    () => (draft ? draftContextParents(draft) : []),
    [draft],
  );
  const connectionParent = (sourceId: string) => {
    if (!draft || draftBusy || sourceId === draft.id) return;
    const parent = draftConnectionParent(
      sourceId,
      workspace.nodes,
      compressionNodes,
    );
    return parent && canConnectDraftParent(draftParents, parent)
      ? parent
      : undefined;
  };
  const validConnection = (connection: Connection | Edge) =>
    connection.target === draft?.id &&
    Boolean(connectionParent(connection.source));
  const cancelConnection = () => {
    flowStore.setState({ connectionClickStartHandle: null });
    flowStore.getState().cancelConnection();
  };
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      flowStore.setState({ connectionClickStartHandle: null });
      flowStore.getState().cancelConnection();
    };
    // Draft inputs stop bubbling keyboard events; cancellation still works
    // while the text field keeps focus during a two-click connection.
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [flowStore]);
  useEffect(() => {
    cancelConnection();
  }, [draft?.id, draftBusy]);
  const draftCompression = draft?.contextCheckpointId
    ? compressionNodes.find(
        (node) =>
          node.id ===
          compressionNodeId(draft.parentId, draft.contextCheckpointId!),
      )
    : undefined;
  const draftParent = workspace.nodes.find(
    (node) => node.id === draft?.parentId,
  );
  const draftPosition = useMemo(
    () =>
      draft
        ? branchDraftPosition(
            workspace.nodes,
            draftParent?.position ?? draft.parentPosition,
            draftCompression?.position,
            draft.files.length,
            draft.referenceNodeIds.length,
            draftParents.length,
            draftSummaryOpen,
            draft.toolRequests?.length,
          )
        : null,
    [
      workspace.nodes,
      draft?.id,
      draft?.contextCheckpointId,
      draft?.files.length,
      draft?.referenceNodeIds.length,
      draft?.toolRequests?.length,
      draftParents.length,
      draftSummaryOpen,
      draftParent?.position,
      draftCompression?.position,
    ],
  );
  const contextUsage = useMemo(
    () => buildContextUsageMap(workspace.nodes, models, rootModelId),
    [workspace.nodes, models, rootModelId],
  );
  const path = useMemo(
    () =>
      new Set(ancestorPath(workspace.nodes, selectedId).map((node) => node.id)),
    [workspace.nodes, selectedId],
  );
  const blockedNodeActions = useMemo(() => {
    const blocked = new Set<string>();
    for (const turn of workspace.nodes) {
      if (turn.status !== "running" && turn.status !== "queued") continue;
      for (const node of ancestorPath(workspace.nodes, turn.id))
        blocked.add(node.id);
    }
    return blocked;
  }, [workspace.nodes]);
  const derivedNodes = useMemo<GraphNode[]>(
    () => [
      ...workspace.nodes.map(
        (turn, index): TurnGraphNode => ({
          id: turn.id,
          type: "turn",
          position: turn.position,
          selected: turn.id === selectedId && !selectedCompressionId,
          data: {
            turn,
            index,
            active: turn.id === selectedId && !selectedCompressionId,
            inPath: path.has(turn.id),
            contextUsage: contextUsage.get(turn.id)!,
            showContext: onShowContext,
            showSubagents: onShowSubagents,
            branch: onBranch,
            branchDisabled,
            connectable: Boolean(connectionParent(turn.id)),
            compressedEntry: Boolean(
              turn.requestedContextCheckpointId ||
                turn.contextParents?.some(
                  (parent) => parent.contextCheckpointId,
                ) ||
                compressionNodes.some(
                  (entry) => entry.targetNodeId === turn.id,
                ),
            ),
            edit: onEdit,
            delete: onDelete,
            actionsDisabled:
              nodeActionsDisabled ||
              turn.retryRestore?.status === "restoring" ||
              blockedNodeActions.has(turn.id),
            retry: onRetry,
            retryBusy:
              retryingId === turn.id ||
              turn.retryRestore?.status === "restoring",
            retryDisabledReason,
            chooseDirectory: onChooseDirectory,
            directoryDisabled:
              directoryDisabled ||
              workspace.nodes.some(
                (node) => node.status === "running" || node.status === "queued",
              ),
            workingDirectory:
              turn.status === "root" ? workspace.workingDirectory : undefined,
            temporaryDirectory:
              turn.status === "root" ? workspace.temporaryDirectory : undefined,
            modelName:
              models.find(
                (model) =>
                  model.id ===
                  (turn.status === "root" ? rootModelId : turn.config.model),
              )?.name ??
              (turn.status === "root" ? rootModelId : turn.config.model)
                .split("/")
                .at(-1)!,
          },
        }),
      ),
      ...compressionNodes.map(
        (entry): CompressionGraphNode => ({
          id: entry.id,
          type: "compression",
          position: entry.position,
          width: COMPRESSION_NODE_SIZE,
          height: COMPRESSION_NODE_SIZE,
          draggable: false,
          selected: entry.id === selectedCompressionId,
          data: {
            entry,
            ordinal:
              compressionNodes
                .filter((node) => node.parentId === entry.parentId)
                .findIndex((node) => node.id === entry.id) + 1,
            parentTitle:
              workspace.nodes.find((node) => node.id === entry.parentId)
                ?.prompt ?? "对话",
            active: entry.id === selectedCompressionId,
            inPath: workspace.nodes.some(
              (node) =>
                path.has(node.id) &&
                (node.id === entry.targetNodeId ||
                  node.contextParents?.some(
                    (parent) =>
                      parent.nodeId === entry.parentId &&
                      parent.contextCheckpointId === entry.checkpoint.id,
                  ) ||
                  (node.parentId === entry.parentId &&
                    node.requestedContextCheckpointId === entry.checkpoint.id)),
            ),
            branchDisabled,
            connectable: Boolean(connectionParent(entry.id)),
            branch: onBranch,
            show: onShowCompression,
          },
        }),
      ),
      ...(draft && draftPosition
        ? [
            {
              id: draft.id,
              type: "branchDraft" as const,
              position: draftPosition,
              width: 320,
              initialHeight: branchDraftHeight(
                draft.files.length,
                draft.referenceNodeIds.length,
                draftParents.length,
                draftSummaryOpen,
                draft.toolRequests?.length,
              ),
              draggable: false,
              selectable: false,
              focusable: false,
              zIndex: 10,
              data: {
                text: draft.text,
                files: draft.files,
                referenceNodeIds: draft.referenceNodeIds,
                toolRequests: draft.toolRequests,
                referenceCandidates: workspace.nodes.filter(
                  (node) => node.status === "completed" && !node.contextStale,
                ),
                workspaceNodes: workspace.nodes,
                config: draft.config,
                models,
                parentTitle: `${draft?.contextCheckpointId ? "压缩摘要 · " : ""}${draftParent?.prompt ?? draft.parentTitle}`,
                parents: draftParents.map((parent) => ({
                  nodeId: parent.nodeId,
                  title:
                    workspace.nodes.find((node) => node.id === parent.nodeId)
                      ?.prompt ?? "已移除的分支",
                  compressed: Boolean(parent.contextCheckpointId),
                })),
                color: draft.color,
                busy: draftBusy,
                compacting: draftCompacting,
                compactBlockedReason: draftCompactBlockedReason,
                mergedCheckpoint: draft.mergedCheckpoint,
                mergedSummaryOpen: draftSummaryOpen,
                blockedReason: draftBlockedReason,
                error: draft.error,
                focusVersion: draft.focusVersion,
                onTextChange: onDraftTextChange,
                onFilesChange: onDraftFilesChange,
                onReferencesChange: onDraftReferencesChange,
                onToolRequestsChange: onDraftToolRequestsChange,
                onConfigChange: onDraftConfigChange,
                onSubmit: onDraftSubmit,
                onCancel: onDraftCancel,
                onCompact: onDraftCompact,
                onCompactCancel: onDraftCompactCancel,
                onMergedSummaryToggle: (open: boolean) =>
                  setExpandedDraftSummaryId(
                    open ? draft.mergedCheckpoint?.id : undefined,
                  ),
                onDisconnect: onDraftDisconnect,
                onShowParentContext: onShowContext,
              },
            },
          ]
        : []),
    ],
    [
      workspace.nodes,
      workspace.workingDirectory,
      workspace.temporaryDirectory,
      selectedId,
      selectedCompressionId,
      compressionNodes,
      path,
      onBranch,
      branchDisabled,
      onEdit,
      onDelete,
      nodeActionsDisabled,
      onRetry,
      retryingId,
      retryDisabledReason,
      blockedNodeActions,
      onChooseDirectory,
      directoryDisabled,
      models,
      rootModelId,
      contextUsage,
      onShowContext,
      onShowSubagents,
      onShowCompression,
      draft,
      draftParents,
      draftPosition,
      draftParent?.prompt,
      draftBusy,
      draftCompacting,
      draftCompactBlockedReason,
      draftSummaryOpen,
      draftBlockedReason,
      onDraftTextChange,
      onDraftFilesChange,
      onDraftReferencesChange,
      onDraftToolRequestsChange,
      onDraftConfigChange,
      onDraftSubmit,
      onDraftCancel,
      onDraftCompact,
      onDraftCompactCancel,
      onDraftDisconnect,
    ],
  );
  const [nodes, setNodes] = useState<GraphNode[]>(derivedNodes);
  const referenceEdges = useMemo(
    () => (showReferences ? buildReferenceEdges(workspace.nodes, draft) : []),
    [showReferences, workspace.nodes, draft?.id, draft?.referenceNodeIds],
  );
  useEffect(
    () => setNodes((current) => reconcileGraphNodes(current, derivedNodes)),
    [derivedNodes],
  );
  const edges = useMemo<Edge[]>(() => {
    const sourceId = (parent: ContextParent) => {
      const entry = parent.contextCheckpointId
        ? compressionNodes.find(
            (item) =>
              item.parentId === parent.nodeId &&
              item.checkpoint.id === parent.contextCheckpointId &&
              item.kind !== "merge",
          )
        : undefined;
      return entry?.id ?? parent.nodeId;
    };
    return [
      ...referenceEdges,
      ...workspace.nodes.flatMap((node) => {
        const merge = compressionNodes.find(
          (entry) => entry.targetNodeId === node.id,
        );
        const sources = merge
          ? [merge.id]
          : (
              node.contextParents ??
              (node.parentId
                ? [
                    {
                      nodeId: node.parentId,
                      contextCheckpointId: node.requestedContextCheckpointId,
                    },
                  ]
                : [])
            ).map(sourceId);
        return sources.map((source) => ({
          id: `${source}-${node.id}`,
          source,
          target: node.id,
          type: "default",
          animated: node.status === "running",
          style: {
            stroke: merge
              ? "var(--compression-accent)"
              : path.has(node.id)
                ? colors[node.color]
                : "var(--graph-edge)",
            strokeWidth: path.has(node.id) ? 1.8 : 1.4,
          },
        }));
      }),
      ...compressionNodes.flatMap((entry) =>
        (entry.contextParents ?? [{ nodeId: entry.parentId }]).map(
          (parent) => ({
            id: `${sourceId(parent)}-${entry.id}`,
            source: sourceId(parent),
            target: entry.id,
            type: "default",
            style: {
              stroke: "var(--compression-accent)",
              strokeWidth: entry.id === selectedCompressionId ? 2 : 1.5,
              opacity: entry.usable || entry.kind === "merge" ? 0.9 : 0.5,
            },
          }),
        ),
      ),
      ...(draft
        ? draftParents.map((parent) => ({
            id: `${sourceId(parent)}-${draft.id}`,
            source: sourceId(parent),
            target: draft.id,
            type: "default",
            style: {
              stroke: colors[draft.color],
              strokeWidth: 1.8,
              strokeDasharray: "5 5",
            },
          }))
        : []),
    ];
  }, [
    referenceEdges,
    workspace.nodes,
    compressionNodes,
    selectedCompressionId,
    path,
    draft?.id,
    draft?.color,
    draftParents,
  ]);
  useEffect(() => {
    if (!draft || !draftPosition) return;
    void flow.setCenter(
      draftPosition.x + 160,
      draftPosition.y +
        branchDraftHeight(
          draft.files.length,
          draft.referenceNodeIds.length,
          draftParents.length,
          draftSummaryOpen,
          draft.toolRequests?.length,
        ) /
          2,
      {
        zoom: Math.max(0.8, Math.min(1, flow.getZoom())),
        duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : 300,
      },
    );
  }, [
    draft?.id,
    draft?.focusVersion,
    draft?.files.length,
    draft?.referenceNodeIds.length,
    draft?.toolRequests?.length,
    draftParents.length,
    draftSummaryOpen,
    draftPosition?.x,
    draftPosition?.y,
  ]);
  useEffect(() => {
    if (!focusId) return;
    const node =
      workspace.nodes.find((item) => item.id === focusId) ??
      compressionNodes.find((item) => item.id === focusId);
    if (node)
      void flow.setCenter(
        node.position.x +
          ("checkpoint" in node ? COMPRESSION_NODE_SIZE / 2 : 142),
        node.position.y +
          ("checkpoint" in node ? COMPRESSION_NODE_SIZE / 2 : 105),
        {
          zoom: 0.95,
          duration: 450,
        },
      );
  }, [focusId, focusVersion]);
  const running = workspace.nodes.filter(
    (node) => node.status === "running" || node.status === "queued",
  ).length;
  const handleLayout = () => {
    onPositions(Object.fromEntries(layoutTree(workspace.nodes)));
    setTimeout(
      () => void flow.fitView({ padding: 0.16, duration: 450, maxZoom: 0.95 }),
      120,
    );
  };
  return (
    <div
      className={`graph-container${draft ? " has-branch-draft" : ""}${draft && connecting ? " connecting-draft" : ""}`}
    >
      <ReactFlow<GraphNode>
        colorMode={colorMode}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes: NodeChange<GraphNode>[]) =>
          setNodes((current) => applyNodeChanges(changes, current))
        }
        onNodeClick={(_, node) => {
          if (node.type === "turn") onSelect(node.id);
        }}
        onNodeDragStop={(_, node) => {
          if (node.type === "turn") onPositions({ [node.id]: node.position });
        }}
        onInit={(instance) => {
          const saved = readPreference(`viewport:${workspace.id}`);
          try {
            if (saved) {
              const view = JSON.parse(saved);
              if (
                Number.isFinite(view.x) &&
                Number.isFinite(view.y) &&
                Number.isFinite(view.zoom)
              ) {
                void instance.setViewport(view);
                return;
              }
            }
          } catch {
            /* Use initial fit for an invalid stored viewport. */
          }
          void instance.fitView({ padding: 0.13, maxZoom: 0.9 });
        }}
        onMoveEnd={(_, viewport) => {
          setZoom(viewport.zoom);
          savePreference(`viewport:${workspace.id}`, JSON.stringify(viewport));
        }}
        fitView
        fitViewOptions={{ padding: 0.13, maxZoom: 0.9 }}
        minZoom={0.2}
        maxZoom={1.5}
        nodesConnectable={Boolean(draft && !draftBusy)}
        connectOnClick
        isValidConnection={validConnection}
        onConnect={(connection) => {
          if (!validConnection(connection)) return;
          const parent = connectionParent(connection.source);
          if (parent) onDraftConnect(parent);
        }}
        onPaneClick={cancelConnection}
        connectionLineStyle={{
          stroke: draft ? colors[draft.color] : "var(--graph-edge)",
          strokeWidth: 1.8,
          strokeDasharray: "5 5",
        }}
        edgesReconnectable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        panOnScroll
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      >
        {draft && (
          <DraftClickConnection
            draftId={draft.id}
            color={colors[draft.color]}
          />
        )}
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1}
          color="var(--graph-dot)"
        />
        <Panel position="top-left" className="canvas-heading">
          <span>
            <span className="tiny-green-dot" />
            探索画布
          </span>
          <small>
            {workspace.nodes.length} 个对话
            {compressionNodes.length
              ? ` · ${compressionNodes.length} 个压缩节点`
              : ""}
            {draft ? " · 1 个草稿" : ""}
          </small>
        </Panel>
        <Panel position="top-right" className="canvas-git-history">
          <GitHistoryPanel
            entries={workspace.gitHistory ?? []}
            nodeIds={workspace.nodes.map((node) => node.id)}
            onLocate={(nodeId) => {
              const node = flow.getNode(nodeId);
              if (!node) return;
              onSelect(nodeId);
              void flow.setCenter(
                node.position.x + (node.measured?.width ?? 282) / 2,
                node.position.y + (node.measured?.height ?? 218) / 2,
                {
                  zoom: 0.95,
                  duration: window.matchMedia(
                    "(prefers-reduced-motion: reduce)",
                  ).matches
                    ? 0
                    : 350,
                },
              );
            }}
          />
        </Panel>
        <Panel position="bottom-left" className="canvas-controls">
          <button
            aria-label="缩小画布"
            onClick={() => void flow.zoomOut({ duration: 200 })}
          >
            <Minus size={15} />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            aria-label="放大画布"
            onClick={() => void flow.zoomIn({ duration: 200 })}
          >
            <Plus size={15} />
          </button>
          <i />
          <button
            aria-label="适配全部节点"
            title="适配画布"
            onClick={() =>
              void flow.fitView({ padding: 0.14, duration: 400, maxZoom: 1 })
            }
          >
            <Maximize size={14} />
          </button>
          <button
            aria-label="切换全局缩略视图"
            disabled={Boolean(draft)}
            aria-pressed={showMap}
            title={showMap ? "隐藏全局缩略视图" : "显示全局缩略视图"}
            className={showMap ? "control-active" : ""}
            onClick={() => setShowMap((current) => !current)}
          >
            <Scan size={15} />
          </button>
          <i />
          <button
            type="button"
            aria-label="自动布局"
            title="自动布局"
            onClick={handleLayout}
          >
            <LayoutGrid size={15} />
          </button>
          <i />
          <button
            type="button"
            role="switch"
            aria-label="引用连线"
            aria-checked={showReferences}
            title={
              showReferences
                ? "隐藏 @ 引用连线"
                : "显示 @ 引用连线：被引用卡片 → 使用它的卡片"
            }
            className={`canvas-reference-toggle${showReferences ? " control-active" : ""}`}
            onClick={() => {
              const next = !showReferences;
              setShowReferences(next);
              savePreference("show-reference-edges", String(next));
            }}
          >
            <AtSign size={14} />
            引用连线
          </button>
        </Panel>
        <Panel position="bottom-right" className="canvas-hint">
          {draft && connecting ? (
            <>
              <GitBranch size={13} /> 接入其他卡片的出口 · Esc 取消
            </>
          ) : running ? (
            <>
              <LoaderCircle size={12} className="spin" /> {running}{" "}
              条探索正在推进
            </>
          ) : (
            <>
              <ArrowUpRight size={13} /> 选择任意节点，探索新的可能
            </>
          )}
        </Panel>
        {showMap && (
          <>
            <MiniMap<GraphNode>
              position="top-left"
              className="canvas-minimap"
              style={{ width: 168, height: 112 }}
              ariaLabel="全局缩略视图：颜色表示分支，运行中卡片带同色高亮和动态虚线边框，已完成卡片保持静态；点击定位，拖动平移，滚轮缩放"
              bgColor="var(--minimap-background)"
              nodeColor={(node) =>
                node.type === "compression"
                  ? "var(--compression-accent)"
                  : node.type === "branchDraft"
                    ? colors[(node as BranchDraftNode).data.color]
                    : colors[(node as TurnGraphNode).data.turn.color]
              }
              nodeClassName={(node) =>
                node.type === "compression"
                  ? "minimap-node-compression"
                  : node.type === "branchDraft"
                    ? "minimap-node-draft"
                    : `minimap-node-${(node as TurnGraphNode).data.turn.status} minimap-branch-${(node as TurnGraphNode).data.turn.color}`
              }
              nodeStrokeColor={(node) =>
                node.selected
                  ? "var(--ink)"
                  : node.type === "turn" &&
                      (node as TurnGraphNode).data.turn.status === "running"
                    ? "var(--text-body)"
                    : "transparent"
              }
              nodeStrokeWidth={1.5}
              maskColor="var(--minimap-mask)"
              maskStrokeColor="var(--text-accent)"
              maskStrokeWidth={1.5}
              onClick={(_, position) => {
                void flow.setCenter(position.x, position.y, {
                  zoom: flow.getZoom(),
                  duration: window.matchMedia(
                    "(prefers-reduced-motion: reduce)",
                  ).matches
                    ? 0
                    : 200,
                });
              }}
              pannable
              zoomable
            />
            <Panel position="top-left" className="canvas-minimap-legend">
              <span>
                <i className="minimap-legend-running" aria-hidden="true" />
                运行中
              </span>
              <span>
                <i className="minimap-legend-completed" aria-hidden="true" />
                已完成
              </span>
            </Panel>
          </>
        )}
      </ReactFlow>
    </div>
  );
}
