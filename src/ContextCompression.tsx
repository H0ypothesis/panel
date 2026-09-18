import {
  ChevronDown,
  Layers,
  LoaderCircle,
  Plus,
  Scan,
  Square,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ContextUsage } from "../shared/context-usage";
import {
  contextCompressionLabel,
  contextUsageLabel,
  contextUsageSourceLabel,
} from "./ContextUsageRing";
import {
  thinkingLabels,
  type ContextCheckpoint,
  type ContextState,
  type ModelOption,
  type RunConfig,
  type TurnNode,
  type Workspace,
} from "../shared/types";
import {
  checkpointMatchesPath,
  preparedCheckpoints,
} from "../shared/context-graph";
import "./context-compression.css";

const labels: Record<ContextState["status"], string> = {
  full: "未压缩",
  compacting: "压缩中",
  compacted: "已压缩",
  failed: "压缩失败",
  cancelled: "压缩已停止",
};

function RequestUsageDetails({
  usage,
  node,
}: {
  usage: ContextUsage;
  node: TurnNode;
}) {
  const percentage =
    usage.percentage === null
      ? ""
      : ` · ${usage.percentage.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%`;
  return (
    <span className="request-context-content">
      <span className="request-context-heading">
        <span
          className={`compression-status-label ${usage.compressionStatus ?? "unknown"}`}
          role="status"
          aria-live="polite"
        >
          {usage.compressionStatus === "compacting" ? (
            <LoaderCircle size={12} className="spin" aria-hidden="true" />
          ) : (
            <Layers size={12} aria-hidden="true" />
          )}
          {contextCompressionLabel(usage, node.status)}
        </span>
        <small>{contextUsageSourceLabel(usage)}</small>
      </span>
      <span className="request-context-count">
        {contextUsageLabel(usage)}{" "}
        <strong>{usage.tokens.toLocaleString("zh-CN")}</strong>
        {" / "}
        {usage.limit?.toLocaleString("zh-CN") ?? "未知窗口"} tokens
        {percentage}
      </span>
      {usage.inputTokens !== undefined && (
        <span className="request-context-explanation">
          输入 {usage.inputTokens.toLocaleString("zh-CN")} + 本次生成{" "}
          {usage.outputTokens?.toLocaleString("zh-CN") ?? "暂无计数"} tokens
        </span>
      )}
      {usage.compressionStatus === "compacted" &&
        usage.originalTokens !== undefined &&
        usage.inputTokens !== undefined && (
          <span className="request-context-explanation">
            原文请求约 {usage.originalTokens.toLocaleString("zh-CN")} →{" "}
            {usage.source === "provider" ? "压缩后输入实测 " : "压缩后输入约 "}
            {usage.inputTokens.toLocaleString("zh-CN")}{" "}
            tokens；原始记录完整保留。
          </span>
        )}
      {usage.source === "provider" ? (
        <span className="request-context-explanation">
          最近一次模型调用的输入（含缓存）加该次生成；此前各轮内容已计入输入。
        </span>
      ) : usage.source === "estimate" ? (
        <span className="request-context-explanation">
          输入包含系统提示与工具定义；生成期间更新估算，收到供应商计数后校准。
        </span>
      ) : (
        <span className="request-context-explanation">
          尚无请求计数，原文估算不能用来判断实际输入是否超限。
        </span>
      )}
      {usage.source !== "archive" && (
        <span className="request-context-archive">
          原文档案约 {usage.rawTokens.toLocaleString("zh-CN")} tokens · 估算
        </span>
      )}
    </span>
  );
}

function ContextStatus({
  state,
  emptyLabel = "未记录压缩状态",
}: {
  state?: ContextState;
  emptyLabel?: string;
}) {
  return (
    <div className="compression-status" role="status" aria-live="polite">
      <span className={`compression-status-label ${state?.status ?? "full"}`}>
        {state?.status === "compacting" && (
          <LoaderCircle size={12} className="spin" aria-hidden="true" />
        )}
        {state ? labels[state.status] : emptyLabel}
      </span>
      {state?.originalTokens !== undefined && (
        <span className="compression-token-count">
          约 {state.originalTokens.toLocaleString("zh-CN")}
          {state.inputTokens !== undefined &&
          state.inputTokens !== state.originalTokens
            ? ` → ${state.inputTokens.toLocaleString("zh-CN")}`
            : ""}{" "}
          tokens · 估算
        </span>
      )}
      {state?.contextWindow !== undefined && (
        <small>
          窗口 {state.contextWindow.toLocaleString("zh-CN")}
          {state.reservedTokens !== undefined
            ? ` · 预留 ${state.reservedTokens.toLocaleString("zh-CN")}`
            : ""}
        </small>
      )}
      {state?.error && <p className="compression-error">{state.error}</p>}
    </div>
  );
}

function CheckpointDetails({
  checkpoint,
  label,
  nodes,
  onLocate,
  selected = false,
}: {
  checkpoint: ContextCheckpoint;
  label: string;
  selected?: boolean;
  nodes: TurnNode[];
  onLocate: (id: string) => void;
}) {
  return (
    <details
      className={`compression-checkpoint${selected ? " selected" : ""}`}
      open={selected}
    >
      <summary>
        <span>{label}</span>
        <small>
          {checkpoint.tokensBefore.toLocaleString("zh-CN")} →{" "}
          {checkpoint.tokensAfter.toLocaleString("zh-CN")}
        </small>
        <ChevronDown size={13} aria-hidden="true" />
      </summary>
      <div className="compression-checkpoint-body">
        <p className="compression-meta">
          {checkpoint.model} · {thinkingLabels[checkpoint.thinking]}
          <br />
          {new Date(checkpoint.createdAt).toLocaleString("zh-CN")}
          {" · 前后 token 数为估算"}
        </p>
        <div className="compression-sources" aria-label="摘要来源节点与版本">
          {checkpoint.sources.map((source) => {
            const node = nodes.find((item) => item.id === source.nodeId);
            const changed = !node || (node.revision ?? 0) !== source.revision;
            return (
              <button
                type="button"
                key={`${source.nodeId}:${source.revision}`}
                disabled={!node}
                title={`${source.nodeId} · 版本 ${source.revision} · ${source.messageCount} 条消息${changed ? " · 当前版本已变化" : ""}`}
                onClick={() => onLocate(source.nodeId)}
              >
                <span>{node?.prompt ?? "已删除节点"}</span>
                <small>
                  v{source.revision}
                  {changed ? " · 已变化" : ""}
                </small>
              </button>
            );
          })}
        </div>
        <div className="markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {checkpoint.summary}
          </ReactMarkdown>
        </div>
        {checkpoint.usage && (
          <p className="compression-meta">
            摘要额外用量：{checkpoint.usage.total.toLocaleString("zh-CN")}{" "}
            tokens
            {checkpoint.usage.cost !== undefined
              ? ` · $${checkpoint.usage.cost.toFixed(4)}`
              : ""}
          </p>
        )}
      </div>
    </details>
  );
}

export function ContextCompression({
  workspace,
  node,
  usage,
  config,
  model,
  online,
  busy,
  settingsBusy,
  selectedCheckpointId,
  onLocateCompression,
  onBranch,
  onGenerate,
  onCancel,
  onAutoChange,
  onLocate,
}: {
  workspace: Workspace;
  node: TurnNode;
  usage: ContextUsage;
  config: RunConfig;
  model?: ModelOption;
  online: boolean;
  busy: boolean;
  settingsBusy: boolean;
  selectedCheckpointId?: string;
  onLocateCompression: (checkpointId: string) => void;
  onBranch: (checkpointId: string) => void;
  onGenerate: () => void;
  onCancel: () => void;
  onAutoChange: (value: boolean) => void;
  onLocate: (id: string) => void;
}) {
  const preparing = busy || node.preparedContextState?.status === "compacting";
  const checkpoints = preparedCheckpoints(node);
  const disabledReason = !online
    ? "连接恢复后可生成摘要。"
    : node.contextStale
      ? "请先重新生成已过期的上下文。"
      : node.status !== "completed"
        ? node.status === "root"
          ? "完成一轮对话后，可为这条路径生成摘要。"
          : "本轮完成后可生成下一轮摘要。"
        : !model?.available
          ? "请在输入框下方选择已连接的模型。"
          : model.demo
            ? "生成摘要需要真实模型，请在输入框下方切换。"
            : !model.thinkingLevels.includes(config.thinking)
              ? "请选择该模型支持的思考深度。"
              : "";
  return (
    <section className="context-compression" aria-label="上下文压缩">
      <div className="compression-heading">
        <b>
          <Layers size={14} aria-hidden="true" />
          上下文压缩
        </b>
        <label className="compression-auto">
          <span>自动压缩</span>
          <input
            type="checkbox"
            role="switch"
            aria-label="自动压缩上下文，后续任务生效"
            checked={workspace.autoCompact !== false}
            disabled={!online || settingsBusy}
            onChange={(event) => onAutoChange(event.target.checked)}
          />
        </label>
      </div>
      <p className="compression-hint">
        普通路径按预算自动压缩；从压缩节点继续会沿用摘要，从它前面的卡片继续会保留原文。原始记录完整保留。
      </p>
      <div className="compression-run">
        <b>当前上下文</b>
        <RequestUsageDetails usage={usage} node={node} />
        {node.contextState?.reservedTokens !== undefined && (
          <p className="compression-meta">
            输出预留 {node.contextState.reservedTokens.toLocaleString("zh-CN")}{" "}
            tokens
          </p>
        )}
        {node.contextState?.error && (
          <p className="compression-error">{node.contextState.error}</p>
        )}
        {(node.compactions ?? []).map((checkpoint, index) => (
          <CheckpointDetails
            key={checkpoint.id}
            checkpoint={checkpoint}
            label={`本轮摘要 ${index + 1}`}
            nodes={workspace.nodes}
            onLocate={onLocate}
          />
        ))}
      </div>
      <div className="compression-preparation">
        <div className="compression-preparation-heading">
          <b>压缩节点</b>
          {preparing ? (
            <button type="button" onClick={onCancel} disabled={!online}>
              <Square size={11} aria-hidden="true" />
              停止生成摘要
            </button>
          ) : (
            <button
              type="button"
              disabled={Boolean(disabledReason)}
              title={
                disabledReason || "使用当前所选模型生成摘要，会产生额外用量"
              }
              onClick={onGenerate}
            >
              压缩当前路径
            </button>
          )}
        </div>
        <p className="compression-hint">
          {disabledReason ||
            `使用 ${model?.name ?? config.model}，会产生额外模型用量。`}
          完成后在画布新增圆形节点；从圆点的 + 继续使用摘要，从原卡片的 +
          继续保留原文。
        </p>
        {(node.preparedContextState || preparing) && (
          <ContextStatus
            state={
              preparing
                ? {
                    ...node.preparedContextState,
                    status: "compacting",
                    error: undefined,
                    updatedAt:
                      node.preparedContextState?.updatedAt ?? Date.now(),
                  }
                : node.preparedContextState
            }
          />
        )}
        {checkpoints.map((checkpoint, index) => {
          const usable =
            node.status === "completed" &&
            checkpointMatchesPath(checkpoint, workspace.nodes, node.id);
          return (
            <div className="compression-prepared-node" key={checkpoint.id}>
              <CheckpointDetails
                checkpoint={checkpoint}
                label={`压缩节点 ${index + 1}`}
                selected={selectedCheckpointId === checkpoint.id}
                nodes={workspace.nodes}
                onLocate={onLocate}
              />
              <div className="compression-node-actions">
                <button
                  type="button"
                  onClick={() => onLocateCompression(checkpoint.id)}
                >
                  <Scan size={12} aria-hidden="true" />
                  在画布定位
                </button>
                <button
                  type="button"
                  disabled={!usable || !online}
                  onClick={() => onBranch(checkpoint.id)}
                >
                  <Plus size={12} aria-hidden="true" />
                  从此摘要继续
                </button>
              </div>
              {!usable && (
                <p className="compression-hint">
                  来源上下文已更新，此摘要仅供查看；请重新压缩。
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
