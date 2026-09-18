import { memo, useEffect, useId, useRef } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ArrowUpRight, GitBranch, LoaderCircle, X } from "lucide-react";
import type { BranchColor, ModelOption, RunConfig } from "../shared/types";
import { ComposerModelControls } from "./WorkspaceControls";
import "./branch-draft-card.css";

export type BranchDraftData = {
  text: string;
  config: RunConfig;
  models: ModelOption[];
  parentTitle: string;
  color: BranchColor;
  busy: boolean;
  blockedReason: string;
  error: string;
  focusVersion: number;
  onTextChange: (text: string) => void;
  onConfigChange: (config: RunConfig) => void;
  onSubmit: () => void;
  onCancel: () => void;
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
  const canSubmit = !data.busy && !blockedReason && Boolean(data.text.trim());
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
      <Handle type="target" position={Position.Left} isConnectable={false} />
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
      <p
        className="branch-draft-parent"
        title={`从「${data.parentTitle}」继续`}
      >
        从「{data.parentTitle}」继续
      </p>
      <textarea
        ref={inputRef}
        aria-label="卡片中的新问题"
        aria-describedby={`${feedbackId} ${shortcutId}`}
        className="branch-draft-input nodrag nopan nowheel"
        value={data.text}
        maxLength={20_000}
        disabled={data.busy}
        placeholder="沿着这个方向，提出一个新问题…"
        onChange={(event) => data.onTextChange(event.target.value)}
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
          {data.busy ? "正在创建…" : "生成分支"}
        </button>
      </div>
    </form>
  );
});
