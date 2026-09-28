import { memo, useEffect, useId, useRef } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  GitBranch,
  Layers,
  LoaderCircle,
  Square,
  X,
} from "lucide-react";
import type {
  BranchColor,
  ContextCheckpoint,
  ModelOption,
  RunConfig,
  TurnNode,
} from "../shared/types";
import { ComposerModelControls } from "./WorkspaceControls";
import { AttachmentPicker } from "./Attachments";
import { CardReferenceInput } from "./CardReferenceInput";
import "./branch-draft-card.css";

export type BranchDraftData = {
  text: string;
  files: File[];
  referenceNodeIds: string[];
  referenceCandidates: TurnNode[];
  workspaceNodes: TurnNode[];
  config: RunConfig;
  models: ModelOption[];
  parentTitle: string;
  parents: { nodeId: string; title: string; compressed: boolean }[];
  color: BranchColor;
  busy: boolean;
  compacting: boolean;
  compactBlockedReason?: string;
  mergedCheckpoint?: ContextCheckpoint;
  mergedSummaryOpen: boolean;
  blockedReason: string;
  error: string;
  focusVersion: number;
  onTextChange: (text: string) => void;
  onFilesChange: (files: File[]) => void;
  onReferencesChange: (nodeIds: string[]) => void;
  onConfigChange: (config: RunConfig) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onCompact: () => void;
  onCompactCancel: () => void;
  onMergedSummaryToggle: (open: boolean) => void;
  onDisconnect: (nodeId: string) => void;
  onShowParentContext: (nodeId: string) => void;
};

export type BranchDraftNode = Node<BranchDraftData, "branchDraft">;

export const BranchDraftCard = memo(function BranchDraftCard({
  data,
}: NodeProps<BranchDraftNode>) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const feedbackId = useId();
  const shortcutId = useId();
  const selectedModel = data.models.find(
    (model) => model.id === data.config.model,
  );
  const modelIssue = !selectedModel?.available
    ? "请选择已连接的模型。"
    : !selectedModel.thinkingLevels.includes(data.config.thinking)
      ? "所选模型不支持当前思考强度，请重新选择。"
      : "";
  const blockedReason = data.blockedReason || modelIssue;
  const canSubmit =
    !data.busy &&
    !blockedReason &&
    Boolean(data.text.trim() || data.files.length);
  const feedback = data.error || blockedReason;

  useEffect(() => {
    const input = inputRef.current;
    if (!input || input.disabled) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }, [data.focusVersion]);

  return (
    <form
      className={`branch-draft-card color-${data.color} nodrag nopan nowheel`}
      aria-label="新分支草稿"
      aria-busy={data.busy}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (canSubmit) data.onSubmit();
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="branch-draft-input-handle"
        isConnectable={!data.busy}
        isConnectableStart={!data.busy}
        isConnectableEnd={!data.busy}
        aria-label="接入其他分支"
        title="点击或拖动此接入口，再连接其他卡片右侧的出口"
      />
      <Handle
        id="reference-target"
        type="target"
        position={Position.Top}
        className="reference-handle"
        isConnectable={false}
        aria-hidden="true"
      />
      <div className="branch-draft-topline">
        <strong>
          <GitBranch size={13} />
          新问题
        </strong>
        <button
          type="button"
          className="branch-draft-cancel"
          aria-label="取消新问题"
          title="取消新问题"
          disabled={data.busy}
          onClick={data.onCancel}
        >
          <X size={14} />
        </button>
      </div>
      <div className="branch-draft-context">
        <p
          className="branch-draft-parent"
          title={`从「${data.parentTitle}」继续`}
        >
          {data.parents.length > 1
            ? `融合 ${data.parents.length} 条分支`
            : `从「${data.parentTitle}」继续`}
        </p>
        <span className="branch-draft-connect-hint">
          点击左侧接入口，连接其他分支的出口
        </span>
        {data.parents.length > 1 && (
          <ul className="branch-draft-sources nowheel" aria-label="融合的分支">
            {data.parents.map((parent, index) => (
              <li key={parent.nodeId}>
                <button
                  type="button"
                  className="branch-draft-source-title"
                  title={`查看「${parent.title}」的上下文，可主动压缩该分支`}
                  onClick={() => data.onShowParentContext(parent.nodeId)}
                >
                  {parent.compressed && <span>摘要 · </span>}
                  {parent.title}
                </button>
                {index > 0 && (
                  <button
                    type="button"
                    className="branch-draft-source-remove"
                    disabled={data.busy}
                    title={`断开「${parent.title}」`}
                    aria-label={`断开「${parent.title}」`}
                    onClick={() => data.onDisconnect(parent.nodeId)}
                  >
                    <X size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {data.parents.length >= 2 && (
          <div className="branch-draft-compression">
            {data.compacting ? (
              <>
                <span
                  className="branch-draft-compression-status"
                  role="status"
                  aria-live="polite"
                >
                  <LoaderCircle size={13} className="spin" aria-hidden="true" />
                  正在整体压缩…
                </span>
                <button
                  type="button"
                  className="branch-draft-compress-stop"
                  onClick={data.onCompactCancel}
                  title="停止整体压缩，保留原始分支"
                >
                  <Square size={11} aria-hidden="true" />
                  停止
                </button>
              </>
            ) : data.mergedCheckpoint ? (
              <details
                className="branch-draft-compression-complete"
                open={data.mergedSummaryOpen}
                onToggle={(event) =>
                  data.onMergedSummaryToggle(event.currentTarget.open)
                }
              >
                <summary
                  title={`查看整体摘要；生成回答时将使用这份摘要。约 ${data.mergedCheckpoint.tokensBefore.toLocaleString("zh-CN")} → ${data.mergedCheckpoint.tokensAfter.toLocaleString("zh-CN")} tokens。`}
                >
                  <span role="status" aria-live="polite">
                    <Check size={13} aria-hidden="true" />
                    已整体压缩
                  </span>
                  <small>
                    {data.mergedCheckpoint.tokensBefore.toLocaleString("zh-CN")}
                    {" → "}
                    {data.mergedCheckpoint.tokensAfter.toLocaleString("zh-CN")}
                  </small>
                  <ChevronDown size={12} aria-hidden="true" />
                </summary>
                <div className="branch-draft-compression-summary nowheel">
                  {data.mergedCheckpoint.summary}
                </div>
              </details>
            ) : (
              <button
                type="button"
                className="branch-draft-compress"
                disabled={
                  data.busy || Boolean(data.compactBlockedReason || modelIssue)
                }
                title={
                  data.compactBlockedReason ||
                  modelIssue ||
                  "使用当前模型压缩全部接入分支，再使用整体摘要生成回答；压缩会产生 token 用量。"
                }
                onClick={data.onCompact}
              >
                <Layers size={13} aria-hidden="true" />
                整体主动压缩
              </button>
            )}
          </div>
        )}
      </div>
      <CardReferenceInput
        inputRef={inputRef}
        aria-label="卡片中的新问题"
        aria-describedby={`${feedbackId} ${shortcutId}`}
        className="branch-draft-input nodrag nopan nowheel"
        value={data.text}
        maxLength={20_000}
        disabled={data.busy}
        placeholder="提出一个新问题，输入 @ 引用其他卡片…"
        onChange={data.onTextChange}
        referenceNodeIds={data.referenceNodeIds}
        onReferencesChange={data.onReferencesChange}
        candidates={data.referenceCandidates}
        workspaceNodes={data.workspaceNodes}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.repeat &&
            !composing.current &&
            !event.nativeEvent.isComposing &&
            event.nativeEvent.keyCode !== 229
          ) {
            event.preventDefault();
            if (canSubmit) data.onSubmit();
          }
        }}
      />
      <AttachmentPicker
        files={data.files}
        onChange={data.onFilesChange}
        disabled={data.busy}
        compact
      />
      <ComposerModelControls
        models={data.models}
        config={data.config}
        disabled={data.busy}
        onConfigChange={data.onConfigChange}
      />
      <div
        id={feedbackId}
        className={`branch-draft-feedback${feedback ? " has-message" : ""}`}
        role={feedback ? "alert" : undefined}
        title={feedback || undefined}
      >
        {feedback}
      </div>
      <div className="branch-draft-footer">
        <span id={shortcutId}>⌘ / Ctrl + Enter 生成</span>
        <button
          type="submit"
          className="branch-draft-submit"
          disabled={!canSubmit}
        >
          {data.busy ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <ArrowUpRight size={13} />
          )}
          {data.compacting
            ? "等待压缩完成"
            : data.busy
              ? "正在创建…"
              : data.parents.length > 1
                ? "融合并回答"
                : "生成分支"}
        </button>
      </div>
    </form>
  );
});
