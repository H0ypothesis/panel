import { useEffect, useId, useRef, useState } from "react";
import {
  Download,
  FileText,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import {
  generatedFileSources,
  generatedFilesBase,
  generatedFileUrl,
  type GeneratedFile,
  type GeneratedFileTarget,
} from "../shared/generated-files";
import type { TurnNode, Workspace } from "../shared/types";
import { api, ApiError } from "./api";
import { getDesktopBridge } from "./desktop";
import { formatAttachmentSize } from "../shared/attachments";
import "./generated-files.css";

function FilePreview({
  file,
  target,
  onClose,
}: {
  file: GeneratedFile;
  target: GeneratedFileTarget;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="generated-file-preview"
      aria-labelledby={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <strong id={title}>{file.name}</strong>
        <a
          href={generatedFileUrl(target, true)}
          download={file.name}
          title="下载原文件"
        >
          <Download size={15} />
          下载
        </a>
        <button type="button" onClick={onClose} aria-label="关闭文件预览">
          <X size={18} />
        </button>
      </header>
      <iframe
        title={`预览 ${file.name}`}
        src={generatedFileUrl(target)}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
      />
    </dialog>
  );
}

export function GeneratedFiles({
  workspace,
  node,
}: {
  workspace: Workspace;
  node: TurnNode;
}) {
  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<GeneratedFile | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const revision = node.revision ?? 0;
  const sources = JSON.stringify(generatedFileSources(workspace, node));
  const hasSources = node.status === "completed" && sources !== "[]";
  const base = generatedFilesBase(workspace.id, node.id);
  const listPath = `${base}?revision=${revision}`;
  const desktop = getDesktopBridge();
  const identity = `${workspace.id}:${node.id}:${revision}`;
  const currentIdentity = useRef(identity);
  const mounted = useRef(true);
  const acting = useRef(false);
  currentIdentity.current = identity;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setPreview(null);
    if (!hasSources) {
      setFiles([]);
      setError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    void api<{ files: GeneratedFile[] }>(listPath)
      .then((result) => {
        if (active) {
          setFiles(result.files);
          setError("");
        }
      })
      .catch((reason: unknown) => {
        if (active)
          setError(
            reason instanceof ApiError && reason.status === 404
              ? "当前服务尚未加载交付文件功能，请更新并重启服务。"
              : reason instanceof Error
                ? reason.message
                : "无法获取交付文件，请刷新重试。",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [hasSources, sources, node.response, listPath, refreshVersion]);

  const target = (file: GeneratedFile): GeneratedFileTarget => ({
    workspaceId: workspace.id,
    nodeId: node.id,
    revision,
    fileId: file.id,
  });
  const actOnFile = async (
    file: GeneratedFile,
    action: "open" | "reveal" | "download",
  ) => {
    if (acting.current) return;
    acting.current = true;
    setBusy(file.id);
    setError("");
    try {
      // Refresh disk state before acting; the file can have been removed externally.
      const result = await api<{ files: GeneratedFile[] }>(listPath);
      if (!mounted.current || currentIdentity.current !== identity) return;
      setFiles(result.files);
      const live = result.files.find((item) => item.id === file.id);
      if (!live || live.status !== "available")
        throw new Error(
          live?.status === "unavailable"
            ? "文件暂时无法访问，请检查文件及权限。"
            : "文件不存在或已删除。",
        );
      if (action === "reveal")
        await desktop?.revealGeneratedFile?.(target(live));
      else if (
        action === "open" &&
        desktop?.openGeneratedFile &&
        live.nativeOpenable
      )
        await desktop.openGeneratedFile(target(live));
      else if (action === "open" && live.previewable) setPreview(live);
      else {
        const anchor = document.createElement("a");
        anchor.href = generatedFileUrl(target(live), true);
        anchor.download = live.name;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      }
    } catch (reason) {
      if (mounted.current && currentIdentity.current === identity)
        setError(
          reason instanceof Error ? reason.message : "打开文件失败，请重试。",
        );
    } finally {
      acting.current = false;
      if (mounted.current && currentIdentity.current === identity)
        setBusy(null);
    }
  };

  if (!hasSources || (!files.length && !error && !loading)) return null;
  return (
    <section className="generated-files" aria-label="交付文件">
      <div className="generated-files-heading">
        <FileText size={14} />
        <strong>交付文件</strong>
        {loading && (
          <LoaderCircle size={12} className="spin" aria-label="正在读取文件" />
        )}
        <button
          type="button"
          onClick={() => setRefreshVersion((value) => value + 1)}
          disabled={loading || !!busy}
          aria-label="刷新交付文件"
          title="刷新文件状态"
        >
          <RefreshCw size={12} />
        </button>
      </div>
      {files.length > 0 && (
        <ul>
          {files.map((file) => {
            const available = file.status === "available";
            const canOpen =
              file.previewable ||
              (!!desktop?.openGeneratedFile && file.nativeOpenable);
            return (
              <li key={file.id}>
                <FileText size={18} aria-hidden="true" />
                <div className="generated-file-info">
                  <button
                    type="button"
                    className="generated-file-name"
                    title={file.path}
                    disabled={!available || !!busy}
                    onClick={() => void actOnFile(file, "open")}
                  >
                    {file.name}
                  </button>
                  <span>
                    {file.name.includes(".")
                      ? file.name.split(".").at(-1)?.toUpperCase()
                      : "文件"}
                    {file.size !== undefined
                      ? ` · ${formatAttachmentSize(file.size)}`
                      : ""}
                    {!available
                      ? file.status === "missing"
                        ? " · 已删除或移动"
                        : " · 无法访问"
                      : ""}
                  </span>
                </div>
                <div className="generated-file-actions">
                  {busy === file.id && (
                    <LoaderCircle
                      size={13}
                      className="spin"
                      aria-label="正在打开文件"
                    />
                  )}
                  {canOpen && (
                    <button
                      type="button"
                      disabled={!available || !!busy}
                      onClick={() => void actOnFile(file, "open")}
                      aria-label={`打开 ${file.name}`}
                    >
                      打开
                    </button>
                  )}
                  <a
                    href={generatedFileUrl(target(file), true)}
                    download={file.name}
                    aria-label={`下载 ${file.name}`}
                    aria-disabled={!available || !!busy}
                    onClick={(event) => {
                      event.preventDefault();
                      if (available && !busy) void actOnFile(file, "download");
                    }}
                    title="下载原文件"
                  >
                    <Download size={14} />
                  </a>
                  {desktop?.revealGeneratedFile && (
                    <button
                      type="button"
                      disabled={!available || !!busy}
                      onClick={() => void actOnFile(file, "reveal")}
                      aria-label={`在 Finder 中显示 ${file.name}`}
                      title="在 Finder 中显示"
                    >
                      <FolderOpen size={14} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p className="generated-files-error" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <FilePreview
          file={preview}
          target={target(preview)}
          onClose={() => setPreview(null)}
        />
      )}
    </section>
  );
}
