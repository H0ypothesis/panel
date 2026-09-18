import type { ContextUsage } from "../shared/context-usage";
import "./context-usage-ring.css";

const fullNumber = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 0,
});

export function ContextUsageRing({
  usage,
  modelName,
}: {
  usage: ContextUsage;
  modelName: string;
}) {
  const known =
    usage.limit !== null &&
    Number.isFinite(usage.limit) &&
    usage.limit > 0 &&
    usage.percentage !== null &&
    Number.isFinite(usage.percentage);
  const percentage = known ? Math.max(0, usage.percentage!) : null;
  const label =
    percentage === null
      ? "—"
      : percentage > 0 && percentage < 1
        ? "<1%"
        : `${Math.round(percentage)}%`;
  const level =
    percentage === null
      ? "unknown"
      : percentage >= 90
        ? "danger"
        : percentage >= 70
          ? "warning"
          : "normal";
  const description = [
    `路径上下文估算：${fullNumber.format(usage.tokens)} / ${known ? fullNumber.format(usage.limit!) : "未知上限"} tokens${known ? `（${label}）` : ""}`,
    `模型：${modelName}`,
    "按可见问题、回答和工具记录估算；实际请求还包含系统提示等内容。",
    ...(usage.stale ? ["上游已更新，请重新生成后续节点。"] : []),
  ].join("\n");

  return (
    <span
      className={`context-usage-ring ${level} nodrag nopan`}
      role="img"
      aria-label={description}
      title={description}
      tabIndex={0}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <circle className="context-usage-track" cx="16" cy="16" r="13.5" />
        {percentage !== null && (
          <circle
            className="context-usage-fill"
            cx="16"
            cy="16"
            r="13.5"
            pathLength="100"
            strokeDasharray="100"
            strokeDashoffset={100 - Math.min(100, percentage)}
            transform="rotate(-90 16 16)"
          />
        )}
      </svg>
      <span
        className={`context-usage-value${label.length > 4 ? " compact" : ""}`}
        aria-hidden="true"
      >
        {label}
      </span>
    </span>
  );
}
