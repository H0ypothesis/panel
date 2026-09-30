export const DEFAULT_SUBAGENT_CONCURRENCY = 4;
export const MAX_SUBAGENT_BATCH_SIZE = 8;

export interface SubagentSettings {
  maxConcurrentSubagents: number;
  nativeOptions?: {
    asyncByDefault?: boolean;
    maxSubagentDepth?: number;
    maxSubagentSpawnsPerRun?: number;
    maxSubagentSpawnsPerSession?: number;
    maxActiveAsyncRunsPerSession?: number;
    timeoutMs?: number;
    toolTimeoutMs?: number;
    usageBudget?: {
      tokens?: { soft?: number; hard: number };
      costUsd?: { soft?: number; hard: number };
    };
  };
}

export function validSubagentConcurrency(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_SUBAGENT_BATCH_SIZE
  );
}
