import {
  thinkingLabels,
  type ModelOption,
  type RunConfig,
} from "../shared/types.ts";
import { effortLevels } from "../shared/provider-settings.ts";
import {
  normalizeThinking,
  thinkingConflict,
} from "../shared/thinking-controls.ts";

export function workspaceDefaultConfig(
  value: unknown,
  models: ModelOption[],
): RunConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("请选择模型与思考强度。");
  const config = value as Partial<RunConfig>;
  if (
    typeof config.model !== "string" ||
    typeof config.thinking !== "string" ||
    !Object.hasOwn(thinkingLabels, config.thinking)
  )
    throw new Error("请选择有效的模型与思考强度。");
  if (
    config.thinkingMode !== undefined &&
    !["default", "enabled", "disabled"].includes(config.thinkingMode)
  )
    throw new Error("思考开关设置无效。");
  if (
    config.effort !== undefined &&
    config.effort !== "default" &&
    !effortLevels.includes(config.effort)
  )
    throw new Error("思考强度设置无效。");
  validateLongTask(config.longTask);
  const model = models.find((item) => item.id === config.model);
  if (!model?.available) throw new Error("请选择一个已连接的模型。");
  const result = normalizeThinking(
    {
      model: config.model,
      thinking: config.thinking,
      ...(config.thinkingMode === undefined
        ? {}
        : { thinkingMode: config.thinkingMode }),
      ...(config.effort === undefined ? {} : { effort: config.effort }),
    },
    model,
  );
  const conflict = thinkingConflict(result, model.thinkingControls);
  if (conflict) throw new Error(conflict);
  return result;
}

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
