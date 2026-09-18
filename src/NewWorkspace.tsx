import { useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  FileJson,
  GitBranch,
  LoaderCircle,
  Plus,
} from "lucide-react";
import { api, type MutationResult } from "./api";
import "./workspace-import.css";

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

type ImportFile = {
  name: string;
  data: unknown;
  title?: string;
  nodeCount?: number;
};

function importPreview(name: string, data: unknown): ImportFile {
  const preview: ImportFile = { name, data };
  if (!data || typeof data !== "object" || !("workspace" in data))
    return preview;
  const workspace = data.workspace;
  if (!workspace || typeof workspace !== "object") return preview;
  if ("title" in workspace && typeof workspace.title === "string")
    preview.title = workspace.title;
  if ("nodes" in workspace && Array.isArray(workspace.nodes))
    preview.nodeCount = workspace.nodes.length;
  return preview;
}

export function NewWorkspace({
  onCreated,
}: {
  onCreated: (result: MutationResult) => void;
}) {
  const [mode, setMode] = useState<"blank" | "import">("blank");
  const [source, setSource] = useState<"file" | "path">("file");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<ImportFile | null>(null);
  const [path, setPath] = useState("");
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const disabled = busy || reading;
  const ready =
    mode === "blank"
      ? !!title.trim()
      : source === "file"
        ? !!file
        : !!path.trim();

  const readFile = async (selected: File) => {
    setSource("file");
    setFile(null);
    setError("");
    if (selected.size > MAX_IMPORT_BYTES) {
      setError("JSON 文件不能超过 20 MiB，请选择较小的导出文件。");
      return;
    }
    setReading(true);
    try {
      const text = await selected.text();
      let data: unknown;
      try {
        data = JSON.parse(text.replace(/^\uFEFF/, ""));
      } catch {
        throw new Error("文件不是有效的 JSON，请选择 Panel 导出的 JSON 文件。");
      }
      setFile(importPreview(selected.name, data));
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "无法读取文件，请重新选择。",
      );
    } finally {
      setReading(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending.current || disabled || !ready) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result =
        mode === "blank"
          ? await api<MutationResult>("/workspaces", { title, description })
          : await api<MutationResult>(
              "/workspaces/import",
              source === "file" ? { data: file!.data } : { path: path.trim() },
            );
      onCreated(result);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : mode === "blank"
            ? "创建失败，请重试。"
            : "导入失败，请重试。",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <form className="new-workspace-form" onSubmit={submit} aria-busy={disabled}>
      <div className="modal-illustration">
        {mode === "blank" ? <GitBranch size={27} /> : <FileJson size={27} />}
      </div>
      <div className="eyebrow">THINK IN BRANCHES</div>
      <h2>开启一个新的探索</h2>
      <p className="modal-intro">
        {mode === "blank"
          ? "每个空间自带临时目录，可直接开始；也可在根节点选择本地项目。"
          : "导入他人分享的 Panel JSON，查看完整对话分支与历史回答。"}
      </p>
      <div
        className="workspace-create-modes"
        role="group"
        aria-label="新建方式"
      >
        {(
          [
            ["blank", "创建空白"],
            ["import", "导入 JSON"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            disabled={disabled}
            onClick={() => {
              setMode(value);
              setError("");
            }}
          >
            {value === "blank" ? <Plus size={14} /> : <FileJson size={14} />}
            {label}
          </button>
        ))}
      </div>
      {mode === "blank" ? (
        <>
          <label className="form-label">
            探索主题
            <input
              autoFocus
              required
              disabled={disabled}
              maxLength={80}
              placeholder="例如：下一代 AI 工作台应该是什么样？"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label className="form-label">
            背景与目标 <span>选填</span>
            <textarea
              disabled={disabled}
              maxLength={10000}
              placeholder="补充一些背景。这些信息会被所有分支继承。"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
        </>
      ) : (
        <>
          <fieldset className="workspace-import-source" disabled={disabled}>
            <legend>
              导入来源 <span>二选一 · 最大 20 MiB</span>
            </legend>
            <div className="workspace-import-options">
              <label>
                <input
                  type="radio"
                  name="workspace-import-source"
                  checked={source === "file"}
                  onChange={() => {
                    setSource("file");
                    setError("");
                  }}
                />
                本机文件
              </label>
              <label>
                <input
                  type="radio"
                  name="workspace-import-source"
                  checked={source === "path"}
                  onChange={() => {
                    setSource("path");
                    setError("");
                  }}
                />
                文件路径
              </label>
            </div>
            {source === "file" ? (
              <>
                <label className="form-label workspace-import-file">
                  选择 JSON 文件
                  <input
                    type="file"
                    accept=".json,application/json"
                    onChange={(event) => {
                      const selected = event.target.files?.[0];
                      event.target.value = "";
                      if (selected) void readFile(selected);
                    }}
                  />
                </label>
                <div className="workspace-import-preview" aria-live="polite">
                  {reading ? (
                    <p>
                      <LoaderCircle size={14} className="spin" /> 正在读取文件…
                    </p>
                  ) : file ? (
                    <>
                      <strong>{file.name}</strong>
                      {file.title !== undefined && (
                        <p>探索主题：{file.title}</p>
                      )}
                      {file.nodeCount !== undefined && (
                        <p>{file.nodeCount} 个节点（含根节点）</p>
                      )}
                      <small>导入时会检查文件格式与对话分支。</small>
                    </>
                  ) : (
                    <p>
                      选择已导出的 panel-exploration.json 或其他 Panel JSON
                      文件。
                    </p>
                  )}
                </div>
              </>
            ) : (
              <label className="form-label workspace-import-path">
                服务所在机器的 JSON 路径
                <input
                  required
                  autoFocus
                  type="text"
                  value={path}
                  placeholder="~/Downloads/panel-exploration.json"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(event) => {
                    setPath(event.target.value);
                    setError("");
                  }}
                  aria-describedby="workspace-import-path-help"
                />
                <small id="workspace-import-path-help">
                  填写绝对路径或 ~/ 路径。文件须位于运行 Panel 服务的机器上。
                </small>
              </label>
            )}
          </fieldset>
          <p className="workspace-import-note">
            导入后创建独立探索，恢复对话图与输出结果。源工作目录、目录中的文件与运行任务不会恢复；审批方式默认为「请求批准」。
          </p>
        </>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <button className="primary-button" disabled={!ready || disabled}>
        {busy ? (
          <LoaderCircle size={15} className="spin" />
        ) : mode === "blank" ? (
          <Plus size={15} />
        ) : (
          <FileJson size={15} />
        )}
        {busy
          ? mode === "blank"
            ? "正在创建…"
            : "正在导入…"
          : mode === "blank"
            ? "创建探索"
            : "导入探索"}
        <ArrowRight size={15} />
      </button>
    </form>
  );
}
