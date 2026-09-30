import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_SUBAGENT_CONCURRENCY,
  MAX_SUBAGENT_BATCH_SIZE,
  validSubagentConcurrency,
  type SubagentSettings,
} from "../shared/subagent-settings.ts";

function validate(input: unknown): SubagentSettings {
  if (
    !input ||
    typeof input !== "object" ||
    !("maxConcurrentSubagents" in input) ||
    !validSubagentConcurrency(input.maxConcurrentSubagents)
  )
    throw new Error(`子代理并发数必须是 1–${MAX_SUBAGENT_BATCH_SIZE} 的整数。`);
  const native = (input as SubagentSettings).nativeOptions;
  if (native !== undefined) {
    if (!native || typeof native !== "object" || Array.isArray(native))
      throw new Error("原生设置必须是对象。");
    const allowed = new Set([
      "asyncByDefault",
      "maxSubagentDepth",
      "maxSubagentSpawnsPerRun",
      "maxSubagentSpawnsPerSession",
      "maxActiveAsyncRunsPerSession",
      "timeoutMs",
      "toolTimeoutMs",
      "usageBudget",
    ]);
    for (const [key, value] of Object.entries(native)) {
      if (!allowed.has(key)) throw new Error(`不支持的原生设置：${key}`);
      if (key === "asyncByDefault") {
        if (typeof value !== "boolean")
          throw new Error("asyncByDefault 必须是布尔值。");
      } else if (key === "usageBudget") {
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          !Object.keys(value).length
        )
          throw new Error("usageBudget 需要 tokens 或 costUsd。");
        for (const [kind, limit] of Object.entries(value)) {
          if (
            !["tokens", "costUsd"].includes(kind) ||
            !limit ||
            typeof limit !== "object" ||
            Array.isArray(limit)
          )
            throw new Error("无效的用量预算。");
          const budget = limit as { soft?: number; hard: number };
          if (
            Object.keys(budget).some(
              (key) => key !== "soft" && key !== "hard",
            ) ||
            !Number.isFinite(budget.hard) ||
            budget.hard <= 0 ||
            (budget.soft !== undefined &&
              (!Number.isFinite(budget.soft) ||
                budget.soft <= 0 ||
                budget.soft > budget.hard))
          )
            throw new Error("预算 hard 必须为正数，soft 不能超过 hard。");
        }
      } else {
        const min = [
          "maxSubagentDepth",
          "maxSubagentSpawnsPerSession",
        ].includes(key)
          ? 0
          : 1;
        const max =
          key === "maxSubagentDepth"
            ? 16
            : key.endsWith("Ms")
              ? 2147483647
              : 10000;
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < min ||
          value > max
        )
          throw new Error(`${key} 必须是 ${min}–${max} 的整数。`);
      }
    }
  }
  return {
    maxConcurrentSubagents: input.maxConcurrentSubagents,
    ...(native === undefined ? {} : { nativeOptions: structuredClone(native) }),
  };
}

/** Local application preference, separate from exported workspace contents. */
export class LocalSubagentSettings {
  private value: SubagentSettings = {
    maxConcurrentSubagents: DEFAULT_SUBAGENT_CONCURRENCY,
  };
  private writes: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(private readonly directory: string) {
    this.path = join(directory, "subagent-settings.json");
  }

  async init() {
    try {
      this.value = validate(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("无法读取子代理设置，请检查 subagent-settings.json。");
    }
  }

  current(): SubagentSettings {
    return structuredClone(this.value);
  }

  async save(input: unknown): Promise<SubagentSettings> {
    const value = validate(input);
    const operation = this.writes.then(async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, this.path);
      } catch {
        await rm(temporary, { force: true }).catch(() => {});
        throw new Error("无法保存子代理设置，请检查数据目录权限。");
      }
      this.value = value;
    });
    this.writes = operation.catch(() => {});
    await operation;
    return structuredClone(value);
  }
}
