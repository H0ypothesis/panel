import { useEffect, useRef, useState, type FormEvent } from "react";
import { LoaderCircle, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import {
  ancestorPath,
  type ModelOption,
  type RunConfig,
  type TurnNode,
  type Workspace,
} from "../shared/types";
import { ComposerModelControls } from "./WorkspaceControls";
import { canBranchFrom } from "../shared/node-branching";
import { CardReferenceInput } from "./CardReferenceInput";
import "./node-actions.css";

export function subtreeIds(nodes: TurnNode[], nodeId: string): string[] {
  const ids = new Set([nodeId]);
  let size = 0;
  while (size !== ids.size) {
    size = ids.size;
    for (const node of nodes)
      if (node.parentId && ids.has(node.parentId)) ids.add(node.id);
  }
  return [...ids];
}

export interface NodeActionTarget {
  mode: "edit" | "delete";
  workspaceId: string;
  node: TurnNode;
  subtreeIds: string[];
}
export interface RegenerateInput {
  prompt: string;
  config: RunConfig;
  requestId: string;
  expectedRevision: number;
  referenceNodeIds?: string[];
}

export function NodeActionsDialog({
  target,
  workspace,
  models,
  disabled,
  onClose,
  onRegenerate,
  onDelete,
}: {
  target: NodeActionTarget;
  workspace: Workspace;
  models: ModelOption[];
  disabled: boolean;
  onClose: () => void;
  onRegenerate: (input: RegenerateInput) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [prompt, setPrompt] = useState(target.node.prompt);
  const [referenceNodeIds, setReferenceNodeIds] = useState(() =>
    (target.node.contextReferences ?? []).map((item) => item.nodeId),
  );
  const [referencesChanged, setReferencesChanged] = useState(false);
  const referenceCandidates = workspace.nodes.filter(
    (node) =>
      node.id !== target.node.id &&
      node.status === "completed" &&
      !node.contextStale,
  );
  // Keep original labels for saved snapshots, including deleted source cards.
  for (const reference of target.node.contextReferences ?? []) {
    const index = referenceCandidates.findIndex(
      (node) => node.id === reference.nodeId,
    );
    const source: TurnNode = {
      ...target.node,
      id: reference.nodeId,
      prompt: reference.prompt,
      response: reference.response,
      revision: reference.revision,
      status: "completed",
      contextStale: false,
    };
    if (index >= 0) referenceCandidates[index] = source;
    else referenceCandidates.push(source);
  }
  const [config, setConfig] = useState<RunConfig>({ ...target.node.config });
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editing = target.mode === "edit";
  const live = workspace.nodes.find((node) => node.id === target.node.id);
  const currentIds = subtreeIds(workspace.nodes, target.node.id);
  const active = workspace.nodes.some(
    (node) =>
      currentIds.includes(node.id) &&
      ["running", "queued"].includes(node.status),
  );
  const changed =
    !live ||
    (live.revision ?? 0) !== (target.node.revision ?? 0) ||
    (!editing &&
      (currentIds.length !== target.subtreeIds.length ||
        currentIds.some((id) => !target.subtreeIds.includes(id))));
  const staleParent =
    editing && live?.parentId
      ? ancestorPath(workspace.nodes, live.parentId).some(
          (node) => node.contextStale,
        )
      : false;
  const incompleteParent =
    editing && live?.parentId
      ? ancestorPath(workspace.nodes, live.parentId).some(
          (node) => !canBranchFrom(node),
        )
      : false;
  const blocked = changed
    ? "节点已发生变化，请关闭后重新打开。"
    : active
      ? "请先停止当前节点及后续分支中的任务，再进行此操作。"
      : staleParent
        ? "请先重新生成上游标记为「上下文已更新」的节点。"
        : incompleteParent
          ? "请先等待上游任务结束，并完成待处理的文件恢复。"
          : disabled
            ? "请等待连接恢复或当前设置保存完成。"
            : "";
  const model = models.find((item) => item.id === config.model);
  const canSubmit =
    !busy &&
    !blocked &&
    (!editing ||
      (prompt.trim().length > 0 &&
        model?.available &&
        model.thinkingLevels.includes(config.thinking)));
  const hasFileEffects = workspace.nodes.some(
    (node) =>
      target.subtreeIds.includes(node.id) &&
      node.toolCalls?.some(
        (call) =>
          ["write", "edit", "bash"].includes(call.name) &&
          call.status === "completed",
      ),
  );

  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    if (target.mode === "edit") input.current?.focus();
    else cancel.current?.focus();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [target.mode]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    try {
      if (editing)
        await onRegenerate({
          prompt,
          config,
          requestId,
          expectedRevision: target.node.revision ?? 0,
          ...(referencesChanged ? { referenceNodeIds } : {}),
        });
      else await onDelete();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "操作失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="modal node-action-dialog"
      aria-labelledby="node-action-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <form onSubmit={submit}>
        <button
          type="button"
          className="modal-close icon-button"
          aria-label="关闭节点操作"
          disabled={busy}
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <div
          className={`modal-illustration ${editing ? "" : "node-delete-icon"}`}
        >
          {editing ? <Pencil size={23} /> : <Trash2 size={23} />}
        </div>
        <h2 id="node-action-title">{editing ? "编辑指令" : "删除节点"}</h2>
        <p className="modal-intro">
          {editing
            ? "修改这轮指令，在当前卡片重新生成回答。"
            : target.subtreeIds.length > 1
              ? `将删除当前节点及其 ${target.subtreeIds.length - 1} 个后续节点，共 ${target.subtreeIds.length} 个节点。`
              : "将删除当前节点及其对话记录。"}
        </p>
        {editing ? (
          <>
            <label className="form-label">
              当前节点指令
              <CardReferenceInput
                inputRef={input}
                candidates={referenceCandidates}
                workspaceNodes={workspace.nodes}
                referenceNodeIds={referenceNodeIds}
                onReferencesChange={(ids) => {
                  setReferenceNodeIds(ids);
                  setReferencesChanged(true);
                  setRequestId(crypto.randomUUID());
                }}
                aria-label="当前节点指令"
                value={prompt}
                maxLength={20000}
                disabled={busy}
                onChange={(value) => {
                  setPrompt(value);
                  setRequestId(crypto.randomUUID());
                }}
                onKeyDown={(event) => {
                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.key === "Enter" &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void submit();
                  }
                }}
              />
            </label>
            <ComposerModelControls
              models={models}
              config={config}
              disabled={busy}
              onConfigChange={(next) => {
                setConfig(next);
                setRequestId(crypto.randomUUID());
              }}
            />
            {target.subtreeIds.length > 1 && (
              <p className="node-action-note">
                后续 {target.subtreeIds.length - 1}{" "}
                个节点会保留，并标记为需要重新生成。
              </p>
            )}
          </>
        ) : (
          <>
            <blockquote className="node-delete-preview">
              {target.node.prompt}
            </blockquote>
            <p className="node-action-note">删除后无法在工作台恢复。</p>
          </>
        )}
        {hasFileEffects && (
          <p className="node-action-note">已执行的本地文件修改不会撤销。</p>
        )}
        {blocked && (
          <p className="node-action-note" role="status">
            {blocked}
          </p>
        )}
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <div className="node-action-buttons">
          <button
            type="button"
            ref={cancel}
            className="node-action-cancel"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className={`primary-button ${editing ? "" : "node-delete-confirm"}`}
            disabled={!canSubmit}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : editing ? (
              <RefreshCw size={15} />
            ) : (
              <Trash2 size={15} />
            )}
            {busy
              ? "正在提交…"
              : editing
                ? "保存并重新生成"
                : target.subtreeIds.length > 1
                  ? `删除 ${target.subtreeIds.length} 个节点`
                  : "确认删除"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
