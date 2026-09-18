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
