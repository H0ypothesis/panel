import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { Download, FileText, ImageIcon, Paperclip, X } from "lucide-react";
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_PATH_HINT,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_BYTES,
  attachmentKind,
  formatAttachmentSize,
  type Attachment,
} from "../shared/attachments";
import { validateAttachmentFiles } from "./attachment-draft";
import "./attachments.css";

function DraftFile({
  file,
  disabled,
  onRemove,
}: {
  file: File;
  disabled: boolean;
  onRemove: () => void;
}) {
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    if (attachmentKind(file.name) !== "image") return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <li className="attachment-file">
      <span className="attachment-file-icon" aria-hidden="true">
        {preview ? (
          <img src={preview} alt="" />
        ) : attachmentKind(file.name) === "image" ? (
          <ImageIcon size={17} />
        ) : (
          <FileText size={17} />
        )}
      </span>
      <span className="attachment-file-info">
        <span className="attachment-file-name" title={file.name}>
          {file.name}
        </span>
        <span className="attachment-file-detail">
          {formatAttachmentSize(file.size)}
        </span>
      </span>
      <button
        type="button"
        className="attachment-remove"
        aria-label={`移除附件「${file.name}」`}
        title="移除附件"
        disabled={disabled}
        onClick={onRemove}
      >
        <X size={13} />
      </button>
    </li>
  );
}

export function AttachmentPicker({
  files,
  onChange,
  disabled = false,
  compact = false,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const inputId = useId();
  const helpId = useId();
  const errorId = useId();

  useEffect(() => setError(""), [files]);
  useEffect(() => {
    if (disabled) {
      dragDepth.current = 0;
      setDragging(false);
    }
  }, [disabled]);

  function addFiles(incoming: File[]) {
    if (disabled || !incoming.length) return;
    const next = [...files];
    for (const file of incoming) {
      if (
        !next.some(
          (existing) =>
            existing.name === file.name &&
            existing.size === file.size &&
            existing.lastModified === file.lastModified,
        )
      ) {
        next.push(file);
      }
    }
    const issue = validateAttachmentFiles(next);
    if (issue) {
      setError(issue);
      return;
    }
    setError("");
    onChange(next);
  }

  function isFileDrag(event: DragEvent<HTMLDivElement>) {
    return event.dataTransfer.types.includes("Files");
  }

  return (
    <div
      className={`attachment-picker nodrag nopan nowheel${compact ? " compact" : ""}${dragging ? " is-dragging" : ""}${disabled ? " is-disabled" : ""}`}
      onDragEnter={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        if (disabled) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = disabled ? "none" : "copy";
      }}
      onDragLeave={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth.current = 0;
        setDragging(false);
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <input
        ref={inputRef}
        id={inputId}
        className="attachment-file-input"
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        disabled={disabled}
        aria-label="选择上传文件"
        tabIndex={-1}
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <div className="attachment-picker-topline">
        <button
          type="button"
          className="attachment-add"
          disabled={disabled}
          aria-controls={inputId}
          aria-describedby={`${helpId}${error ? ` ${errorId}` : ""}`}
          onClick={() => inputRef.current?.click()}
        >
          <Paperclip size={13} />
          上传文件
          {files.length > 0 && (
            <span>
              {files.length}/{MAX_ATTACHMENT_COUNT}
            </span>
          )}
        </button>
        <span className="attachment-drop-hint">
          {dragging ? "松开添加文件" : "或拖拽到这里"}
        </span>
      </div>
      <p id={helpId} className="attachment-help">
        文本、代码、PDF、图片 · 最多 {MAX_ATTACHMENT_COUNT} 个 · 单个{" "}
        {formatAttachmentSize(MAX_ATTACHMENT_BYTES)}
        <br />
        文件较大时，{ATTACHMENT_PATH_HINT}
      </p>
      {files.length > 0 && (
        <ul className="attachment-file-list" aria-label="待上传文件">
          {files.map((file, index) => (
            <DraftFile
              key={`${file.name}:${file.size}:${file.lastModified}`}
              file={file}
              disabled={disabled}
              onRemove={() =>
                onChange(files.filter((_, item) => item !== index))
              }
            />
          ))}
        </ul>
      )}
      {error && (
        <p id={errorId} className="attachment-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function AttachmentList({
  attachments,
  workspaceId,
  nodeId,
}: {
  attachments: Attachment[];
  workspaceId: string;
  nodeId: string;
}) {
  if (!attachments.length) return null;
  return (
    <>
      <ul
        className="attachment-file-list attachment-uploaded-list"
        aria-label="已上传文件"
      >
        {attachments.map((attachment) => (
          <li className="attachment-file" key={attachment.id}>
            <span className="attachment-file-icon" aria-hidden="true">
              {attachment.kind === "image" ? (
                <ImageIcon size={17} />
              ) : (
                <FileText size={17} />
              )}
            </span>
            <span className="attachment-file-info">
              <span className="attachment-file-name" title={attachment.name}>
                {attachment.name}
              </span>
              <span className="attachment-file-detail">
                {formatAttachmentSize(attachment.size)}
                {attachment.truncated ? " · 内容过长，已截取" : ""}
              </span>
            </span>
            <a
              className="attachment-download"
              href={`/api/workspaces/${encodeURIComponent(workspaceId)}/nodes/${encodeURIComponent(nodeId)}/attachments/${encodeURIComponent(attachment.id)}`}
              download={attachment.name}
              aria-label={`下载附件「${attachment.name}」`}
              title="下载原文件"
            >
              <Download size={13} />
            </a>
          </li>
        ))}
      </ul>
      {attachments.some((attachment) => attachment.truncated) && (
        <p className="attachment-help">
          部分附件未完整放入上下文。{ATTACHMENT_PATH_HINT}
        </p>
      )}
    </>
  );
}
