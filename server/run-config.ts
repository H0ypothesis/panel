import type { RunConfig } from "../shared/types.ts";

export function validateLongTask(value: unknown): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean")
    throw new Error("长程任务配置必须是布尔值。");
  return value;
}

/** Missing on legacy cards is equivalent to explicitly disabling long tasks. */
export function runConfigsMatch(a: RunConfig, b: RunConfig): boolean {
  return (
    a.model === b.model &&
    a.thinking === b.thinking &&
    (a.longTask === true) === (b.longTask === true)
  );
}
