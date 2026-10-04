import type { ModelOption, RunConfig } from "./types.ts";
import type { ThinkingControls } from "./provider-settings.ts";

export function thinkingConflict(
  config: RunConfig,
  controls?: ThinkingControls,
): string | undefined {
  if (
    controls?.effortRequiresThinking &&
    config.thinkingMode === "disabled" &&
    config.effort &&
    config.effort !== "default"
  )
    return "此模型的接口无法同时设置关闭思考和独立 effort；请将 effort 设为默认，或开启思考。";
}

export function normalizeThinking(
  config: RunConfig,
  model: Pick<ModelOption, "id" | "thinkingLevels" | "thinkingControls">,
): RunConfig {
  const controls = model.thinkingControls;
  const fallback = model.thinkingLevels.includes("medium")
    ? "medium"
    : model.thinkingLevels[0];
  if (!controls) {
    const { thinkingMode: _mode, effort: _effort, ...legacyConfig } = config;
    return {
      ...legacyConfig,
      model: model.id,
      thinking: model.thinkingLevels.includes(config.thinking)
        ? config.thinking
        : fallback,
    };
  }
  const legacy =
    config.thinkingMode === undefined && config.effort === undefined;
  const thinkingMode =
    controls.toggle === "unknown"
      ? "default"
      : controls.toggle === "required"
        ? "enabled"
        : (config.thinkingMode ??
          (config.thinking === "off" ? "disabled" : "enabled"));
  const requested = config.effort ?? (legacy ? config.thinking : "default");
  const effort =
    controls.efforts.find((level) => level === requested) ??
    (legacy && controls.toggle === "required"
      ? (controls.efforts[0] ?? "default")
      : "default");
  const thinking =
    thinkingMode === "disabled" ||
    (thinkingMode === "default" && effort === "default")
      ? "off"
      : effort !== "default"
        ? effort
        : (model.thinkingLevels.find((level) => level !== "off") ?? fallback);
  return { ...config, model: model.id, thinking, thinkingMode, effort };
}

export function thinkingDescription(config: RunConfig): string {
  if (config.thinkingMode === undefined && config.effort === undefined)
    return config.thinking;
  if (config.thinkingMode === "disabled")
    return config.effort && config.effort !== "default"
      ? `思考关闭 · ${config.effort}`
      : "思考关闭";
  if (config.effort && config.effort !== "default") return config.effort;
  return config.thinkingMode === "enabled"
    ? "思考开启 · 默认 effort"
    : "服务默认";
}
