import { randomUUID } from "node:crypto";
import { resolveFileOperationResource } from "./file-operation-locks.ts";
import { dirname, join } from "node:path";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { SubagentRun, ThinkingContent } from "../shared/types.ts";
import type {
  ChildSession,
  ChildSessionLaunch,
  ChildSessionFactory,
} from "./nicobailon-engine.ts";
import { loadNicobailon } from "./nicobailon-loader.ts";
import { SUBAGENT_DELIVERY_PROMPT } from "./subagent-handoff.ts";
import {
  discoverSubagentProfiles,
  presentProfile,
  profileDiagnostics,
} from "./subagent-profiles.ts";
import {
  DEFAULT_SUBAGENT_CONCURRENCY,
  MAX_SUBAGENT_BATCH_SIZE,
  validSubagentConcurrency,
} from "../shared/subagent-settings.ts";

export const SUBAGENT_PROMPT = `
Panel 允许你根据当前用户任务自主调用 subagent 分配独立子任务。先用 action=list,capabilities=true 读取原生角色；执行时省略 action。agent/task 委派一个子代理；workflowScript 使用 runs.run/runs.all 串联或并行；tasks 是保留的批量简写。async:true 后台运行，async:false 等待结果。需要父上下文时显式 context:fork；独立审查通常用 fresh。可通过 status、steer（mode:steer/follow_up）、interrupt、stop、resume 管理精确 run id；需要时用 action:guide 阅读原生参数。隔离并发写入用 worktree:true。后台完成与监督者消息显示在右侧 Subagents；主任务已结束后可在右侧控制或恢复，不要声称后台结果已经完成。子代理工具遵守角色配置并通过 Panel 审批。外部 CLI 与远端调用按整个委派审批，由各自运行环境执行工具。用户选择 @subagents 时本轮必须开启并按任务调用；历史选择不要求重复委派。\n${SUBAGENT_DELIVERY_PROMPT}`;

const taskSchema = Type.Object({
  agent: Type.String({
    minLength: 1,
    description: "插件角色名或别名；先用 action=list 查看可用角色。",
  }),
  task: Type.String({
    minLength: 1,
    maxLength: 20000,
    description: "完整子任务，包含必要背景、相关文件和期望输出。",
  }),
});

interface SubagentOptions {
  maxConcurrentSubagents?: number;
  cwd: string;
  model: string;
  availableModels?: {
    provider: string;
    id: string;
    fullId: string;
    contextWindow: number;
  }[];
  signal: AbortSignal;
  thinking: string;
  onEnabled?: () => void;
  onUpdate?: (run: SubagentRun) => void;
  persistOutput: (
    id: string,
    path: string,
    content: string,
    signal: AbortSignal,
  ) => Promise<void>;
  createChildSession: (
    id: string,
    launch: ChildSessionLaunch,
    skillPaths: string[],
  ) => Promise<ChildSession>;
}

/** One card owns the queue, cancellation and child identities. No global factory. */
export class Subagents {
  private readonly records: SubagentRun[] = [];
  private readonly active = new Set<Promise<void>>();
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly concurrency: number;

  constructor(private readonly options: SubagentOptions) {
    this.concurrency =
      options.maxConcurrentSubagents ?? DEFAULT_SUBAGENT_CONCURRENCY;
    if (!validSubagentConcurrency(this.concurrency))
      throw new Error("子代理并发设置无效。");
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
          const found = await discoverSubagentProfiles(
            this.options.cwd,
            this.options.model.split("/")[0],
          );
          this.signal.throwIfAborted();
          this.options.onEnabled?.();
          return {
            content: [
              {
                type: "text",
                text:
                  "Subagents 已开启。原生角色配置：\n" +
                  JSON.stringify({
                    profiles: found.agents.map((agent) =>
                      presentProfile(agent),
                    ),
                    diagnostics: found.agentDiagnostics,
                  }),
              },
            ],
            details: {},
          };
        },
      },
      {
        name: "subagent",
        label: "子代理协作",
        description: `使用 nicobailon/pi-subagents 原生角色和独立 Pi 会话。先用 action=list 发现内置、用户和项目角色。角色决定提示词、工具、模型和技能；未配置模型时继承当前模型。用 agent/task 或 tasks 委派，每批最多 ${MAX_SUBAGENT_BATCH_SIZE} 个，最多 ${this.concurrency} 个同时执行。调用等待所有结果；共享工作目录及 Panel 审批。`,
        parameters: Type.Object({
          action: Type.Optional(
            Type.Union([Type.Literal("list"), Type.Literal("run")]),
          ),
          agent: Type.Optional(taskSchema.properties.agent),
          task: Type.Optional(taskSchema.properties.task),
          tasks: Type.Optional(
            Type.Array(taskSchema, {
              minItems: 1,
              maxItems: MAX_SUBAGENT_BATCH_SIZE,
            }),
          ),
        }),
        execute: async (_id, rawInput, toolSignal, onUpdate) => {
          const input = rawInput as {
            action?: "list" | "run";
            agent?: SubagentRun["agent"];
            task?: string;
            tasks?: { agent: SubagentRun["agent"]; task: string }[];
          };
          const signal = toolSignal
            ? AbortSignal.any([this.signal, toolSignal])
            : this.signal;
          signal.throwIfAborted();
          const engine = await loadNicobailon();
          const found = await discoverSubagentProfiles(
            this.options.cwd,
            this.options.model.split("/")[0],
          );
          if (input.action === "list")
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    profiles: found.agents.map((agent) =>
                      presentProfile(agent),
                    ),
                    diagnostics: found.agentDiagnostics,
                  }),
                },
              ],
              details: {},
            };
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
          if (tasks.length > MAX_SUBAGENT_BATCH_SIZE)
            throw new Error(
              `每批最多启动 ${MAX_SUBAGENT_BATCH_SIZE} 个子代理。`,
            );
          if (this.records.length + tasks.length > 24)
            throw new Error("本轮最多启动 24 个子代理，请汇总已有结果。");
          const profiles = tasks.map(({ agent: name }) => {
            const { agent, error } = engine.resolveAgentName(
              name,
              found.agents,
            );
            const diagnostic = engine.findBlockingAgentDiagnostic(
              name,
              agent,
              found.agentDiagnostics,
            );
            if (diagnostic)
              throw new Error(
                `${name}: ${diagnostic.error} (${diagnostic.filePath})`,
              );
            if (!agent)
              throw new Error(
                error ?? `未知角色 ${name}，请先调用 action=list。`,
              );
            if (agent.disabled) throw new Error(`角色 ${name} 已禁用。`);
            return agent;
          });
          signal.throwIfAborted();
          this.options.onEnabled?.();
          const runs = tasks.map(
            ({ task }, index): SubagentRun => ({
              id: randomUUID(),
              agent: profiles[index].name,
              profile: presentProfile(profiles[index]),
              task,
              model: profiles[index].model ?? this.options.model,
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
              const index = next++;
              const run = runs[index];
              const profile = profiles[index];
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
              const factory: ChildSessionFactory = {
                create: async (launch) => {
                  run.model = launch.model ?? run.model;
                  run.tools = launch.tools;
                  this.publish(run);
                  const skills = engine.resolveSkillsWithFallback(
                    profile.skills ?? [],
                    this.options.cwd,
                    this.options.cwd,
                    profile.skillPath,
                    dirname(profile.filePath),
                  );
                  if (skills.missing.length)
                    throw new Error(
                      `Skills not found: ${skills.missing.join(", ")}`,
                    );
                  const session = await this.options.createChildSession(
                    run.id,
                    launch,
                    skills.resolved.map((skill) => skill.path),
                  );
                  session.subscribe((raw) => {
                    const event = raw as unknown as AgentEvent;
                    if (event.type === "message_update") {
                      const update = event.assistantMessageEvent;
                      if (update.type === "text_delta") {
                        run.response += update.delta;
                        this.publish(run);
                      } else if (update.type === "thinking_delta") {
                        run.thinking = {
                          text: (
                            (run.thinking?.text ?? "") + update.delta
                          ).slice(-100000),
                          active: true,
                        };
                        this.publish(run);
                      }
                    }
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
                        total: (previous?.total ?? 0) + usage.totalTokens,
                        ...(/^(paperbypass|atria|xiaomi-token-plan-cn)\//.test(
                          run.model,
                        )
                          ? {}
                          : { cost: (previous?.cost ?? 0) + usage.cost.total }),
                      };
                      this.publish(run);
                    }
                  });
                  return session;
                },
                dispose: async () => {},
              };
              try {
                const issues = profileDiagnostics(profile);
                if (issues.length) throw new Error(issues.join("\n"));
                const plan = engine.planChildLaunch({
                  agentConfig: profile,
                  stepOverrides: {},
                  task: run.task,
                  runnerCwd: this.options.cwd,
                  runtimeCwd: this.options.cwd,
                  outputBaseDir: join(
                    this.options.cwd,
                    ".pi",
                    "subagents",
                    run.id,
                  ),
                });
                if (plan.outputPath)
                  await resolveFileOperationResource(
                    this.options.cwd,
                    "write",
                    { path: plan.outputPath },
                  );
                const outputSnapshot = engine.captureSingleOutputSnapshot(
                  plan.outputPath,
                );
                const reads = Array.isArray(plan.behavior.reads)
                  ? engine.resolveExistingReadPaths(
                      plan.behavior.reads,
                      plan.stepCwd,
                    )
                  : [];
                const task = engine.injectSingleOutputInstruction(
                  (reads.length ? `[Read from: ${reads.join(", ")}]\n\n` : "") +
                    run.task,
                  plan.outputPath,
                  profile,
                );
                const structuredOutput = profile.outputSchema
                  ? engine.createStructuredOutputRuntime(profile.outputSchema)
                  : undefined;
                const toolBudget = engine.validateToolBudgetConfig(
                  profile.toolBudget,
                  "agent.toolBudget",
                );
                if (toolBudget.error) throw new Error(toolBudget.error);
                const result = await engine.runSync(
                  this.options.cwd,
                  found.agents,
                  run.agent,
                  task,
                  {
                    runId: run.id,
                    parentSessionId: run.id,
                    cwd: this.options.cwd,
                    signal,
                    childSessionFactory: factory,
                    availableModels: this.options.availableModels,
                    toolBudget: toolBudget.budget,
                    modelOverride: profile.model
                      ? undefined
                      : this.options.model,
                    modelOverrideFromParent: !profile.model,
                    thinkingOverride:
                      profile.thinking === undefined
                        ? this.options.thinking
                        : undefined,
                    thinkingCeiling: found.maxThinking,
                    modelScope: found.modelScope,
                    preferredModelProvider: this.options.model.split("/")[0],
                    // Upstream's automatic output fallback writes directly to
                    // disk. Persist through Panel's audited write boundary below.
                    outputMode: "inline",
                    structuredOutput,
                    skills: plan.skillNames,
                    context: "fresh",
                    artifactConfig: {
                      enabled: false,
                      includeInput: false,
                      includeOutput: false,
                      includeJsonl: false,
                      includeMetadata: false,
                      cleanupDays: 0,
                    },
                    acceptance: profile.defaultAcceptance,
                    timeoutMs: profile.defaultTimeoutMs ?? 30 * 60 * 1000,
                    maxSubagentDepth: 0,
                  },
                );
                run.response = result.finalOutput || run.response;
                if (
                  !signal.aborted &&
                  result.exitCode === 0 &&
                  plan.outputPath
                ) {
                  if (
                    !engine.hasSingleOutputChangedSinceSnapshot(
                      plan.outputPath,
                      outputSnapshot,
                    )
                  )
                    await this.options.persistOutput(
                      run.id,
                      plan.outputPath,
                      result.finalOutput ?? "",
                      signal,
                    );
                  if (plan.behavior.outputMode === "file-only")
                    result.finalOutput = `Output saved: ${plan.outputPath}`;
                }
                run.status = signal.aborted
                  ? "cancelled"
                  : result.exitCode === 0
                    ? "completed"
                    : "failed";
                run.response = result.finalOutput || run.response;
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
            Array.from(
              { length: Math.min(this.concurrency, runs.length) },
              worker,
            ),
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
                      `子代理 ${run.agent} (${run.id})\n任务：${run.task}\n状态：${run.status}\n${run.error ? `错误：${run.error}\n` : ""}${run.response || "未产生回答"}`,
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
