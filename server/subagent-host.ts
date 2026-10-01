import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  mkdtemp,
  rm,
  readdir,
  symlink,
  rename,
  realpath,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  delimiter,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  createModels,
  Message,
  Context,
  ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { RunEnvironment } from "./runtime.ts";
import type { SubagentRun, ToolCall } from "../shared/types.ts";
import type { HostBridgeConfig } from "./subagent-host-factory.ts";
import {
  serveSubagentBridge,
  type BridgeHandler,
} from "./subagent-host-rpc.ts";
import excluded from "./subagent-exclusions.json" with { type: "json" };
import { createWebTools, type WebToolOptions } from "./web-tools.ts";
import type { SubagentSettings } from "../shared/subagent-settings.ts";
import { generationError, outputTokenBudget } from "./generation-policy.ts";
import { recoverySource } from "../shared/subagent-runs.ts";
import {
  createRunCodingTools,
  startSandboxPreflight,
} from "./run-coding-tools.ts";
import { createShellEnvironment } from "./shell-environment.ts";
import { isCodingExecutionStartedNotice } from "./coding-tools.ts";
import {
  SANDBOX_POLICY_VERSION,
  SANDBOX_TOOL_NAMES,
} from "./sandbox-policy.ts";

export interface NativeHostOptions {
  directory: string;
  owner: string;
  cwd: string;
  model: string;
  thinking: string;
  concurrency: number;
  registry: ReturnType<typeof createModels>;
  environment: RunEnvironment;
  records?: SubagentRun[];
  webOptions?: WebToolOptions;
  nativeOptions?: SubagentSettings["nativeOptions"];
}
type Result = Awaited<ReturnType<AgentTool["execute"]>>;
type Pending = {
  resolve(value: Result): void;
  reject(error: Error): void;
  update?: (result: Result) => void;
};
const textResult = (value: unknown): Result => ({
  content: [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value),
    },
  ],
  details: {},
});
const terminal = (run: SubagentRun) =>
  !["queued", "running"].includes(run.status);

/** A durable native extension host per card revision; never owned by one model turn. */
export class NativeSubagentHost {
  readonly records = new Map<string, SubagentRun>();
  private process?: ChildProcess;
  private bridge?: Awaited<ReturnType<typeof serveSubagentBridge>>;
  private temporary?: string;
  private ready?: Promise<AgentTool[]>;
  private readonly pending = new Map<string, Pending>();
  private readonly effects = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private readonly approved = new Map<string, ToolCall>();
  private readonly executing = new Map<string, ToolCall>();
  private readonly web = new Map<string, ReturnType<typeof createWebTools>>();
  private readonly lifetime = new AbortController();
  private readonly children = new Map<string, AbortController>();
  private readonly questions = new Map<
    string,
    { kind: string; value: unknown; resolve(value: unknown): void }
  >();
  private history: Message[] = [];
  private closing = false;
  private closePromise?: Promise<void>;
  private stderr = "";
  private parentNotice?: (value: unknown) => void;
  private reportedUsage = { input: 0, output: 0, total: 0, cost: 0 };

  constructor(readonly options: NativeHostOptions) {
    for (const run of options.records ?? [])
      this.records.set(run.id, structuredClone(run));
    this.reportedUsage = this.usage();
  }
  setHistory(history: Message[]) {
    this.history = structuredClone(history);
  }
  setParentNotice(callback?: (value: unknown) => void) {
    this.parentNotice = callback;
  }
  answer(id: string, answer: unknown) {
    const question = this.questions.get(id);
    if (!question) throw new Error("这个子代理问题已失效。");
    if (
      question.kind === "confirm"
        ? typeof answer !== "boolean"
        : answer !== null && typeof answer !== "string"
    )
      throw new Error("回复格式无效。");
    if (
      question.kind === "select" &&
      answer !== null &&
      !(question.value as string[]).includes(answer as string)
    )
      throw new Error("请选择有效选项。");
    question.resolve(answer);
  }
  private publish(run: SubagentRun) {
    this.records.set(run.id, run);
    this.options.environment.onSubagentUpdate?.(structuredClone(run));
  }
  private child(id: string) {
    const run = this.records.get(id);
    if (!run) throw new Error("未知的子代理身份。");
    return run;
  }
  live() {
    return (
      !this.closing &&
      (this.pending.size > 0 ||
        [...this.records.values()].some((run) => !terminal(run)))
    );
  }
  usage() {
    return [...this.records.values()].reduce(
      (sum, run) => ({
        input: sum.input + (run.usage?.input ?? 0),
        output: sum.output + (run.usage?.output ?? 0),
        total: sum.total + (run.usage?.total ?? 0),
        cost: sum.cost + (run.usage?.cost ?? 0),
      }),
      { input: 0, output: 0, total: 0, cost: 0 },
    );
  }
  /** A durable host can outlive several parent turns; bill each child token once. */
  takeUsage() {
    const total = this.usage();
    const delta = {
      input: total.input - this.reportedUsage.input,
      output: total.output - this.reportedUsage.output,
      total: total.total - this.reportedUsage.total,
      cost: total.cost - this.reportedUsage.cost,
    };
    this.reportedUsage = total;
    return delta;
  }
  async tools(): Promise<AgentTool[]> {
    return (this.ready ??= this.start());
  }
  private async start(): Promise<AgentTool[]> {
    const directory = join(
      this.options.directory,
      "subagents",
      createHash("sha256")
        .update(this.options.owner)
        .digest("hex")
        .slice(0, 32),
    );
    const agentDir = join(this.options.directory, "subagents", "agent");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(join(agentDir, "extensions", "subagent"), {
      recursive: true,
      mode: 0o700,
    });
    // Keep plugin configuration and role management in Panel's own data directory.
    const configPath = join(agentDir, "extensions", "subagent", "config.json");
    let pluginConfig: Record<string, unknown> = {};
    try {
      pluginConfig = JSON.parse(await readFile(configPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const originalAgentDir =
      process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const link = async (source: string, target: string) => {
      try {
        await symlink(source, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    };
    // Retain global skills, context, and ambient MCP/extension providers for
    // detached children. Their role and native inheritance settings still decide
    // which resources are loaded; Panel keeps its own writable role settings.
    for (const name of [
      "skills",
      "AGENTS.md",
      "SYSTEM.md",
      "APPEND_SYSTEM.md",
      "mcp.json",
    ])
      await link(join(originalAgentDir, name), join(agentDir, name));
    try {
      for (const name of await readdir(join(originalAgentDir, "extensions")))
        if (name !== "subagent")
          await link(
            join(originalAgentDir, "extensions", name),
            join(agentDir, "extensions", name),
          );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const settingsPath = join(agentDir, "settings.json");
    let settings: Record<string, any> = {};
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        settings = JSON.parse(
          await readFile(join(originalAgentDir, "settings.json"), "utf8"),
        );
      } catch {
        /* New installation. */
      }
    }
    settings.subagents = {
      ...settings.subagents,
      agentOverrides: {
        ...settings.subagents?.agentOverrides,
        ...Object.fromEntries(
          excluded.map((name) => [name, { disabled: true }]),
        ),
      },
    };
    // Credentials and model endpoints are supplied by the bridge, never copied to disk.
    const temporarySettings = `${settingsPath}.${randomUUID()}.tmp`;
    await writeFile(temporarySettings, JSON.stringify(settings), {
      mode: 0o600,
    });
    await rename(temporarySettings, settingsPath);
    // Runtime policy and schedules belong to one card revision. Shared role
    // files remain visible across cards, without racing configuration snapshots.
    const hostAgentDir = join(directory, "agent");
    await mkdir(join(agentDir, "agents"), { recursive: true, mode: 0o700 });
    await mkdir(join(hostAgentDir, "extensions", "subagent"), {
      recursive: true,
      mode: 0o700,
    });
    for (const name of [
      "agents",
      "skills",
      "settings.json",
      "AGENTS.md",
      "SYSTEM.md",
      "APPEND_SYSTEM.md",
      "mcp.json",
    ])
      await link(join(agentDir, name), join(hostAgentDir, name));
    for (const name of await readdir(join(agentDir, "extensions")))
      if (name !== "subagent")
        await link(
          join(agentDir, "extensions", name),
          join(hostAgentDir, "extensions", name),
        );
    const hostPluginConfig = join(
      hostAgentDir,
      "extensions",
      "subagent",
      "config.json",
    );
    let savedConfig: Record<string, unknown> = {};
    try {
      savedConfig = JSON.parse(await readFile(hostPluginConfig, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporaryPluginConfig = `${hostPluginConfig}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryPluginConfig,
      JSON.stringify({
        asyncByDefault: false,
        maxSubagentDepth: 3,
        maxSubagentSpawnsPerRun: 64,
        ...pluginConfig,
        ...savedConfig,
        ...this.options.nativeOptions,
        // Native output instructions and persisted recovery contracts use the
        // project's artifact directory, inside the tools' writable workspace.
        artifactDir: "project",
        globalConcurrencyLimit: this.options.concurrency,
        scheduledRuns: {
          ...((pluginConfig.scheduledRuns as object) ?? {}),
          ...((savedConfig.scheduledRuns as object) ?? {}),
          storeRoot: join(directory, "schedules"),
        },
      }),
      { mode: 0o600 },
    );
    await rename(temporaryPluginConfig, hostPluginConfig);
    this.temporary = await mkdtemp(join(tmpdir(), "panel-agents-"));
    this.bridge = await serveSubagentBridge(
      join(this.temporary, "bridge.sock"),
      this.handle,
    );
    const config: HostBridgeConfig = {
      address: this.bridge.address,
      directory,
      agentDir: hostAgentDir,
      cwd: this.options.cwd,
      model: this.options.model,
      thinking: this.options.thinking,
    };
    const hostConfig = join(directory, "host.json");
    await writeFile(hostConfig, JSON.stringify(config), { mode: 0o600 });
    const workerPath = fileURLToPath(
      new URL(
        import.meta.url.endsWith(".mjs")
          ? "./subagent-host-worker.mjs"
          : "./subagent-host-worker.ts",
        import.meta.url,
      ),
    );
    const child = (this.process = fork(workerPath, [], {
      cwd: this.options.cwd,
      execArgv: workerPath.endsWith(".ts")
        ? ["--import", import.meta.resolve("tsx")]
        : [],
      env: {
        ...createShellEnvironment(),
        ...(workerPath.endsWith(".ts")
          ? {
              TSX_TSCONFIG_PATH: fileURLToPath(
                new URL("../tsconfig.json", import.meta.url),
              ),
              NODE_OPTIONS: `--import=${JSON.stringify(import.meta.resolve("tsx"))} --import=${JSON.stringify(new URL("./subagent-source-loader.mjs", import.meta.url).href)}`,
            }
          : {}),
        PANEL_SUBAGENT_HOST_CONFIG: hostConfig,
        PI_CODING_AGENT_DIR: hostAgentDir,
        PI_SUBAGENT_EXTRA_AGENT_DIRS: [
          join(originalAgentDir, "agents"),
          process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS,
        ]
          .filter(Boolean)
          .join(delimiter),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "json",
    }));
    child.stderr?.on("data", (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-12000);
    });
    const tools = await new Promise<AgentTool[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`子代理宿主启动超时。${this.stderr}`));
        child.kill();
      }, 30000);
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        const error = new Error(`子代理宿主已退出 (${code})。${this.stderr}`);
        reject(error);
        for (const item of this.pending.values()) item.reject(error);
        this.pending.clear();
        for (const item of this.effects.values()) item.reject(error);
        for (const run of this.records.values())
          if (!terminal(run)) {
            run.status = "failed";
            run.stopReason = "error";
            run.error = "宿主已停止，可从会话恢复。";
            run.finishedAt = Date.now();
            this.publish(run);
          }
      });
      child.on("message", (raw) => {
        const message = raw as {
          ready?: boolean;
          tools?: AgentTool[];
          id?: string;
          result?: Result;
          update?: Result;
          error?: string;
        };
        if (message.ready) {
          clearTimeout(timer);
          resolve(message.tools ?? []);
          return;
        }
        const pending = message.id && this.pending.get(message.id);
        if (!pending) return;
        if (message.update) {
          this.captureOutcomes(message.update);
          pending.update?.(message.update);
        } else {
          this.pending.delete(message.id!);
          if (message.error) pending.reject(new Error(message.error));
          else pending.resolve(message.result!);
        }
      });
    });
    return [
      {
        name: "subagents_enable",
        label: "开启 Subagents",
        parameters: Type.Object({}),
        description: "开启原生子代理协作并查看角色。",
        execute: async () => {
          this.options.environment.onSubagentsEnabled?.();
          return this.execute("subagent", {
            action: "list",
            capabilities: true,
          });
        },
      },
      ...tools.map(
        (tool): AgentTool => ({
          ...tool,
          label: tool.name,
          parameters:
            tool.name === "subagent"
              ? {
                  ...tool.parameters,
                  properties: {
                    ...(
                      tool.parameters as {
                        properties?: Record<string, unknown>;
                      }
                    ).properties,
                    tasks: Type.Optional(
                      Type.Array(
                        Type.Object({
                          agent: Type.String(),
                          task: Type.String(),
                        }),
                        { minItems: 1, maxItems: 8 },
                      ),
                    ),
                  },
                }
              : tool.parameters,
          execute: (id, args, signal, onUpdate) =>
            this.execute(
              tool.name,
              args as Record<string, unknown>,
              signal,
              onUpdate,
              id,
            ),
        }),
      ),
    ];
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    update?: (result: Result) => void,
    id: string = randomUUID(),
  ): Promise<Result> {
    await this.tools();
    this.lifetime.signal.throwIfAborted();
    signal?.throwIfAborted();
    const args = structuredClone(input);
    if (name === "subagent") {
      if (excluded.includes(String(args.agent)))
        throw new Error("此子代理角色已卸载。");
      if (args.action === "run") delete args.action;
      if (args.action === "resume" && args.output === undefined) {
        const output = this.resumeOutput(
          String(args.id),
          typeof args.index === "number" ? args.index : undefined,
        );
        if (output) args.output = output;
      }
      if (Array.isArray(args.tasks)) {
        if (args.agent || args.task || args.workflowScript || args.workflow)
          throw new Error("tasks 不能与其他执行方式同时提供。");
        if (!args.tasks.length || args.tasks.length > 8)
          throw new Error("每批需要 1–8 个子任务。");
        for (const task of args.tasks)
          if (excluded.includes(task.agent))
            throw new Error("此子代理角色已卸载。");
        args.workflowScript = `return await runs.all(${JSON.stringify(args.tasks.map((task, index) => ({ key: `task-${index}`, ...task })))})`;
        delete args.tasks;
        args.async ??= false;
      }
      if (!args.action && (args.workflowScript || args.workflowScriptPath))
        args.globalConcurrencyLimit = Math.min(
          Number(args.globalConcurrencyLimit) || this.options.concurrency,
          this.options.concurrency,
        );
    }
    this.options.environment.onSubagentsEnabled?.();
    const controlledRuns = new Set(
      ["stop", "interrupt"].includes(String(args.action))
        ? [...this.records.values()]
            .filter(
              (run) =>
                !terminal(run) &&
                run.nativeRunId === args.id &&
                (args.index === undefined || run.childIndex === args.index),
            )
            .map((run) => run.id)
        : [],
    );
    return new Promise<Result>((resolve, reject) => {
      const abort = () => this.process?.send({ id, cancel: true });
      signal?.addEventListener("abort", abort, { once: true });
      const finish = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, {
        resolve: (result) => {
          finish();
          this.captureOutcomes(result);
          if (
            !result.isError &&
            ["stop", "interrupt"].includes(String(args.action))
          )
            for (const run of this.records.values())
              if (controlledRuns.has(run.id)) {
                run.stopReason =
                  args.action === "stop" ? "user" : "interrupted";
                if (run.status === "failed" || run.status === "cancelled")
                  run.status = "cancelled";
                this.publish(run);
              }
          if (String(args.action).startsWith("schedule.") && !result.isError)
            this.options.environment.onSubagentNotice?.({
              kind: "schedule-owner",
              value: true,
              createdAt: Date.now(),
            });
          resolve(result);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
        update,
      });
      this.process!.send({ id, name, args, history: this.history }, (error) => {
        if (error) {
          this.pending.delete(id);
          finish();
          reject(error);
        }
      });
    });
  }

  private resumeOutput(id: string, index?: number) {
    const target = [...this.records.values()].findLast(
      (run) =>
        run.nativeRunId === id &&
        (index === undefined || run.childIndex === index),
    );
    const output =
      target?.outputPath ??
      [
        ...(target?.task ?? "").matchAll(
          /(?:Write your findings to exactly this path:|The runtime will persist it to exactly this path:)\s*([^\n]+)/g,
        ),
      ]
        .at(-1)?.[1]
        ?.trim();
    if (!output || !target?.workingDirectory) return undefined;
    const addressed = resolve(target.workingDirectory, output);
    const rel = relative(target.workingDirectory, addressed);
    return !rel.startsWith("..") && !isAbsolute(rel)
      ? addressed
      : /[/\\]subagent-artifacts[/\\]/.test(addressed)
        ? join(
            target.workingDirectory,
            ".pi",
            "subagents",
            "artifacts",
            "outputs",
            target.nativeRunId!,
            basename(addressed),
          )
        : output;
  }

  private captureOutcomes(result: Result) {
    const details = result.details as {
      runId?: string;
      results?: {
        index?: number;
        sessionFile?: string;
        artifactPaths?: { metadataPath?: string };
        error?: string;
        timedOut?: boolean;
        stopped?: boolean;
        interrupted?: boolean;
      }[];
    };
    for (const outcome of details?.results ?? []) {
      const run = [...this.records.values()].findLast((item) =>
        outcome.sessionFile
          ? item.sessionFile === outcome.sessionFile
          : !!item.nativeRunId &&
            ((item.nativeRunId === details.runId &&
              item.childIndex === (outcome.index ?? 0)) ||
              basename(outcome.artifactPaths?.metadataPath ?? "").startsWith(
                `${item.nativeRunId}_`,
              )),
      );
      if (!run) continue;
      if (
        outcome.timedOut ||
        /exceeded its timeout|timed[ -]?out/i.test(outcome.error ?? "")
      ) {
        run.status = "failed";
        run.stopReason = "timeout";
        run.error = outcome.error ?? "子代理执行超时。";
        for (const call of this.executing.values())
          if (call.subagentId === run.id)
            this.options.environment.onToolUpdate(call.id, {
              status: "failed",
              stopReason: "timeout",
              error: `执行超时：${run.error}`,
            });
      } else if (outcome.stopped || outcome.interrupted) {
        run.status = "cancelled";
        run.stopReason = outcome.stopped ? "user" : "interrupted";
      } else if (outcome.error && terminal(run)) {
        run.status = "failed";
        run.stopReason = "error";
        run.error = outcome.error;
      } else continue;
      this.publish(run);
    }
  }

  private handle: BridgeHandler = async (method, raw, requestSignal, emit) => {
    const params = raw as any;
    const signal = AbortSignal.any([requestSignal, this.lifetime.signal]);
    if (method === "bootstrap")
      return { models: this.options.registry.getModels() };
    if (method === "run.output")
      return this.resumeOutput(params.runId, params.index);
    if (method === "host.ui") {
      this.options.environment.onSubagentNotice?.({
        kind: "ui-request",
        value: params,
        createdAt: Date.now(),
      });
      return new Promise((resolve) => {
        const finish = (value: unknown) => {
          this.questions.delete(params.id);
          signal.removeEventListener("abort", abort);
          this.options.environment.onSubagentNotice?.({
            kind: "ui-response",
            value: { id: params.id },
            createdAt: Date.now(),
          });
          resolve(value);
        };
        const abort = () => finish(params.kind === "confirm" ? false : null);
        this.questions.set(params.id, {
          kind: params.kind,
          value: params.value,
          resolve: finish,
        });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    if (method === "child.create") {
      if (excluded.includes(params.agent))
        throw new Error("此子代理角色已卸载。");
      const run: SubagentRun = {
        id: params.id,
        profile: params.profile,
        agent: params.agent ?? "worker",
        task: "子代理任务正在准备",
        model: params.model ?? this.options.model,
        status: "running",
        response: "",
        createdAt: Date.now(),
        startedAt: Date.now(),
        nativeRunId: params.runId,
        childIndex: params.index,
        parentRunId: params.parentRunId,
        depth: params.depth ?? 0,
        workingDirectory: await realpath(params.cwd),
        sessionFile: params.sessionFile,
        tools: params.tools,
      };
      const placeholder = this.records.get(`native:${params.runId}`);
      if (placeholder && placeholder.agent !== "workflow") {
        run.background = placeholder.background;
        run.asyncDirectory = placeholder.asyncDirectory;
        this.records.delete(placeholder.id);
      }
      this.children.set(run.id, new AbortController());
      startSandboxPreflight(
        run.workingDirectory!,
        this.options.environment,
        run.id,
        AbortSignal.any([
          this.lifetime.signal,
          this.children.get(run.id)!.signal,
        ]),
      );
      this.publish(run);
      this.web.set(run.id, createWebTools(this.options.webOptions));
      return { models: this.options.registry.getModels() };
    }
    if (method === "model.stream") {
      const model = this.options.registry.getModel(
        params.provider,
        params.model,
      );
      if (!model) throw new Error("子代理选择的模型不可用。");
      const activeSignal = params.childId
        ? AbortSignal.any([
            signal,
            this.children.get(params.childId)?.signal ?? signal,
          ])
        : signal;
      // The worker authenticates to a dummy provider. Resolve real credentials
      // only through Panel's registry; never forward dummy auth or environment.
      const {
        apiKey: _apiKey,
        env: _env,
        headers: _headers,
        baseUrl: _baseUrl,
        ...requestOptions
      } = params.options ?? {};
      const events = this.options.registry.streamSimple(
        {
          ...model,
          maxTokens: requestOptions.maxTokens ?? outputTokenBudget(model),
        },
        params.context as Context,
        {
          ...requestOptions,
          signal: activeSignal,
        } as ModelsSimpleStreamOptions,
      );
      for await (const event of events) emit(event);
      return null;
    }
    if (method === "tool.before" || method === "tool.execute") {
      const run = this.child(params.childId);
      if (
        (await realpath(params.cwd)) !== run.workingDirectory ||
        terminal(run)
      )
        throw new Error("子代理执行目录或状态已改变。");
      const call = {
        ...params.call,
        subagentId: run.id,
        workingDirectory: run.workingDirectory,
      } as ToolCall;
      if (
        call.sandbox &&
        (call.sandbox.policyVersion !== SANDBOX_POLICY_VERSION ||
          call.sandbox.workingDirectory !== run.workingDirectory ||
          !SANDBOX_TOOL_NAMES.has(call.name))
      )
        throw new Error("子代理沙盒策略不匹配。");
      const activeSignal = AbortSignal.any([
        signal,
        this.children.get(run.id)?.signal ?? signal,
      ]);
      if (method === "tool.before") {
        const allowed = await this.options.environment.beforeToolCall(
          call,
          undefined,
          activeSignal,
        );
        if (allowed) this.approved.set(call.id, structuredClone(call));
        return allowed;
      }
      const approved = this.approved.get(call.id);
      if (!approved || JSON.stringify(approved) !== JSON.stringify(call))
        throw new Error("子代理工具未获得匹配的授权。");
      this.approved.delete(call.id);
      return this.options.environment.executeTool(
        call,
        () =>
          new Promise((resolve, reject) => {
            // Wait for the actual operation to settle before releasing file locks or
            // taking its final snapshot, even when the streaming request was aborted.
            this.executing.set(call.id, call);
            const finish = () => {
              this.effects.delete(call.id);
              this.executing.delete(call.id);
            };
            this.effects.set(call.id, {
              resolve: (value) => {
                finish();
                resolve(value);
              },
              reject: (error) => {
                finish();
                reject(error);
              },
            });
            emit({ type: "grant" });
          }),
        activeSignal,
      );
    }
    if (method === "coding.execute") {
      const call = this.executing.get(params.callId);
      if (
        !call?.sandbox ||
        call.subagentId !== params.childId ||
        call.name !== params.name ||
        JSON.stringify(call.arguments) !== JSON.stringify(params.args) ||
        !call.workingDirectory
      )
        throw new Error("编码工具没有匹配的沙盒执行授权。");
      const tool = createRunCodingTools(
        call.workingDirectory,
        this.options.environment,
        call.subagentId,
        signal,
      ).find((tool) => tool.name === call.name);
      if (!tool) throw new Error("编码工具不可用。");
      return tool.execute(call.id, call.arguments, signal, (update) => {
        emit(
          isCodingExecutionStartedNotice(update)
            ? { type: "coding_execution_started" }
            : update,
        );
      });
    }
    if (method === "web.execute") {
      const call = this.executing.get(params.callId);
      if (
        !call ||
        call.subagentId !== params.childId ||
        call.name !== params.name ||
        JSON.stringify(call.arguments) !== JSON.stringify(params.args)
      )
        throw new Error("联网工具没有有效的执行授权。");
      const tool = this.web
        .get(params.childId)
        ?.find((item) => item.name === params.name);
      if (!tool) throw new Error("子代理联网会话不存在。");
      return tool.execute(params.callId, params.args, signal, (update) =>
        emit(update),
      );
    }
    if (method === "tool.result") {
      const effect = this.effects.get(params.callId);
      if (!effect) throw new Error("工具执行授权已结束。");
      if (params.error) effect.reject(new Error(params.error));
      else effect.resolve(params.result);
      return null;
    }
    if (method === "tool.update") {
      this.child(params.id);
      this.options.environment.onToolUpdate(
        params.value.callId,
        params.value.update,
      );
      return null;
    }
    if (method.startsWith("child.")) {
      const run = this.child(params.id),
        value = params.value;
      if (method === "child.opened") {
        run.sessionFile = value.sessionFile;
        run.model = value.model ?? run.model;
      }
      if (method === "child.prompt") {
        run.task = value;
        run.outputPath = [
          ...value.matchAll(
            /(?:Write your findings to exactly this path:|The runtime will persist it to exactly this path:)\s*([^\n]+)/g,
          ),
        ]
          .at(-1)?.[1]
          ?.trim();
        const source = recoverySource(run, [...this.records.values()]);
        if (source) run.resumedFrom = source.id;
        run.status = "running";
      }
      if (method === "child.closed") {
        run.error =
          run.stopReason === "timeout"
            ? run.error
            : (value?.error ?? run.error);
        run.status =
          run.stopReason === "user" || run.stopReason === "interrupted"
            ? "cancelled"
            : run.error || value?.aborted
              ? "failed"
              : "completed";
        if (run.status === "failed")
          run.stopReason = /exceeded its timeout|timed[ -]?out/i.test(
            run.error ?? "",
          )
            ? "timeout"
            : "error";
        run.finishedAt = Date.now();
        this.children.delete(run.id);
        if (run.thinking) run.thinking.active = false;
        await this.web.get(run.id)?.close();
        this.web.delete(run.id);
      }
      if (method === "child.event") {
        const event = value,
          message = event.message;
        if (event.type === "message_update") {
          const delta = event.assistantMessageEvent;
          if (delta?.type === "text_delta") run.response += delta.delta;
          if (delta?.type === "thinking_delta")
            run.thinking = {
              text: (run.thinking?.text ?? "") + delta.delta,
              active: true,
            };
        }
        if (event.type === "message_end" && message?.role === "assistant") {
          // Pi retains failed attempts in its transcript and can recover before
          // disposing the session. Only the latest assistant outcome is current.
          run.error = message.errorMessage
            ? generationError(message.errorMessage)
            : message.stopReason === "error"
              ? "模型没有返回有效回答。"
              : undefined;
          if (message.usage) {
            const usage = message.usage;
            const old = run.usage ?? { input: 0, output: 0, total: 0, cost: 0 };
            run.usage = {
              input:
                old.input + usage.input + usage.cacheRead + usage.cacheWrite,
              output: old.output + usage.output,
              total: old.total + usage.totalTokens,
              cost: (old.cost ?? 0) + usage.cost.total,
            };
          }
        }
      }
      this.publish(run);
      return null;
    }
    if (method === "host.event") {
      const value = params.value;
      if (params.kind === "detached")
        for (const run of this.records.values()) {
          if (
            run.nativeRunId === value.runId &&
            (value.index === undefined || run.childIndex === value.index)
          ) {
            run.background = true;
            this.publish(run);
          }
        }
      if (params.kind === "message" || params.kind === "user-message")
        this.parentNotice?.(value);
      if (params.kind === "subagent:async-started" && value.id) {
        const run: SubagentRun = {
          id: `native:${value.id}`,
          nativeRunId: value.id,
          agent: value.agent ?? "workflow",
          task: value.goal ?? value.task ?? "后台工作流",
          model: this.options.model,
          status: "running",
          background: true,
          response: "",
          createdAt: Date.now(),
          workingDirectory: value.cwd,
          asyncDirectory: value.asyncDir,
        };
        const child = [...this.records.values()].find(
          (item) => item.nativeRunId === value.id,
        );
        if (child) {
          child.background = true;
          child.asyncDirectory = value.asyncDir;
          this.publish(child);
        } else this.publish(run);
      }
      if (params.kind === "subagent:async-complete") {
        const run =
          this.records.get(`native:${value.runId ?? value.id}`) ??
          [...this.records.values()].find(
            (item) => item.nativeRunId === (value.runId ?? value.id),
          );
        if (run) {
          run.status =
            value.success === false
              ? "failed"
              : value.state === "paused" || value.state === "stopped"
                ? "cancelled"
                : "completed";
          // Completion notices are abbreviated; do not replace a streamed
          // child's full report with the notification preview.
          run.response = run.response || value.output || value.summary || "";
          run.error = value.error;
          if (/exceeded its timeout|timed[ -]?out/i.test(run.error ?? "")) {
            run.stopReason = "timeout";
            run.status = "failed";
          } else if (value.state === "stopped") run.stopReason = "user";
          else if (value.state === "paused") run.stopReason = "interrupted";
          run.finishedAt = Date.now();
          this.publish(run);
        }
      }
      this.options.environment.onSubagentNotice?.({
        kind: params.kind,
        value,
        createdAt: Date.now(),
      });
      return null;
    }
    throw new Error(`未知子代理宿主方法 ${method}`);
  };

  close() {
    return (this.closePromise ??= this.closeHost());
  }
  private async closeHost() {
    if (this.closing) return;
    this.closing = true;
    if (this.ready) {
      try {
        await this.ready;
        // Stop owned background roots before shutting down their model/tool gateway.
        for (const run of this.records.values())
          if (run.background && !terminal(run) && run.nativeRunId)
            await this.execute("subagent", {
              action: "interrupt",
              id: run.nativeRunId,
            }).catch(() => {});
      } catch {
        /* Startup failure still closes its resources. */
      }
    }
    this.lifetime.abort();
    if (this.process && this.process.exitCode === null) {
      const child = this.process;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        if (child.connected) child.send({ close: true });
        else child.kill();
      });
    }
    await this.bridge?.close();
    await Promise.allSettled([...this.web.values()].map((web) => web.close()));
    this.web.clear();
    if (this.temporary)
      await rm(this.temporary, { recursive: true, force: true });
  }
}
