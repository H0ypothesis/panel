import { useEffect, useRef, useState, type FormEvent } from "react";
import { LoaderCircle, Trash2, X } from "lucide-react";
import type { Workspace } from "../shared/types";
import "./workspace-delete.css";

export function DeleteWorkspaceDialog({
  target,
  workspace,
  disabled,
  onClose,
  onDelete,
}: {
  target: Workspace;
  workspace?: Workspace;
  disabled: boolean;
  onClose: () => void;
  onDelete: (deleteTemporaryDirectory: boolean) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed =
    !workspace ||
    workspace.nodes.length !== target.nodes.length ||
    workspace.nodes.some(
      (node) => !target.nodes.some((item) => item.id === node.id),
    );
  const active =
    workspace?.nodes.some(
      (node) =>
        ["running", "queued"].includes(node.status) ||
        node.retryRestore?.status === "restoring" ||
        node.toolCalls?.some((call) =>
          ["running", "reviewing", "awaiting_approval"].includes(call.status),
        ),
    ) || workspace?.gitHistory?.some((entry) => entry.status === "recording");
  const blocked = changed
    ? "探索空间已发生变化，请关闭后重新确认删除范围。"
    : active
      ? "这个空间还有未结束的任务，请先停止任务并等待操作结束后再删除。"
      : disabled
        ? "请等待连接恢复或当前操作完成后再删除。"
        : "";

  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    cancel.current?.focus();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current || blocked) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await onDelete(deleteFiles);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败，请重试。");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="modal node-action-dialog workspace-delete-dialog"
      aria-labelledby="workspace-delete-title"
      aria-describedby="workspace-delete-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!submitting.current) onClose();
      }}
    >
      <form onSubmit={submit}>
        <button
          type="button"
          className="modal-close icon-button"
          aria-label="关闭删除探索确认"
          disabled={busy}
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <div className="modal-illustration node-delete-icon">
          <Trash2 size={23} />
        </div>
        <h2 id="workspace-delete-title">删除探索空间？</h2>
        <p className="modal-intro" id="workspace-delete-description">
          将删除这个空间的全部 {target.nodes.length}{" "}
          个节点、对话和工具记录，以及 Git 更新记录。删除后无法在工作台恢复。
        </p>
        <blockquote className="node-delete-preview">{target.title}</blockquote>
        <label
          className={`workspace-delete-option ${deleteFiles ? "checked" : ""}`}
        >
          <input
            type="checkbox"
            checked={deleteFiles}
            disabled={busy || !target.temporaryDirectory}
            onChange={(event) => setDeleteFiles(event.target.checked)}
          />
          <span>
            <strong>同时删除临时目录及其中的文件</strong>
            <small>不勾选则保留文件，可继续通过下方路径访问。</small>
          </span>
        </label>
        <div className="workspace-delete-directory">
          <span>此空间的临时目录</span>
          <code>
            {target.temporaryDirectory ?? "临时目录信息暂不可用，文件将保留。"}
          </code>
        </div>
        <p className="node-action-note">
          {deleteFiles
            ? "已选择清理临时目录，其中的文件将被永久删除。"
            : "临时目录及其中的文件将保留。"}
          自选的本地项目目录不会被删除。
        </p>
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
            ref={cancel}
            type="button"
            className="node-action-cancel"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className="primary-button node-delete-confirm"
            disabled={busy || !!blocked}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Trash2 size={15} />
            )}
            {busy
              ? "正在删除…"
              : deleteFiles
                ? "删除空间及临时文件"
                : "仅删除空间"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
