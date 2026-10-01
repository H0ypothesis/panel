import {
  codingSandboxScope,
  isCodingExecutionStartedNotice,
} from "./coding-tools.ts";
import { createRunCodingTools } from "./run-coding-tools.ts";
import { SANDBOX_POLICY_VERSION } from "./sandbox-policy.ts";
import { randomUUID } from "node:crypto";
import type { AgentTool, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { realpath, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ChildSessionLaunch,
  ParentProviderRegistry,
} from "./nicobailon-engine.ts";
import { loadNicobailon } from "./nicobailon-loader.ts";
import type { RunEnvironment } from "./runtime.ts";
import { isWebTool } from "./web-tools.ts";
import { WEB_RESEARCH_PROMPT } from "./native-web-contract.ts";
import { installGenerationPolicy } from "./generation-policy.ts";
import { SubagentExecutionEvents } from "./subagent-execution-events.ts";
import {
  createSubagentHandoff,
  SUBAGENT_DELIVERY_PROMPT,
  summarizeHandoff,
} from "./subagent-handoff.ts";

/** All native and extension tools cross the same approval/audit boundary. */
export async function createPanelChildSession(
  launch: ChildSessionLaunch,
  options: {
    id: string;
    skillPaths?: string[];
    providers: ParentProviderRegistry;
    tools: AgentTool[];
    environment: RunEnvironment;
    onDispose?: () => Promise<void>;
    resultSources?: (
      result: unknown,
    ) => import("../shared/types.ts").ToolCall["sources"];
    resolveResumeOutput?: (
      id: string,
      index?: number,
    ) => Promise<string | undefined>;
  },
) {
  const {
    piSdk: sdk,
    AuthStorage,
    createDefaultChildSessionFactory,
  } = await loadNicobailon();
  if (!options.environment.workingDirectory)
    throw new Error("使用原生子代理前，请先为当前探索设置工作目录。");
  if (launch.tools?.includes("powershell"))
    throw new Error(
      "Panel 尚未接入 powershell 的命令环境，请在角色中使用 bash。",
    );
  const root = await realpath(launch.cwd);
  const skillRoots = new Set(
    await Promise.all(
      (options.skillPaths ?? []).map((path) => realpath(dirname(path))),
    ),
  );
  const skillReader = sdk.createReadToolDefinition(root);
  const isWithin = (base: string, path: string) => {
    const rel = relative(base, path);
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  async function bounded(path: string) {
    const target = await realpath(resolve(root, path));
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("文件路径超出当前工作目录。");
    return target;
  }
  const navigation: ToolDefinition[] = [
    sdk.createGrepToolDefinition(root, {
      operations: {
        isDirectory: async (path) =>
          (await stat(await bounded(path))).isDirectory(),
        readFile: async (path) => readFile(await bounded(path), "utf8"),
      },
    }),
    sdk.createFindToolDefinition(root),
    sdk.createLsToolDefinition(root),
  ] as unknown as ToolDefinition[];
  const boundedNavigation = navigation.map(
    (tool): ToolDefinition => ({
      ...tool,
      async execute(id, args, ...rest) {
        const input = args as { path?: string };
        const path = await bounded(input.path ?? ".");
        return tool.execute(
          id,
          { ...(args as Record<string, unknown>), path },
          ...rest,
        );
      },
    }),
  );
  const wrapped = new WeakSet<object>();
  const executionEvents = new SubagentExecutionEvents();
  function guard(tool: ToolDefinition): ToolDefinition {
    if (wrapped.has(tool)) return tool;
    const result: ToolDefinition = {
      ...tool,
      async execute(id, args, signal, onUpdate, context) {
        const argumentsSnapshot = structuredClone(args) as Record<
          string,
          unknown
        >;
        if (
          tool.name === "subagent" &&
          argumentsSnapshot.action === "resume" &&
          argumentsSnapshot.output === undefined &&
          typeof argumentsSnapshot.id === "string"
        ) {
          const output = await options.resolveResumeOutput?.(
            argumentsSnapshot.id,
            typeof argumentsSnapshot.index === "number"
              ? argumentsSnapshot.index
              : undefined,
          );
          if (output) argumentsSnapshot.output = output;
        }
        let skillRead = false;
        if (
          tool.name === "read" &&
          typeof argumentsSnapshot.path === "string"
        ) {
          try {
            const target = await realpath(
              resolve(root, argumentsSnapshot.path),
            );
            skillRead =
              !isWithin(root, target) &&
              [...skillRoots].some((base) => isWithin(base, target));
            if (skillRead) argumentsSnapshot.path = target;
          } catch {
            /* Ordinary missing files still report through the tool. */
          }
        }
        // Configured skills may live outside the workspace. Give those reads a
        // distinct approval identity instead of relaxing workspace file bounds.
        const call = {
          id: `${options.id}:${id}`,
          name: skillRead ? "read_skill" : tool.name,
          arguments: argumentsSnapshot,
          sandbox: skillRead ? undefined : codingSandboxScope(tool, root),
        };
        // Preserve the exact authorized arguments even if an extension mutates
        // its original object while approval is pending.
        const authorized = structuredClone(call.arguments);
        if (
          !(await options.environment.beforeToolCall(
            structuredClone({ ...call, subagentId: options.id }),
            undefined,
            signal,
          ))
        )
          throw new Error(
            "用户拒绝了本次子代理工具调用，操作未执行。此拒绝只针对本次调用，子代理没有被停止；可以继续其他已授权的工作，并在结果中说明未完成项。不得通过改写命令、替换工具或委派给其他代理来绕过这次拒绝。",
          );
        try {
          const output = await options.environment.executeTool(
            call,
            async () => {
              signal?.throwIfAborted();
              // Genuine bash tools announce actual shell dispatch after setup
              // and recovery, so these waits do not start the native deadline.
              if (call.name !== "bash" || !call.sandbox)
                executionEvents.granted(id);
              if (skillRead) {
                const target = await realpath(String(authorized.path));
                if (
                  target !== authorized.path ||
                  ![...skillRoots].some((base) => isWithin(base, target))
                )
                  throw new Error(
                    "等待批准期间技能文件路径已变化，请重新读取。",
                  );
              }
              options.environment.onToolUpdate(call.id, { status: "running" });
              return (skillRead ? skillReader : tool).execute(
                id,
                authorized as never,
                signal,
                (partial) => {
                  if (isCodingExecutionStartedNotice(partial)) {
                    executionEvents.granted(id);
                    return;
                  }
                  onUpdate?.(partial);
                  options.environment.onToolUpdate(call.id, {
                    status: "running",
                    output: partial.content
                      .filter((item) => item.type === "text")
                      .map((item) => item.text)
                      .join("\n"),
                  });
                },
                context,
              );
            },
            signal,
          );
          options.environment.onToolUpdate(call.id, {
            status: "completed",
            sources: options.resultSources?.(output),
            output: output.content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n"),
          });
          return output;
        } catch (error) {
          options.environment.onToolUpdate(call.id, {
            status: signal?.aborted ? "cancelled" : "failed",
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
    };
    wrapped.add(result);
    return result;
  }
  let projectMessages = (messages: readonly AgentMessage[]) => messages;
  const factory = createDefaultChildSessionFactory({
    loadPiCodingAgent: async () => ({
      ...sdk,
      ModelRuntime: new Proxy(sdk.ModelRuntime, {
        get(target, key, receiver) {
          if (key === "create")
            return () =>
              sdk.ModelRuntime.create({
                credentials: AuthStorage.inMemory(),
                modelsPath: null,
                refreshOnCreate: false,
              });
          return Reflect.get(target, key, receiver);
        },
      }),
      createAgentSession: async (config) => {
        const loader = config?.resourceLoader;
        if (!loader) throw new Error("子代理缺少原生资源加载器。");
        const loadErrors = loader.getExtensions().errors;
        if (loadErrors.length)
          throw new Error(
            `子代理扩展加载失败：${loadErrors.map(({ path, error }) => `${path}: ${error}`).join("; ")}`,
          );
        for (const skill of loader.getSkills().skills)
          skillRoots.add(await realpath(skill.baseDir));
        // Wrap both loaded and subsequently registered extension tools. Native
        // runtime hooks keep their own permission, tool budget and output checks.
        for (const extension of loader.getExtensions().extensions) {
          const map = extension.tools;
          for (const [name, registered] of map)
            map.set(name, {
              ...registered,
              definition: guard(registered.definition),
            });
          const set = map.set.bind(map);
          map.set = (name, registered) =>
            set(name, {
              ...registered,
              definition: guard(registered.definition),
            });
        }
        const created = await sdk.createAgentSession({
          ...config,
          excludeTools: [...(config?.excludeTools ?? []), "powershell"],
          customTools: [...boundedNavigation, ...options.tools]
            .filter(
              (tool) =>
                !isWebTool(tool.name) ||
                !loader
                  .getExtensions()
                  .extensions.some((extension) =>
                    extension.tools.has(tool.name),
                  ),
            )
            .map((tool) => guard(tool as ToolDefinition)),
        });
        const policy = installGenerationPolicy(created.session.agent);
        projectMessages = policy.projectFinal;
        const handoff = createSubagentHandoff({
          cwd: launch.cwd,
          save: (path, text, signal) =>
            persistSubagentOutput(
              options.environment,
              options.id,
              path,
              text,
              signal,
            ),
          summarize: (text, signal) => {
            const model = created.session.model;
            if (!model || !config.modelRuntime)
              throw new Error("子代理交接缺少可用模型");
            return summarizeHandoff(config.modelRuntime, model, text, signal);
          },
        });
        const transform = created.session.agent.transformContext;
        created.session.agent.transformContext = async (messages, signal) =>
          handoff(
            transform ? await transform(messages, signal) : messages,
            signal ?? new AbortController().signal,
          );
        const prompt = created.session.prompt.bind(created.session);
        created.session.prompt = async (...args) => {
          policy.reset();
          return prompt(...args);
        };
        return created;
      },
    }),
  });
  try {
    const session = await factory.create({
      ...launch,
      appendSystemPrompt: [
        launch.appendSystemPrompt,
        SUBAGENT_DELIVERY_PROMPT,
        !launch.extensionPaths.length &&
        (!launch.tools || launch.tools.some(isWebTool))
          ? WEB_RESEARCH_PROMPT
          : undefined,
      ]
        .filter(Boolean)
        .join("\n\n"),
      parentProviderRegistry: options.providers,
    });
    const dispose = session.dispose.bind(session);
    session.dispose = async () => {
      try {
        await dispose();
      } finally {
        await options.onDispose?.();
      }
    };
    return new Proxy(session, {
      get(target, key, receiver) {
        if (key === "subscribe")
          return (listener: Parameters<typeof session.subscribe>[0]) => {
            const deliver = (event: Parameters<typeof listener>[0]) => {
              // Upstream derives the handoff from the last message_end, while Pi
              // persists each original chunk. Join only the outward final report.
              const message = event.message as AgentMessage | undefined;
              listener(
                event.type === "message_end" && message?.role === "assistant"
                  ? { ...event, message: projectMessages([message])[0] }
                  : event,
              );
            };
            const unsubscribe = target.subscribe((event) =>
              executionEvents.receive(event, deliver),
            );
            return () => {
              unsubscribe();
              executionEvents.unsubscribe(deliver);
            };
          };
        return key === "messages"
          ? projectMessages(target.messages)
          : Reflect.get(target, key, receiver);
      },
    });
  } catch (error) {
    try {
      await factory.dispose();
    } finally {
      await options.onDispose?.();
    }
    throw error;
  }
}

/** Native automatic output persistence must not bypass a card's write approval. */
export async function persistSubagentOutput(
  environment: RunEnvironment,
  id: string,
  path: string,
  content: string,
  signal: AbortSignal,
) {
  if (!environment.workingDirectory)
    throw new Error("保存子代理输出需要工作目录。");
  const call = {
    id: `${id}:output-${randomUUID()}`,
    name: "write",
    arguments: { path, content },
    sandbox: {
      policyVersion: SANDBOX_POLICY_VERSION,
      workingDirectory: await realpath(environment.workingDirectory),
    },
  };
  if (
    !(await environment.beforeToolCall(
      structuredClone({ ...call, subagentId: id }),
      undefined,
      signal,
    ))
  )
    throw new Error("用户拒绝了子代理输出文件的保存。");
  try {
    const result = await environment.executeTool(
      call,
      async () => {
        signal.throwIfAborted();
        environment.onToolUpdate(call.id, { status: "running" });
        return createRunCodingTools(
          environment.workingDirectory!,
          environment,
          id,
        )
          .find((tool) => tool.name === "write")!
          .execute(call.id, call.arguments, signal);
      },
      signal,
    );
    if (result.isError)
      throw new Error(
        result.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n") || "子代理输出文件保存失败。",
      );
    environment.onToolUpdate(call.id, {
      status: "completed",
      output: `已保存子代理输出：${path}`,
    });
  } catch (error) {
    environment.onToolUpdate(call.id, {
      status: signal.aborted ? "cancelled" : "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
