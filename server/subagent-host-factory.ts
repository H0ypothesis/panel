import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  createProvider,
  createAssistantMessageEventStream,
  type Model,
  type Provider,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { createPanelChildSession } from "./subagent-session.ts";
import {
  createPanelTools,
  codingExecutionStartedNotice,
} from "./coding-tools.ts";
import { createWebTools } from "./web-tools.ts";
import {
  callSubagentBridge,
  type SubagentBridgeAddress,
} from "./subagent-host-rpc.ts";
import type {
  ChildSessionFactory,
  ChildSessionLaunch,
} from "./nicobailon-engine.ts";
import type { ToolCall } from "../shared/types.ts";
import { loadNicobailon } from "./nicobailon-loader.ts";
import { presentProfile } from "./subagent-profiles.ts";
import { fileURLToPath } from "node:url";

export interface HostBridgeConfig {
  address: SubagentBridgeAddress;
  directory: string;
  cwd: string;
  model: string;
  thinking: string;
  agentDir: string;
}

export async function hostBridgeConfig(): Promise<HostBridgeConfig> {
  const path = process.env.PANEL_SUBAGENT_HOST_CONFIG;
  if (!path) throw new Error("缺少 Panel 子代理宿主配置。");
  return JSON.parse(await readFile(path, "utf8"));
}

export function bridgeProviders(
  address: SubagentBridgeAddress,
  models: Model<any>[],
  childId?: string,
) {
  const providers = new Map<string, Provider>();
  const stream: Provider["stream"] = (model, context, options) => {
    const output = createAssistantMessageEventStream();
    const { signal, ...settings } = options ?? {};
    void callSubagentBridge(
      address,
      "model.stream",
      {
        childId,
        provider: model.provider,
        model: model.id,
        context,
        options: settings,
      },
      signal,
      (event) => {
        output.push(event as AssistantMessageEvent);
      },
    ).catch((error) => {
      output.push({
        type: "error",
        reason: signal?.aborted ? "aborted" : "error",
        error: {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: signal?.aborted ? "aborted" : "error",
          errorMessage: String(error),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
      });
    });
    return output;
  };
  for (const id of new Set(models.map((model) => model.provider))) {
    providers.set(
      id,
      createProvider({
        id,
        models: models.filter((model) => model.provider === id),
        auth: {
          apiKey: {
            name: "Panel model bridge",
            resolve: async () => ({ auth: { apiKey: "panel-host" } }),
          },
        },
        api: { stream, streamSimple: stream },
      }),
    );
  }
  return {
    getRegisteredProviderIds: () => [...providers.keys()],
    getRegisteredProviderConfig: () => undefined,
    getRegisteredNativeProvider: (id: string) => providers.get(id),
  };
}

/** Also loaded by the plugin's detached runner, so every native child is guarded. */
export default function panelHostChildFactory(): ChildSessionFactory & {
  stopAll(): Promise<void>;
} {
  const sessions = new Set<
    Awaited<ReturnType<typeof createPanelChildSession>>
  >();
  const factory: ChildSessionFactory & { stopAll(): Promise<void> } = {
    async create(launch: ChildSessionLaunch) {
      // A packaged detached runner owns an unbundled plugin instance. Install
      // the guarded factory there as well, so its nested delegates cannot fall
      // back to an unguarded SDK session or a different credential store.
      const engine = await loadNicobailon();
      engine.setChildSessionFactory(factory);
      const externalModule = new URL(
        "../node_modules/pi-subagents/src/runs/shared/child-session.js",
        import.meta.url,
      ).href;
      const external = (await import(externalModule)) as Pick<
        typeof engine,
        "setChildSessionFactory" | "setChildSessionFactoryModule"
      >;
      external.setChildSessionFactory(factory);
      external.setChildSessionFactoryModule(
        fileURLToPath(
          new URL(
            import.meta.url.endsWith(".mjs")
              ? "./subagent-host-factory.mjs"
              : "./subagent-host-factory.ts",
            import.meta.url,
          ),
        ),
      );
      const config = await hostBridgeConfig();
      const id = randomUUID();
      const profile = engine
        .discoverAgents(launch.cwd, "both", config.model.split("/")[0])
        .agents.find((agent) => agent.name === launch.runtime.agent);
      const bootstrap = await callSubagentBridge<{ models: Model<any>[] }>(
        config.address,
        "child.create",
        {
          id,
          profile: profile ? presentProfile(profile, true) : undefined,
          agent: launch.runtime.agent,
          runId: launch.runtime.runId,
          index: launch.runtime.childIndex,
          parentRunId: launch.runtime.nestedParent?.parentRunId,
          depth: launch.runtime.depth,
          cwd: launch.cwd,
          model: launch.model,
          tools: launch.tools,
          machine: launch.machine,
          pid: process.pid,
          sessionFile:
            launch.storage.kind === "file"
              ? launch.storage.sessionFile
              : undefined,
        },
      );
      const web = createWebTools();
      const pending = new Set<Promise<unknown>>();
      let notifications: Promise<unknown> = Promise.resolve();
      const notify = (method: string, params: unknown) => {
        const task = notifications.then(() =>
          callSubagentBridge(config.address, method, { id, value: params }),
        );
        notifications = task.catch(() => {});
        pending.add(task);
        void task.catch(() => {}).finally(() => pending.delete(task));
        return task;
      };
      let session: Awaited<ReturnType<typeof createPanelChildSession>>;
      const codingTools = createPanelTools(launch.cwd);
      for (const tool of codingTools) {
        tool.execute = (toolId, args, signal, onUpdate) =>
          callSubagentBridge(
            config.address,
            "coding.execute",
            { childId: id, callId: `${id}:${toolId}`, name: tool.name, args },
            signal,
            (event) =>
              onUpdate?.(
                (event as { type?: string }).type === "coding_execution_started"
                  ? codingExecutionStartedNotice()
                  : (event as Awaited<ReturnType<typeof tool.execute>>),
              ),
          );
      }
      try {
        session = launch.machine
          ? await (await loadNicobailon()).createHerdrPiSession(launch)
          : await createPanelChildSession(launch, {
              id,
              providers: bridgeProviders(config.address, bootstrap.models, id),
              tools: [
                ...codingTools,
                ...web.map((tool) => ({
                  ...tool,
                  execute: (
                    toolId: string,
                    args: unknown,
                    signal?: AbortSignal,
                    onUpdate?: (result: any) => void,
                  ) =>
                    callSubagentBridge<any>(
                      config.address,
                      "web.execute",
                      {
                        childId: id,
                        callId: `${id}:${toolId}`,
                        name: tool.name,
                        args,
                      },
                      signal,
                      onUpdate,
                    ),
                })),
              ],
              onDispose: async () => {
                await web.close();
                await Promise.allSettled(pending);
              },
              environment: {
                workingDirectory: launch.cwd,
                beforeToolCall: (call, _prepare, signal) =>
                  callSubagentBridge<boolean>(
                    config.address,
                    "tool.before",
                    { childId: id, cwd: launch.cwd, call },
                    signal,
                  ),
                executeTool: async (call, execute, signal) =>
                  callSubagentBridge(
                    config.address,
                    "tool.execute",
                    { childId: id, cwd: launch.cwd, call },
                    signal,
                    async (event) => {
                      if ((event as { type?: string }).type !== "grant") return;
                      try {
                        const result = await execute();
                        await callSubagentBridge(
                          config.address,
                          "tool.result",
                          {
                            callId: call.id,
                            result,
                          },
                        );
                      } catch (error) {
                        await callSubagentBridge(
                          config.address,
                          "tool.result",
                          {
                            callId: call.id,
                            error:
                              error instanceof Error
                                ? error.message
                                : String(error),
                          },
                        );
                      }
                    },
                  ) as ReturnType<typeof execute>,
                onToolUpdate: (callId, update) =>
                  notify("tool.update", { callId, update }),
              },
              resultSources: (result) =>
                (result as { details?: { sources?: ToolCall["sources"] } })
                  ?.details?.sources,
              resolveResumeOutput: (runId, index) =>
                callSubagentBridge<string | undefined>(
                  config.address,
                  "run.output",
                  { runId, index },
                ),
            });
      } catch (error) {
        await web.close();
        await notify("child.closed", {
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => {});
        throw error;
      }
      sessions.add(session);
      session.subscribe((event) => notify("child.event", event));
      notify("child.opened", {
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        model: session.modelId,
      });
      const original = session.dispose.bind(session);
      const prompt = session.prompt.bind(session);
      let failure: string | undefined;
      let aborted = false;
      session.prompt = async (text) => {
        await notify("child.prompt", text);
        try {
          await prompt(text);
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
          throw error;
        }
      };
      const abort = session.abort.bind(session);
      session.abort = async () => {
        aborted = true;
        await abort();
      };
      session.dispose = async () => {
        try {
          await original();
        } finally {
          await web.close();
          notify("child.closed", { error: failure, aborted });
          sessions.delete(session);
          await Promise.allSettled(pending);
        }
      };
      return session;
    },
    async dispose() {
      await Promise.allSettled(
        [...sessions]
          .filter((session) => !session.detached)
          .map(async (session) => {
            await session.abort();
            await session.dispose();
          }),
      );
    },
    async stopAll() {
      await Promise.allSettled(
        [...sessions].map(async (session) => {
          await session.abort();
          await session.dispose();
        }),
      );
    },
  };
  return factory;
}
