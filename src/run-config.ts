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

/** Only a current, dispatched computer tool can establish the automatic state. */
export function automaticLongTask(
  requests?: ToolRequest[],
  calls?: ToolCall[],
): boolean {
  return Boolean(
    requests?.includes("computer_use") ||
      calls?.some(
        (call) =>
          ["computer_use_tools", "computer_use_call"].includes(call.name) &&
          typeof call.authorization?.consumedAt === "number",
      ),
  );
}
