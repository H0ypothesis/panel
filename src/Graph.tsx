import { memo, useEffect, useMemo, useState } from "react";
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
  type Node,
  type NodeProps,
  type NodeChange,
  type Edge,
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
} from "lucide-react";
import {
  ancestorPath,
  layoutTree,
  thinkingLabels,
  type TurnNode,
  type Workspace,
  type ModelOption,
  type RunConfig,
} from "../shared/types";
import { readPreference, savePreference } from "./api";
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
import {
  branchDraftHeight,
  branchDraftPosition,
  type CanvasBranchDraft,
} from "./branch-draft";
import {
  buildCompressionNodes,
  compressionNodeId,
  COMPRESSION_NODE_SIZE,
  type CompressionGraphEntry,
} from "../shared/context-graph";
import "./compression-graph.css";

type CardData = {
  turn: TurnNode;
  index: number;
  active: boolean;
  inPath: boolean;
  modelName: string;
  contextUsage: ContextUsage;
  showContext: (id: string) => void;
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
  const waitingFor = turn.toolCalls?.find(
    (call) => call.status === "running" && call.waitingFor,
  )?.waitingFor;
  return (
    <div
      className={`turn-card ${root ? "root-card" : ""} color-${turn.color} ${active ? "active" : ""} ${inPath ? "in-path" : ""} ${turn.requestedContextCheckpointId ? "compression-entry-card" : ""} status-${turn.status}`}
    >
      {!root && <Handle type="target" position={Position.Left} />}
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
                    ? "等待文件"
                    : turn.status === "running"
                      ? "生成中"
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
              {thinkingLabels[turn.config.thinking]}
            </span>
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
      <Handle type="source" position={Position.Right} />
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
      className={`compression-node ${data.active ? "active" : ""} ${data.inPath ? "in-path" : ""} ${entry.usable ? "" : "stale"}`}
    >
      <Handle type="target" position={Position.Left} />
      <button
        type="button"
        className="compression-node-body nodrag nopan"
        aria-label={`查看「${data.parentTitle}」的压缩摘要 ${data.ordinal}`}
        title={`压缩摘要 ${data.ordinal} · ${new Date(entry.checkpoint.createdAt).toLocaleString("zh-CN")}\n${entry.checkpoint.tokensBefore.toLocaleString("zh-CN")} → ${entry.checkpoint.tokensAfter.toLocaleString("zh-CN")} tokens\n${entry.usable ? "点击查看摘要，悬停右侧连接点可新增分支" : "原路径已更新，可查看摘要，请重新压缩后继续"}`}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          data.show(entry.parentId, entry.checkpoint.id);
        }}
      >
        <Layers size={20} aria-hidden="true" />
      </button>
      <Handle type="source" position={Position.Right} />
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
    </div>
  );
});
const nodeTypes = {
  turn: TurnCard,
  branchDraft: BranchDraftCard,
  compression: CompressionNode,
};

interface Props {
  colorMode: "light" | "dark";
  workspace: Workspace;
  selectedId: string;
  selectedCompressionId?: string;
  models: ModelOption[];
  rootModelId: string;
  onSelect: (id: string) => void;
  onShowContext: (id: string) => void;
  onShowCompression: (parentId: string, checkpointId: string) => void;
  onBranch: (id: string, checkpointId?: string) => void;
  branchDisabled: boolean;
  draft: CanvasBranchDraft | null;
  draftBusy: boolean;
  draftBlockedReason: string;
  onDraftTextChange: (text: string) => void;
  onDraftFilesChange: (files: File[]) => void;
  onDraftReferencesChange: (ids: string[]) => void;
  onDraftConfigChange: (config: RunConfig) => void;
  onDraftSubmit: () => void;
  onDraftCancel: () => void;
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
  onShowCompression,
  onBranch,
  branchDisabled,
  draft,
  draftBusy,
  draftBlockedReason,
  onDraftTextChange,
  onDraftFilesChange,
  onDraftReferencesChange,
  onDraftConfigChange,
  onDraftSubmit,
  onDraftCancel,
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
  const [zoom, setZoom] = useState(1);
  const [showMap, setShowMap] = useState(true);
  const compressionNodes = useMemo(
    () => buildCompressionNodes(workspace.nodes),
    [workspace.nodes],
  );
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
          )
        : null,
    [
      workspace.nodes,
      draft?.id,
      draft?.contextCheckpointId,
      draft?.files.length,
      draft?.referenceNodeIds.length,
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
    const byId = new Map(workspace.nodes.map((node) => [node.id, node]));
    const blocked = new Set<string>();
    for (const turn of workspace.nodes) {
      if (turn.status !== "running" && turn.status !== "queued") continue;
      let node: TurnNode | undefined = turn;
      while (node && !blocked.has(node.id)) {
        blocked.add(node.id);
        node = node.parentId ? byId.get(node.parentId) : undefined;
      }
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
            branch: onBranch,
            branchDisabled,
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
                node.parentId === entry.parentId &&
                node.requestedContextCheckpointId === entry.checkpoint.id,
            ),
            branchDisabled,
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
              ),
              draggable: false,
              selectable: false,
              focusable: false,
              zIndex: 10,
              data: {
                text: draft.text,
                files: draft.files,
                referenceNodeIds: draft.referenceNodeIds,
                referenceCandidates: workspace.nodes.filter(
                  (node) => node.status === "completed" && !node.contextStale,
                ),
                workspaceNodes: workspace.nodes,
                config: draft.config,
                models,
                parentTitle: `${draft?.contextCheckpointId ? "压缩摘要 · " : ""}${draftParent?.prompt ?? draft.parentTitle}`,
                color: draft.color,
                busy: draftBusy,
                blockedReason: draftBlockedReason,
                error: draft.error,
                focusVersion: draft.focusVersion,
                onTextChange: onDraftTextChange,
                onFilesChange: onDraftFilesChange,
                onReferencesChange: onDraftReferencesChange,
                onConfigChange: onDraftConfigChange,
                onSubmit: onDraftSubmit,
                onCancel: onDraftCancel,
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
      onShowCompression,
      draft,
      draftPosition,
      draftParent?.prompt,
      draftBusy,
      draftBlockedReason,
      onDraftTextChange,
      onDraftFilesChange,
      onDraftReferencesChange,
      onDraftConfigChange,
      onDraftSubmit,
      onDraftCancel,
    ],
  );
  const [nodes, setNodes] = useState<GraphNode[]>(derivedNodes);
  useEffect(
    () =>
      setNodes((current) =>
        derivedNodes.map((node) => {
          const dragging = current.find(
            (item) => item.id === node.id && item.dragging,
          );
          return dragging
            ? { ...node, position: dragging.position, dragging: true }
            : node;
        }),
      ),
    [derivedNodes],
  );
  const edges = useMemo<Edge[]>(
    () => [
      ...workspace.nodes
        .filter((node) => node.parentId)
        .map((node) => ({
          id: `${node.parentId}-${node.id}`,
          source:
            node.requestedContextCheckpointId &&
            compressionNodes.some(
              (entry) =>
                entry.parentId === node.parentId &&
                entry.checkpoint.id === node.requestedContextCheckpointId,
            )
              ? compressionNodeId(
                  node.parentId!,
                  node.requestedContextCheckpointId,
                )
              : node.parentId!,
          target: node.id,
          type: "default",
          animated: node.status === "running",
          style: {
            stroke: path.has(node.id)
              ? colors[node.color]
              : "var(--graph-edge)",
            strokeWidth: path.has(node.id) ? 1.8 : 1.4,
          },
        })),
      ...compressionNodes.map((entry) => ({
        id: `${entry.parentId}-${entry.id}`,
        source: entry.parentId,
        target: entry.id,
        type: "default",
        style: {
          stroke: "var(--compression-accent)",
          strokeWidth: entry.id === selectedCompressionId ? 2 : 1.5,
          opacity: entry.usable ? 0.9 : 0.5,
        },
      })),
      ...(draft && draftParent
        ? [
            {
              id: `${draft.parentId}-${draft.id}`,
              source: draftCompression?.id ?? draft.parentId,
              target: draft.id,
              type: "default",
              style: {
                stroke: colors[draft.color],
                strokeWidth: 1.8,
                strokeDasharray: "5 5",
              },
            },
          ]
        : []),
    ],
    [
      workspace.nodes,
      compressionNodes,
      selectedCompressionId,
      path,
      draft?.id,
      draft?.parentId,
      draft?.color,
      draftParent?.id,
      draftCompression?.id,
    ],
  );
  useEffect(() => {
    if (!draft || !draftPosition) return;
    void flow.setCenter(
      draftPosition.x + 160,
      draftPosition.y +
        branchDraftHeight(draft.files.length, draft.referenceNodeIds.length) /
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
    <div className={`graph-container${draft ? " has-branch-draft" : ""}`}>
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
        nodesConnectable={false}
        edgesReconnectable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        panOnScroll
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      >
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
        </Panel>
        <Panel position="bottom-right" className="canvas-hint">
          {running ? (
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
