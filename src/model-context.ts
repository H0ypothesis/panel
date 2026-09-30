import type { ModelOption } from "../shared/types";

/** Compact context capacity, using decimal K/M units rather than binary units. */
export function formatContextWindow(
  capacity: number | null | undefined,
): string {
  if (capacity == null || !Number.isFinite(capacity) || capacity <= 0)
    return "未知";
  if (capacity >= 1_000_000)
    return `${Number((capacity / 1_000_000).toFixed(1))}M`;
  if (capacity >= 1_000) return `${Number((capacity / 1_000).toFixed(1))}K`;
  return String(capacity);
}

export function modelContextLabel(model: ModelOption | undefined): string {
  const capacity = formatContextWindow(model?.contextWindow);
  return model?.contextWindowSource === "fallback"
    ? `预算 ${capacity}`
    : model?.contextWindowSource === "configured"
      ? `配置 ${capacity}`
      : capacity;
}

export function modelContextTitle(model: ModelOption | undefined): string {
  const capacity = model?.contextWindow;
  if (capacity == null || !Number.isFinite(capacity) || capacity <= 0)
    return "上下文容量未知";
  const tokens = capacity.toLocaleString("zh-CN", {
    maximumFractionDigits: 20,
  });
  if (model?.contextWindowSource === "fallback")
    return `模型上限未知；本地兜底预算：${tokens} tokens`;
  if (model?.contextWindowSource === "configured")
    return `已配置上下文预算：${tokens} tokens`;
  return `上下文容量：${tokens} tokens`;
}
