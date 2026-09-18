import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileCode2,
  Folder,
  FolderOpen,
  Globe,
  LoaderCircle,
  Search,
  ShieldCheck,
  ShieldQuestion,
  Terminal,
  X,
} from "lucide-react";
import type { ApprovalMode, ToolCall } from "../shared/types";
import { api } from "./api";

export function ApprovalModeSwitch({
  mode,
  onChange,
  disabled = false,
}: {
  mode: ApprovalMode;
  onChange: (mode: ApprovalMode) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="approval-mode-switch"
      role="group"
      aria-label="工具审批模式"
    >
      <button
        type="button"
        aria-pressed={mode === "ask"}
        className={mode === "ask" ? "selected" : ""}
        disabled={disabled}
        title="文件读取由只读策略放行；修改文件、执行命令或联网查询前请求你的批准"
        onClick={() => onChange("ask")}
      >
        <ShieldQuestion size={13} />
        请求批准
      </button>
      <button
        type="button"
        aria-pressed={mode === "auto"}
        className={mode === "auto" ? "selected automatic" : ""}
        disabled={disabled}
        title="每次工具调用由所选安全模型审核，只有明确批准才执行；未通过转交你处理"
        onClick={() => onChange("auto")}
      >
        <ShieldCheck size={13} />
        自动审批
      </button>
    </div>
  );
}

type DirectoryListing = {
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
};

export function DirectoryField({
  value,
  onChange,
  disabled = false,
  autoBrowse = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoBrowse?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const initialValue = useRef(value);
  const browse = useCallback(async (path?: string) => {
    const current = ++request.current;
    setOpen(true);
    setBusy(true);
    setError("");
    try {
      const next = await api<DirectoryListing>(
        `/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`,
      );
      if (current === request.current) setListing(next);
    } catch (reason) {
      if (current === request.current)
        setError(reason instanceof Error ? reason.message : "无法打开文件夹");
    } finally {
      if (current === request.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (autoBrowse) void browse(initialValue.current.trim() || undefined);
  }, [autoBrowse, browse]);

  return (
    <div className="directory-field">
      <label className="form-label" htmlFor={id}>
        本地项目目录 <span>选填，留空使用临时目录</span>
      </label>
      <div className="directory-input-row">
        <FolderOpen size={15} />
        <input
          id={id}
          value={value}
          disabled={disabled}
          placeholder="输入本机文件夹的绝对路径"
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoBrowse}
        />
        {value && (
          <button
            type="button"
            className="icon-button"
            aria-label="清除自选目录，恢复临时目录"
            title="清除自选目录，确认后恢复临时目录"
            disabled={disabled}
            onClick={() => onChange("")}
          >
            <X size={13} />
          </button>
        )}
        <button
          type="button"
          className="directory-browse-button"
          disabled={disabled}
          onClick={() => {
            if (open) setOpen(false);
            else void browse(value.trim() || undefined);
          }}
          aria-expanded={open}
          aria-controls={`${id}-browser`}
        >
          浏览
          <ChevronDown size={12} />
        </button>
      </div>
      {open && !disabled && (
        <div
          id={`${id}-browser`}
          className="directory-browser"
          aria-label="浏览本机文件夹"
        >
          <div className="directory-browser-heading">
            <button
              type="button"
              className="icon-button"
              aria-label="上一级文件夹"
              disabled={busy || !listing?.parent}
              onClick={() => void browse(listing?.parent ?? undefined)}
            >
              <ArrowUp size={14} />
            </button>
            <span title={listing?.path}>{listing?.path ?? "本机文件夹"}</span>
            {busy && <LoaderCircle size={13} className="spin" />}
          </div>
          {error ? (
            <div className="directory-browser-error" role="alert">
              {error}
              <button type="button" onClick={() => void browse()}>
                打开默认目录
              </button>
            </div>
          ) : (
            <div className="directory-list" aria-busy={busy}>
              {listing?.directories.map((directory) => (
                <button
                  type="button"
                  key={directory.path}
                  disabled={busy}
                  onClick={() => void browse(directory.path)}
                >
                  <Folder size={14} />
                  <span>{directory.name}</span>
                  <ChevronRight size={12} />
                </button>
              ))}
              {!busy && listing && !listing.directories.length && (
                <p>这个文件夹没有子文件夹，可以直接选择。</p>
              )}
              {busy && !listing && <p>正在读取文件夹…</p>}
            </div>
          )}
          <button
            className="directory-select-button"
            type="button"
            disabled={busy || !listing || Boolean(error)}
            onClick={() => {
              if (listing) onChange(listing.path);
              setOpen(false);
            }}
          >
            <Check size={13} />
            选择当前文件夹
          </button>
        </div>
      )}
    </div>
  );
}

const toolLabels: Record<string, string> = {
  read: "读取文件",
  edit: "修改文件",
  write: "写入文件",
  bash: "执行命令",
  grep: "搜索文件内容",
  find: "查找文件",
  ls: "列出文件",
  web_search: "搜索网页",
  web_fetch: "读取网页 / PDF",
};
const toolStatusLabels: Record<ToolCall["status"], string> = {
  reviewing: "安全审核中",
  awaiting_approval: "等待批准",
  running: "执行中",
  completed: "已完成",
  failed: "执行失败",
  denied: "已拒绝",
  cancelled: "已取消",
};
const approvalLabels: Record<NonNullable<ToolCall["approval"]>, string> = {
  auto: "旧版自动放行（未经安全模型审核）",
  policy: "只读策略放行",
  safety_model: "安全模型已批准",
  approved: "你已批准此操作",
  denied: "你已拒绝此操作",
};
const reviewLabels = {
  reviewing: "安全模型正在审核",
  approve: "安全模型已批准",
  deny: "安全模型未批准",
  error: "安全审核异常",
  cancelled: "安全审核已取消",
};

function sourceUrl(value: string) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function ToolCallCard({
  call,
  onDecision,
}: {
  call: ToolCall;
  onDecision: (toolId: string, decision: "approve" | "deny") => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = call.status === "awaiting_approval";
  const reviewing = call.status === "reviewing";
  const decide = async (decision: "approve" | "deny") => {
    setBusy(true);
    setError("");
    try {
      await onDecision(call.id, decision);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "审批失败，请重试");
    } finally {
      setBusy(false);
    }
  };
  const target =
    call.arguments.path ??
    call.arguments.command ??
    call.arguments.query ??
    call.arguments.url;
  const sources = (call.sources ?? []).flatMap((source) => {
    const url = sourceUrl(source.url);
    return url ? [{ title: source.title, url }] : [];
  });
  return (
    <div className={`tool-call ${call.status}`} data-tool-call-id={call.id}>
      <details
        open={
          pending ||
          reviewing ||
          call.status === "running" ||
          call.status === "failed"
        }
      >
        <summary>
          {call.name === "bash" ? (
            <Terminal size={14} />
          ) : call.name === "web_search" ? (
            <Search size={14} />
          ) : call.name === "web_fetch" ? (
            <Globe size={14} />
          ) : (
            <FileCode2 size={14} />
          )}
          <b>{toolLabels[call.name] ?? call.name}</b>
          <span className="tool-call-status">
            {(call.status === "running" || reviewing) && (
              <LoaderCircle size={11} className="spin" />
            )}
            {toolStatusLabels[call.status]}
          </span>
          <ChevronDown size={12} />
        </summary>
        <div className="tool-call-body">
          <span className="tool-content-label">参数 · {call.name}</span>
          <pre>{JSON.stringify(call.arguments, null, 2)}</pre>
          {call.safetyReview && (
            <div className={`tool-safety-review ${call.safetyReview.decision}`}>
              <b>
                <ShieldCheck size={12} />
                {reviewLabels[call.safetyReview.decision]}
              </b>
              <span>审核模型：{call.safetyReview.model || "未配置"}</span>
              <p>
                {call.safetyReview.reason ||
                  (reviewing
                    ? "正在评估这次操作，审核通过前不会执行。"
                    : "没有返回审核理由。")}
              </p>
              {pending && (
                <small>操作尚未执行，请根据审核理由决定是否批准。</small>
              )}
            </div>
          )}
          {call.output !== undefined && (
            <>
              <span className="tool-content-label">
                {call.name === "bash" ? "命令输出" : "执行结果"}
              </span>
              <pre>{call.output || "操作完成，无文本输出。"}</pre>
            </>
          )}
          {sources.length > 0 && (
            <div className="tool-sources" aria-label="网页来源">
              <span className="tool-content-label">网页来源</span>
              {sources.map((source, index) => (
                <a
                  key={`${source.url}-${index}`}
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={source.url}
                >
                  <ExternalLink size={12} />
                  <span>{source.title || source.url}</span>
                </a>
              ))}
            </div>
          )}
          {call.error && <div className="inline-error">{call.error}</div>}
          {call.approval && (
            <span className="tool-approval-record">
              {approvalLabels[call.approval]}
            </span>
          )}
        </div>
      </details>
      {typeof target === "string" && (
        <div className="tool-target" title={target}>
          {target}
        </div>
      )}
      {pending && (
        <div className="tool-approval-actions">
          <p>
            {call.name === "bash"
              ? "批准后将在本机运行以上命令。"
              : call.name === "web_search"
                ? "批准后将以上查询发送给 Exa，搜索结果会交给对话模型。"
                : call.name === "web_fetch"
                  ? "批准后将访问以上公开网址，提取的网页或 PDF 文本会交给对话模型。"
                  : call.name === "read"
                    ? "批准后将读取以上文件并交给对话模型。"
                    : "批准后将修改工作目录中的文件。"}
          </p>
          <div>
            <button
              type="button"
              className="tool-deny"
              disabled={busy}
              onClick={() => void decide("deny")}
            >
              <X size={13} />
              拒绝
            </button>
            <button
              type="button"
              className="tool-approve"
              disabled={busy}
              onClick={() => void decide("approve")}
            >
              {busy ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <Check size={13} />
              )}
              批准这次操作
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

export function ToolActivity({
  calls,
  workingDirectory,
  onDecision,
}: {
  calls: ToolCall[];
  workingDirectory?: string;
  onDecision: (toolId: string, decision: "approve" | "deny") => Promise<void>;
}) {
  return (
    <section className="tool-activity" aria-label="Agent 工具活动">
      <div className="tool-activity-heading">
        <Terminal size={13} />
        <b>工具活动</b>
        <span>{calls.length} 次操作</span>
      </div>
      {workingDirectory && (
        <div className="tool-working-directory" title={workingDirectory}>
          <FolderOpen size={12} />
          {workingDirectory}
        </div>
      )}
      {calls.map((call) => (
        <ToolCallCard key={call.id} call={call} onDecision={onDecision} />
      ))}
    </section>
  );
}
