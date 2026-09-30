import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { loadNicobailon } from "./nicobailon-loader.ts";
import panelHostChildFactory, {
  bridgeProviders,
  hostBridgeConfig,
} from "./subagent-host-factory.ts";
import { callSubagentBridge } from "./subagent-host-rpc.ts";
import type { Model, Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const config = await hostBridgeConfig();
const engine = await loadNicobailon();
const sdk = engine.piSdk;
const factory = panelHostChildFactory();
engine.setChildSessionFactory(factory);
engine.setChildSessionFactoryModule(
  fileURLToPath(
    new URL(
      import.meta.url.endsWith(".mjs")
        ? "./subagent-host-factory.mjs"
        : "./subagent-host-factory.ts",
      import.meta.url,
    ),
  ),
);
const bootstrap = await callSubagentBridge<{ models: Model<any>[] }>(
  config.address,
  "bootstrap",
  {},
);
const providers = bridgeProviders(config.address, bootstrap.models);
const modelRuntime = await sdk.ModelRuntime.create({
  credentials: engine.AuthStorage.inMemory(),
  modelsPath: null,
  refreshOnCreate: false,
});
for (const provider of providers.getRegisteredProviderIds())
  modelRuntime.registerNativeProvider(
    providers.getRegisteredNativeProvider(provider)!,
  );
await modelRuntime.refresh({ allowNetwork: false });
const resolved = sdk.resolveCliModel({ cliModel: config.model, modelRuntime });
if (!resolved.model)
  throw new Error(resolved.error ?? "子代理宿主模型不存在。");
const sessionPath = join(config.directory, "parent.jsonl");
const manager = sdk.SessionManager.open(sessionPath, undefined, config.cwd);
const registerNative = await engine.loadNativeSubagentExtension();
const registeredTools = new Set<string>();
const notify = (kind: string, value: unknown) => {
  void callSubagentBridge(config.address, "host.event", { kind, value }).catch(
    () => {},
  );
};
// Global extensions can register named workflows and external-job providers.
// Project extensions remain a per-role child-session decision.
const settings = sdk.SettingsManager.create(config.cwd, config.agentDir, {
  projectTrusted: false,
});
const loader = new sdk.DefaultResourceLoader({
  cwd: config.cwd,
  agentDir: config.agentDir,
  settingsManager: settings,
  noExtensions: false,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  extensionFactories: [
    (pi: ExtensionAPI) => {
      registeredTools.add("subagent_detach");
      pi.registerTool({
        name: "subagent_detach",
        label: "转入后台",
        description:
          "将精确 run id 的前台子代理转入后台；保留会话与状态。需要当前运行支持原生脱离。",
        parameters: Type.Object({
          id: Type.String({ minLength: 1 }),
          index: Type.Optional(Type.Integer({ minimum: 0 })),
        }),
        execute: async (_id, args, signal) => {
          const requestId = randomUUID();
          const accepted = await new Promise<boolean>((resolve) => {
            const finish = (value: boolean) => {
              clearTimeout(timer);
              unsubscribe();
              signal?.removeEventListener("abort", abort);
              resolve(value);
            };
            const abort = () => finish(false);
            const unsubscribe = pi.events.on(
              "pi-intercom:detach-response",
              (event: any) => {
                if (event?.requestId === requestId)
                  finish(event.accepted === true);
              },
            );
            const timer = setTimeout(() => finish(false), 2000);
            signal?.addEventListener("abort", abort, { once: true });
            pi.events.emit("pi-intercom:detach-request", {
              requestId,
              runId: args.id,
              childIndex: args.index,
            });
          });
          if (accepted)
            notify("detached", { runId: args.id, index: args.index });
          return {
            content: [
              {
                type: "text",
                text: accepted
                  ? "子代理已转入后台。"
                  : "此运行当前不能脱离；请查看原生状态。",
              },
            ],
            details: { accepted },
            isError: !accepted,
          };
        },
      });
      const childFlag = process.env.PI_SUBAGENT_CHILD;
      delete process.env.PI_SUBAGENT_CHILD;
      try {
        registerNative({
          ...pi,
          registerTool(tool) {
            registeredTools.add(tool.name);
            pi.registerTool(tool);
          },
          sendMessage(message, options) {
            pi.appendEntry("panel-subagents-notification", message);
            notify("message", { message, options });
          },
          sendUserMessage(content, options) {
            notify("user-message", { content, options });
          },
        });
      } finally {
        if (childFlag === undefined) delete process.env.PI_SUBAGENT_CHILD;
        else process.env.PI_SUBAGENT_CHILD = childFlag;
      }
      for (const name of [
        "subagent:async-started",
        "subagent:async-complete",
        "subagent:control-event",
        "subagent:steering-notice",
      ])
        pi.events.on(name, (event) => notify(name, event));
    },
  ],
});
// Suppress a second ambient pi-subagents instance while loading shared providers.
const childFlag = process.env.PI_SUBAGENT_CHILD;
process.env.PI_SUBAGENT_CHILD = "1";
try {
  await loader.reload();
} finally {
  if (childFlag === undefined) delete process.env.PI_SUBAGENT_CHILD;
  else process.env.PI_SUBAGENT_CHILD = childFlag;
}
if (loader.getExtensions().errors.length)
  throw new Error(JSON.stringify(loader.getExtensions().errors));
const { session } = await sdk.createAgentSession({
  cwd: config.cwd,
  agentDir: config.agentDir,
  modelRuntime,
  model: resolved.model,
  thinkingLevel:
    config.thinking as import("@earendil-works/pi-agent-core").ThinkingLevel,
  resourceLoader: loader,
  sessionManager: manager,
  settingsManager: settings,
  noTools: "builtin",
  sessionStartEvent: { type: "session_start", reason: "startup" },
});
await session.bindExtensions({
  mode: "print",
  onError: (error) => notify("error", error),
});
session.setActiveToolsByName([...registeredTools]);
const active = new Map<string, AbortController>();
let shuttingDown = false;
const historyMarker = manager
  .getEntries()
  .findLast(
    (entry) =>
      entry.type === "custom" && entry.customType === "panel-parent-history",
  );
let historyLength =
  historyMarker?.type === "custom"
    ? Number((historyMarker.data as { length?: number })?.length ?? 0)
    : 0;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const controller of active.values()) controller.abort();
  await factory.stopAll();
  await session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  session.dispose();
  process.exit(0);
}
process.on("message", async (raw) => {
  const message = raw as {
    id: string;
    name?: string;
    args?: Record<string, unknown>;
    cancel?: boolean;
    close?: boolean;
    history?: Message[];
  };
  if (message.close) {
    await shutdown();
    return;
  }
  if (message.cancel) {
    active.get(message.id)?.abort();
    return;
  }
  const controller = new AbortController();
  active.set(message.id, controller);
  try {
    if (message.history) {
      for (const item of message.history.slice(historyLength))
        manager.appendMessage(item);
      historyLength = message.history.length;
      manager.appendCustomEntry("panel-parent-history", {
        length: historyLength,
      });
    }
    const tool = session.getToolDefinition(message.name ?? "subagent");
    if (!tool || !registeredTools.has(message.name ?? "subagent"))
      throw new Error(`原生插件未注册工具 ${message.name}。`);
    const context = session.extensionRunner.createToolContext(
      message.id,
      controller.signal,
    );
    const ask = (kind: string, title: string, value: unknown) =>
      callSubagentBridge<any>(
        config.address,
        "host.ui",
        { id: randomUUID(), kind, title, value },
        controller.signal,
      );
    const result = await tool.execute(
      message.id,
      message.args ?? {},
      controller.signal,
      (result) => process.send?.({ id: message.id, update: result }),
      {
        ...context,
        hasUI: true,
        ui: {
          ...context.ui,
          confirm: (title, message) => ask("confirm", title, message),
          select: (title, options) => ask("select", title, options),
          input: (title, placeholder) => ask("input", title, placeholder),
          editor: (title, text) => ask("editor", title, text),
        },
      },
    );
    process.send?.({ id: message.id, result });
  } catch (error) {
    process.send?.({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    active.delete(message.id);
  }
});
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("disconnect", () => void shutdown());
process.send?.({
  ready: true,
  tools: session.getAllTools().filter((tool) => registeredTools.has(tool.name)),
  sessionFile: manager.getSessionFile(),
});
