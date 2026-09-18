import { useId, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  GitCommitHorizontal,
  History,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import type { GitHistoryEntry } from "../shared/types";
import "./git-history.css";

const fileStatus = {
  added: { label: "新增", mark: "A" },
  modified: { label: "修改", mark: "M" },
  deleted: { label: "删除", mark: "D" },
};

const timeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function HistoryTime({ timestamp }: { timestamp: number }) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return <span>时间未知</span>;
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString("zh-CN")}>
      {timeFormatter.format(date)}
    </time>
  );
}

export function GitHistoryPanel({
  entries,
  nodeIds,
  onLocate,
}: {
  entries: GitHistoryEntry[];
  nodeIds: string[];
  onLocate: (nodeId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const availableNodes = useMemo(() => new Set(nodeIds), [nodeIds]);
  const orderedEntries = useMemo(
    () => [...entries].sort((a, b) => b.createdAt - a.createdAt),
    [entries],
  );

  return (
    <section
      className={`git-history-panel nodrag nopan nowheel ${expanded ? "is-expanded" : "is-collapsed"}`}
      aria-label="Git 记录"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && expanded) {
          setExpanded(false);
          toggleRef.current?.focus();
        }
      }}
    >
      <button
        ref={toggleRef}
        type="button"
        className="git-history-toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
        aria-label={`${expanded ? "收起" : "展开"} Git 记录（${entries.length} 条）`}
        title={expanded ? "收起 Git 记录" : "展开 Git 记录"}
        onClick={() => setExpanded((current) => !current)}
      >
        <GitCommitHorizontal size={15} aria-hidden="true" />
        <span>Git 记录</span>
        <span className="git-history-count">{entries.length}</span>
        {expanded ? (
          <ChevronUp size={14} aria-hidden="true" />
        ) : (
          <ChevronDown size={14} aria-hidden="true" />
        )}
      </button>
      <div id={contentId} className="git-history-content" hidden={!expanded}>
        {orderedEntries.length ? (
          <>
            <div className="git-history-description">
              <span>文件更新 · 最新在前</span>
              <span>点击定位卡片</span>
            </div>
            <ol className="git-history-list">
              {orderedEntries.map((entry) => {
                const canLocate = availableNodes.has(entry.nodeId);
                const prompt = entry.nodePrompt.trim() || "未命名操作";
                const summary =
                  entry.status === "failed"
                    ? "Git 快照保存失败"
                    : entry.summary ||
                      (entry.status === "recording"
                        ? "正在记录文件更新"
                        : `${entry.files.length} 个文件已更新`);
                return (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="git-history-entry"
                      disabled={!canLocate}
                      aria-label={
                        canLocate
                          ? `定位对应卡片：${prompt}，${summary}，${entry.files.length} 个文件`
                          : `对应卡片已删除：${prompt}`
                      }
                      title={
                        canLocate ? `定位对应卡片：${prompt}` : "对应卡片已删除"
                      }
                      onClick={() => {
                        onLocate(entry.nodeId);
                        setExpanded(false);
                        toggleRef.current?.focus({ preventScroll: true });
                      }}
                    >
                      <span className="git-history-entry-meta">
                        <span className="git-history-tool">
                          {entry.toolName}
                        </span>
                        <HistoryTime timestamp={entry.createdAt} />
                        {entry.commit && (
                          <code title={`记录版本：${entry.commit}`}>
                            {entry.commit.slice(0, 7)}
                          </code>
                        )}
                      </span>
                      <span className="git-history-summary">{summary}</span>
                      {entry.status === "recording" && (
                        <span className="git-history-recording" role="status">
                          <LoaderCircle
                            size={11}
                            className="spin"
                            aria-hidden="true"
                          />
                          正在保存 Git 快照…
                        </span>
                      )}
                      <span className="git-history-files">
                        {entry.files.slice(0, 4).map((file, index) => (
                          <span
                            className="git-history-file"
                            key={`${file.path}-${index}`}
                            title={`${fileStatus[file.status].label}：${file.path}`}
                          >
                            <span
                              className={`git-history-file-status ${file.status}`}
                              aria-label={fileStatus[file.status].label}
                            >
                              {fileStatus[file.status].mark}
                            </span>
                            <code>{file.path}</code>
                          </span>
                        ))}
                        {entry.files.length > 4 && (
                          <span
                            className="git-history-more-files"
                            title={entry.files
                              .slice(4)
                              .map((file) => file.path)
                              .join("\n")}
                          >
                            另 {entry.files.length - 4} 个文件
                          </span>
                        )}
                      </span>
                      {entry.status === "failed" && (
                        <span
                          className="git-history-error"
                          title={
                            entry.error ||
                            "Git 快照保存失败，文件操作可能已经执行"
                          }
                        >
                          快照保存失败 · {entry.error || "文件操作可能已经执行"}
                        </span>
                      )}
                      {entry.interrupted && (
                        <span className="git-history-recovered">
                          中断后恢复的记录
                        </span>
                      )}
                      {entry.restoredAt && (
                        <span
                          className="git-history-restored"
                          title={`已于 ${new Date(entry.restoredAt).toLocaleString("zh-CN")} 恢复本轮文件修改`}
                        >
                          <RotateCcw size={11} aria-hidden="true" />
                          已在原地重试前回溯
                        </span>
                      )}
                      <span className="git-history-node">
                        <span>{canLocate ? prompt : "对应卡片已删除"}</span>
                        {canLocate && (
                          <ArrowUpRight size={12} aria-hidden="true" />
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </>
        ) : (
          <div className="git-history-empty">
            <History size={22} aria-hidden="true" />
            <strong>还没有 Git 快照</strong>
            <p>后续文件更新会自动保存快照，并关联对应卡片。</p>
          </div>
        )}
        <p className="git-history-footer">独立 Git 快照 · 遵循 .gitignore</p>
      </div>
    </section>
  );
}
