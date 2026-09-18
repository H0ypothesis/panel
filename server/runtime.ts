import { Agent } from "@earendil-works/pi-agent-core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  getSupportedThinkingLevels,
  type Message,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import type { ModelOption, RunConfig, TurnNode } from "../shared/types.ts";
import { SYSTEM_PROMPT } from "./context.ts";

export interface RunResult {
  messages: Message[];
  response: string;
  usage?: TurnNode["usage"];
}
export interface Runtime {
  models(): ModelOption[];
  run(
    config: RunConfig,
    history: Message[],
    prompt: string,
    signal: AbortSignal,
    onText: (text: string) => void,
  ): Promise<RunResult>;
}

const providers = [
  {
    id: "anthropic",
    name: "Anthropic",
    env: "ANTHROPIC_API_KEY",
    keys: [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_OAUTH_TOKEN",
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    env: "OPENAI_API_KEY",
    keys: ["OPENAI_API_KEY"],
  },
  {
    id: "google",
    name: "Google",
    env: "GEMINI_API_KEY",
    keys: ["GEMINI_API_KEY"],
  },
];

export function safeError(error: unknown) {
  let message = error instanceof Error ? error.message : String(error);
  for (const provider of providers) {
    for (const key of provider.keys) {
      const secret = process.env[key];
      if (secret) message = message.replaceAll(secret, "[redacted]");
    }
  }
  return message.slice(0, 1500);
}

export class PiRuntime implements Runtime {
  private registry = createModels();

  constructor() {
    this.registry.setProvider(anthropicProvider());
    this.registry.setProvider(openaiProvider());
    this.registry.setProvider(googleProvider());
  }

  models(): ModelOption[] {
    return [
      {
        id: "demo/pi-demo",
        name: "Pi Demo",
        provider: "demo",
        providerName: "本地演示",
        available: true,
        demo: true,
        thinkingLevels: ["off", "minimal", "low", "medium", "high"],
        contextWindow: 128000,
      },
      ...this.registry.getModels().map((model) => {
        const provider = providers.find((item) => item.id === model.provider)!;
        return {
          id: `${model.provider}/${model.id}`,
          name: model.name,
          provider: model.provider,
          providerName: provider.name,
          available: provider.keys.some((key) =>
            Boolean(process.env[key]?.trim()),
          ),
          demo: false,
          thinkingLevels: getSupportedThinkingLevels(model),
          contextWindow: model.contextWindow,
          envVar: provider.env,
        };
      }),
    ];
  }

  async run(
    config: RunConfig,
    history: Message[],
    prompt: string,
    signal: AbortSignal,
    onText: (text: string) => void,
  ): Promise<RunResult> {
    signal.throwIfAborted();
    let registry = this.registry;
    const slash = config.model.indexOf("/");
    const provider = config.model.slice(0, slash);
    const id = config.model.slice(slash + 1);
    if (provider === "demo") {
      // One faux provider per run prevents concurrent branches from consuming each other's scripts.
      registry = createModels();
      const demo = fauxProvider({
        provider: "demo",
        models: [{ id: "pi-demo", name: "Pi Demo", reasoning: true }],
        tokensPerSecond: 18,
        tokenSize: { min: 4, max: 9 },
      });
      demo.setResponses([
        fauxAssistantMessage(
          `### 一个新的探索方向\n\n> ${prompt.replaceAll("\n", "\n> ")}\n\n这是 **Pi 演示模型**的预设回复，用于体验分支和并行生成，没有调用远程模型。\n\n这次运行继承了当前路径中的 **${history.filter((message) => message.role === "user").length} 条用户消息**，其他分支不会进入本轮上下文。\n\n你可以继续尝试：\n\n1. **深入这个方向**：从当前节点提出更具体的问题。\n2. **探索另一个可能**：回到任意已完成节点，创建一条新分支。\n3. **同时推进**：在这条分支生成时，到其他节点发起新一轮对话。\n\n接入模型后，这里会实时呈现基于该分支上下文生成的真实回答。点击左下角「模型连接」查看配置方式。`,
        ),
      ]);
      registry.setProvider(demo.provider);
    }
    const model = registry.getModel(provider, id);
    if (!model) throw new Error("模型不存在。");
    const agent = new Agent({
      initialState: {
        systemPrompt: SYSTEM_PROMPT,
        model,
        thinkingLevel: config.thinking,
        messages: structuredClone(history),
        tools: [],
      },
      streamFn: registry.streamSimple.bind(registry),
    });
    const initialLength = agent.state.messages.length;
    const abort = () => agent.abort();
    signal.addEventListener("abort", abort, { once: true });
    let response = "";
    agent.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        response += event.assistantMessageEvent.delta;
        onText(response);
      }
    });
    try {
      // This check also covers cancellation between runtime setup and prompt dispatch.
      signal.throwIfAborted();
      await agent.prompt(prompt);
      signal.throwIfAborted();
      const messages = agent.state.messages.slice(initialLength) as Message[];
      const assistant = messages
        .filter((message) => message.role === "assistant")
        .at(-1);
      if (
        !assistant ||
        assistant.stopReason === "error" ||
        assistant.stopReason === "aborted"
      ) {
        throw new Error(
          assistant?.errorMessage ||
            agent.state.errorMessage ||
            "模型没有返回有效回答。",
        );
      }
      if (assistant.stopReason === "length")
        throw new Error(
          "回答超过输出限制，已保留部分内容，请从父节点缩小问题后重试。",
        );
      return {
        messages: structuredClone(messages),
        response,
        usage:
          provider === "demo"
            ? undefined
            : {
                input:
                  assistant.usage.input +
                  assistant.usage.cacheRead +
                  assistant.usage.cacheWrite,
                output: assistant.usage.output,
                total: assistant.usage.totalTokens,
                cost: assistant.usage.cost.total,
              },
      };
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}
