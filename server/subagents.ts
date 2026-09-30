import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentMessage,
  AgentTool,
} from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { SubagentRun, ThinkingContent } from "../shared/types.ts";
import type { AgentConfig, ChildSessionFactory } from "./nicobailon-engine.ts";
import { loadNicobailon } from "./nicobailon-loader.ts";

export const SUBAGENT_PROMPT = `
你可以根据任务需要自主调用 subagent，让多个子代理分别调查、实现或审查独立子任务。简单任务直接处理；存在独立工作时可一次传入 tasks 并行委派。每个子代理使用独立上下文，明确提供目标、相关文件和必要背景，不要让多个代理同时修改同一文件。工具会等待这批代理结束并返回结果；你应检查结果并综合回答。子代理共享本卡片的工作目录和审批规则。用户选择 @subagents 时，本轮必须开启并按任务调用子代理；历史中的选择不要求重复委派。`;

const roles = ["scout", "worker", "reviewer"] as const;
const rolePrompts = {
  scout:
    "调查给定问题、阅读相关文件或网页，返回可核实的发现与来源。不要修改文件。",
  worker: "完成明确委派的实现或分析任务，保留现有改动，检查结果并简洁报告。",
  reviewer:
    "独立审查给定内容，检查正确性、遗漏和风险，提供具体证据。不要修改文件。",
};
const taskSchema = Type.Object({
  agent: Type.Union(roles.map((role) => Type.Literal(role))),
  task: Type.String({
    minLength: 1,
    maxLength: 20000,
    description: "完整子任务，包含必要背景、相关文件和期望输出。",
  }),
});

export interface ChildRunInput {
  id: string;
  systemPrompt: string;
  task: string;
  allowedTools: string[];
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  onText: (text: string) => void;
  onThinking: (thinking: ThinkingContent) => void;
}

interface SubagentOptions {
  cwd: string;
  model: string;
  signal: AbortSignal;
  thinking: string;
  onEnabled?: () => void;
  onUpdate?: (run: SubagentRun) => void;
  runChild: (input: ChildRunInput) => Promise<{ usage?: SubagentRun["usage"] }>;
}

/** One card owns the queue, cancellation and child identities. No global factory. */
export class Subagents {
  private readonly records: SubagentRun[] = [];
  private readonly active = new Set<Promise<void>>();
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;

  constructor(private readonly options: SubagentOptions) {
    this.signal = AbortSignal.any([options.signal, this.controller.signal]);
  }

  private publish(run: SubagentRun) {
    this.options.onUpdate?.(structuredClone(run));
  }

  tools(): AgentTool[] {
    return [
      {
        name: "subagents_enable",
        label: "开启 Subagents",
        description:
          "为本轮开启子代理协作。随后由你调用 subagent 分配具体任务；开启本身不会启动代理。",
        parameters: Type.Object({}),
        execute: async () => {
          this.signal.throwIfAborted();
          await loadNicobailon();
          this.signal.throwIfAborted();
          this.options.onEnabled?.();
          return {
            content: [
              {
                type: "text",
                text: "Subagents 已开启。请调用 subagent，传入单个 agent/task 或 tasks 列表，按任务需要委派工作。",
              },
            ],
            details: {},
          };
        },
      },
      {
        name: "subagent",
        label: "子代理协作",
        description:
          "由 nicobailon/pi-subagents 执行独立子代理任务。scout 调查、worker 实现、reviewer 审查。传 agent/task 启动一个，或 tasks 并行启动多个（最多 8 个，最多 3 个同时执行）。调用等待所有结果；不要把同一工作重复交给主代理和子代理。子代理继承本轮模型和审批，不能继续创建子代理。",
        parameters: Type.Object({
          agent: Type.Optional(taskSchema.properties.agent),
          task: Type.Optional(taskSchema.properties.task),
          tasks: Type.Optional(
            Type.Array(taskSchema, { minItems: 1, maxItems: 8 }),
          ),
        }),
        execute: async (_id, rawInput, toolSignal, onUpdate) => {
          const input = rawInput as {
            agent?: SubagentRun["agent"];
            task?: string;
            tasks?: { agent: SubagentRun["agent"]; task: string }[];
          };
          const signal = toolSignal
            ? AbortSignal.any([this.signal, toolSignal])
            : this.signal;
          signal.throwIfAborted();
          if (
            input.tasks &&
            (input.agent !== undefined || input.task !== undefined)
          )
            throw new Error("请使用 agent/task 或 tasks，不能同时提供。");
          const tasks =
            input.tasks ??
            (input.agent && input.task
              ? [{ agent: input.agent, task: input.task }]
              : []);
          if (!tasks.length || tasks.some((task) => !task.task.trim()))
            throw new Error("请提供明确的子代理任务。");
          if (this.records.length + tasks.length > 24)
            throw new Error("本轮最多启动 24 个子代理，请汇总已有结果。");
          const engine = await loadNicobailon();
          signal.throwIfAborted();
          this.options.onEnabled?.();
          const runs = tasks.map(
            ({ agent, task }): SubagentRun => ({
              id: randomUUID(),
              agent,
              task,
              model: this.options.model,
              status: "queued",
              response: "",
              createdAt: Date.now(),
            }),
          );
          this.records.push(...runs);
          runs.forEach((run) => this.publish(run));
          const progress = () =>
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: runs
                    .map(
                      (run) =>
                        `${run.agent}: ${run.status} — ${run.task.slice(0, 100)}`,
                    )
                    .join("\n"),
                },
              ],
              details: { ids: runs.map((run) => run.id) },
            });
          let next = 0;
          const worker = async () => {
            while (next < runs.length) {
              const run = runs[next++];
              if (signal.aborted) {
                Object.assign(run, {
                  status: "cancelled",
                  finishedAt: Date.now(),
                });
                this.publish(run);
                continue;
              }
              run.status = "running";
              run.startedAt = Date.now();
              this.publish(run);
              progress();
              const allowedTools =
                run.agent === "worker"
                  ? ["read", "write", "edit", "bash", "web_search", "web_fetch"]
                  : ["read", "web_search", "web_fetch"];
              const factory: ChildSessionFactory = {
                create: async (launch) => {
                  const messages: AgentMessage[] = [];
                  const listeners = new Set<
                    (event: { type: string; [key: string]: unknown }) => void
                  >();
                  const abort = new AbortController();
                  let running: Promise<void> | undefined;
                  return {
                    sessionId: run.id,
                    sessionFile: undefined,
                    modelId: this.options.model.split("/").slice(1).join("/"),
                    messages,
                    subscribe(listener) {
                      listeners.add(listener);
                      return () => listeners.delete(listener);
                    },
                    prompt: async (task) => {
                      running = (async () => {
                        const result = await this.options.runChild({
                          id: run.id,
                          systemPrompt:
                            launch.systemPrompt ?? rolePrompts[run.agent],
                          task,
                          allowedTools,
                          signal: AbortSignal.any([signal, abort.signal]),
                          onEvent: (event) => {
                            if (event.type === "message_end")
                              messages.push(event.message);
                            if (
                              event.type === "message_end" &&
                              event.message.role === "assistant"
                            ) {
                              const usage = event.message.usage;
                              const previous = run.usage;
                              run.usage = {
                                input:
                                  (previous?.input ?? 0) +
                                  usage.input +
                                  usage.cacheRead +
                                  usage.cacheWrite,
                                output: (previous?.output ?? 0) + usage.output,
                                total:
                                  (previous?.total ?? 0) + usage.totalTokens,
                                ...(/^(paperbypass|atria|xiaomi-token-plan-cn)\//.test(
                                  this.options.model,
                                )
                                  ? {}
                                  : {
                                      cost:
                                        (previous?.cost ?? 0) +
                                        usage.cost.total,
                                    }),
                              };
                            }
                            for (const listener of listeners) listener(event);
                          },
                          onText: (text) => {
                            run.response = text.slice(-200000);
                            this.publish(run);
                          },
                          onThinking: (thinking) => {
                            run.thinking = {
                              ...thinking,
                              text: thinking.text.slice(-100000),
                            };
                            this.publish(run);
                          },
                        });
                        run.usage = result.usage;
                        for (const listener of listeners)
                          listener({ type: "agent_settled" });
                      })();
                      return running;
                    },
                    steer: async () => {
                      throw new Error("本轮子代理不支持追加指令。");
                    },
                    followUp: async () => {
                      throw new Error("本轮子代理不支持追加指令。");
                    },
                    abort: async () => {
                      abort.abort();
                    },
                    dispose: async () => {
                      abort.abort();
                      await running?.catch(() => {});
                    },
                  };
                },
                dispose: async () => {},
              };
              const profile: AgentConfig = {
                name: run.agent,
                description: rolePrompts[run.agent],
                systemPrompt: rolePrompts[run.agent],
                source: "runtime",
                filePath: "",
                systemPromptMode: "replace",
                inheritProjectContext: false,
                inheritGlobalContext: false,
                inheritSkills: false,
                allowNestedSubagents: false,
                extensions: [],
                skills: [],
                tools: allowedTools,
              };
              try {
                const result = await engine.runSync(
                  this.options.cwd,
                  [profile],
                  run.agent,
                  run.task,
                  {
                    runId: run.id,
                    parentSessionId: run.id,
                    cwd: this.options.cwd,
                    signal,
                    childSessionFactory: factory,
                    modelOverride: this.options.model,
                    modelOverrideFromParent: true,
                    thinkingOverride: this.options.thinking,
                    context: "fresh",
                    artifactConfig: {
                      enabled: false,
                      includeInput: false,
                      includeOutput: false,
                      includeJsonl: false,
                      includeMetadata: false,
                      cleanupDays: 0,
                    },
                    acceptance: {
                      level: "none",
                      reason: "Panel parent reviews the returned child result.",
                    },
                    timeoutMs: 30 * 60 * 1000,
                    maxSubagentDepth: 0,
                  },
                );
                run.status = signal.aborted
                  ? "cancelled"
                  : result.exitCode === 0
                    ? "completed"
                    : "failed";
                run.response = (result.finalOutput || run.response).slice(
                  -200000,
                );
                run.error = result.error;
              } catch (error) {
                run.status = signal.aborted ? "cancelled" : "failed";
                run.error =
                  error instanceof Error ? error.message : String(error);
              } finally {
                if (run.thinking) run.thinking.active = false;
                run.finishedAt = Date.now();
                this.publish(run);
                progress();
              }
            }
          };
          const completion = Promise.all(
            Array.from({ length: Math.min(3, runs.length) }, worker),
          ).then(() => {});
          this.active.add(completion);
          try {
            await completion;
          } finally {
            this.active.delete(completion);
          }
          signal.throwIfAborted();
          return {
            content: [
              {
                type: "text",
                text: runs
                  .map(
                    (run) =>
                      `子代理 ${run.agent} (${run.id})\n任务：${run.task}\n状态：${run.status}\n${run.error ? `错误：${run.error}\n` : ""}${run.response.slice(-30000) || "未产生回答"}`,
                  )
                  .join("\n\n---\n\n"),
              },
            ],
            details: { ids: runs.map((run) => run.id) },
          };
        },
      },
    ];
  }

  usage() {
    return this.records.reduce(
      (sum, run) => ({
        input: sum.input + (run.usage?.input ?? 0),
        output: sum.output + (run.usage?.output ?? 0),
        total: sum.total + (run.usage?.total ?? 0),
        cost: sum.cost + (run.usage?.cost ?? 0),
      }),
      { input: 0, output: 0, total: 0, cost: 0 },
    );
  }

  async close() {
    this.controller.abort();
    await Promise.allSettled(this.active);
  }
}
