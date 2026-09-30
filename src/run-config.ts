import type {
  ModelOption,
  RunConfig,
  ToolCall,
  ToolRequest,
} from "../shared/types";

/** Each new branch makes its own duration choice; model preferences can carry. */
export function newBranchConfig(config: RunConfig): RunConfig {
  return { ...config, longTask: false };
}

export function configForModel(
  config: RunConfig,
  model: ModelOption,
): RunConfig {
  return {
    ...config,
    model: model.id,
    thinking: model.thinkingLevels.includes(config.thinking)
      ? config.thinking
      : model.thinkingLevels.includes("medium")
        ? "medium"
        : model.thinkingLevels[0],
  };
}

/** Explicit selection or authorized capability dispatch enables long execution. */
export function automaticLongTask(
  requests?: ToolRequest[],
  calls?: ToolCall[],
  subagentsEnabled = false,
): boolean {
  return Boolean(
    subagentsEnabled ||
      requests?.some((tool) => ["computer_use", "subagents"].includes(tool)) ||
      calls?.some(
        (call) =>
          [
            "computer_use_tools",
            "computer_use_call",
            "subagents_enable",
            "subagent",
          ].includes(call.name) &&
          typeof call.authorization?.consumedAt === "number",
      ),
  );
}
