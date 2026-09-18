import type { ContextUsage } from "../shared/context-usage";
import type { TurnNode } from "../shared/types";
import "./context-usage-ring.css";

const fullNumber = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 0,
});

export function contextCompressionLabel(
  usage: ContextUsage,
  status?: TurnNode["status"],
): string {
  switch (usage.compressionStatus) {
    case "full":
      return "未压缩";
    case "compacting":
      return "压缩中";
    case "compacted":
      return "已压缩";
    case "failed":
      return "压缩失败";
    case "cancelled":
      return "压缩已停止";
    default:
      return status === "queued"
        ? "等待请求"
        : status === "root"
          ? "尚无请求"
          : "未记录压缩状态";
  }
}

export function contextUsageLabel(usage: ContextUsage): string {
  if (usage.source === "archive") return "原文档案估算";
  if (usage.source === "estimate") {
    if (usage.compressionStatus === "compacting") return "待发送输入";
    if (
      usage.compressionStatus === "failed" ||
      usage.compressionStatus === "cancelled"
    )
      return "当前上下文估算";
  }
  return usage.outputTokens === undefined
    ? "当前上下文"
    : "当前上下文（含生成）";
}

export function contextUsageSourceLabel(usage: ContextUsage): string {
  return usage.source === "provider"
    ? "供应商实测"
    : usage.source === "estimate"
      ? "请求估算"
      : "原文估算";
}

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
    `${contextUsageLabel(usage)}：${fullNumber.format(usage.tokens)} / ${known ? fullNumber.format(usage.limit!) : "未知上限"} tokens${known ? `（${label}）` : ""}`,
    ...(usage.inputTokens !== undefined
      ? [
          `输入 ${fullNumber.format(usage.inputTokens)} + 本次生成 ${usage.outputTokens === undefined ? "暂无计数" : fullNumber.format(usage.outputTokens)} tokens`,
        ]
      : []),
    `计数来源：${contextUsageSourceLabel(usage)}`,
    `模型：${modelName}`,
    ...(usage.source === "provider"
      ? ["最近一次模型调用的输入（含缓存）加该次生成；此前各轮内容已计入输入。"]
      : usage.source === "estimate"
        ? [
            "输入包含请求消息、系统提示和工具定义；生成期间更新估算，供应商返回计数后校准。",
          ]
        : [
            "尚无请求计数；按可见问答与工具记录估算，不能据此判断是否压缩或超出模型容量。",
          ]),
    ...(usage.source !== "archive"
      ? [
          `原文档案估算：${fullNumber.format(usage.rawTokens)} tokens（原始记录仍完整保留）。`,
        ]
      : []),
    ...(usage.compressionStatus
      ? [`压缩状态：${contextCompressionLabel(usage)}`]
      : []),
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
