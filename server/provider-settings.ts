import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import type {
  ProviderSettings,
  ProviderProtocol,
  ProviderModelCatalog,
  ContextWindowSource,
} from "../shared/provider-settings.ts";
import { validContextWindow } from "../shared/provider-settings.ts";
import { discoverModels } from "./model-discovery.ts";
import { paperbypassProvider } from "./paperbypass.ts";
import { atriaProvider } from "./atria.ts";
import { xiaomiTokenPlanProvider } from "./xiaomi.ts";

export const modelProviders = [
  {
    id: "xiaomi-token-plan-cn",
    name: "小米 MiMo Token Plan",
    env: "XIAOMI_TOKEN_PLAN_CN_API_KEY",
    keys: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
    defaultModel: "mimo-v2.6-pro",
    create: xiaomiTokenPlanProvider,
  },
  {
    id: "atria",
    name: "Atria",
    env: "ATRIA_API_KEY",
    keys: ["ATRIA_API_KEY"],
    defaultModel: "Atria-Dawn-Preview",
    create: atriaProvider,
  },
  {
    id: "paperbypass",
    name: "Paperbypass",
    env: "PAPERBYPASS_API_KEY",
    keys: ["PAPERBYPASS_API_KEY"],
    defaultModel: "openai/gpt-5.6-luna-pro",
    create: paperbypassProvider,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    env: "ANTHROPIC_API_KEY",
    keys: [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_OAUTH_TOKEN",
    ],
    defaultModel: "claude-sonnet-4-6",
    create: anthropicProvider,
  },
  {
    id: "openai",
    name: "OpenAI",
    env: "OPENAI_API_KEY",
    keys: ["OPENAI_API_KEY"],
    defaultModel: "gpt-5.4",
    create: openaiProvider,
  },
  {
    id: "google",
    name: "Google",
    env: "GEMINI_API_KEY",
    keys: ["GEMINI_API_KEY"],
    defaultModel: "gemini-2.5-pro",
    create: googleProvider,
  },
];

interface StoredProviderSettings {
  baseUrl: string;
  model: string;
  apiKey?: string;
  protocol?: ProviderProtocol;
  /** Keep prior custom IDs available to saved conversations after switching. */
  customModels: string[];
  modelContexts?: { id: string; contextWindow: number }[];
}

// Keep superseded keys redacted too: a request started before a save can fail later.
const localSecrets = new Set<string>();

export function redactProviderSecrets(message: string): string {
  for (const secret of [...localSecrets].sort((a, b) => b.length - a.length))
    message = message.replaceAll(secret, "[redacted]");
  return message;
}

function textField(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error(`${label}不能为空、不能包含换行，且最多 ${max} 个字符。`);
  return value.trim();
}

function validateConnection(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("模型连接配置格式错误。");
  const fields = input as Record<string, unknown>;
  const baseUrl = textField(fields.baseUrl, "API URL", 2048);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("请输入有效的 HTTP 或 HTTPS API URL。");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "API URL 必须使用 HTTP 或 HTTPS，且不能包含账号、密码、查询参数或锚点。",
    );
  let apiKey: string | undefined;
  if (fields.apiKey !== undefined) {
    if (
      typeof fields.apiKey !== "string" ||
      fields.apiKey.length > 8192 ||
      /[\u0000-\u001f\u007f]/.test(fields.apiKey)
    )
      throw new Error("API Key 必须是单行文本，且最多 8192 个字符。");
    apiKey = fields.apiKey.trim() || undefined;
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey };
}

function validateSettings(input: unknown) {
  const connection = validateConnection(input);
  const fields = input as Record<string, unknown>;
  const model = textField(fields.model, "Model ID", 240);
  if (/\s/.test(model)) throw new Error("Model ID 不能包含空白字符。");
  if (
    fields.protocol !== undefined &&
    (typeof fields.protocol !== "string" ||
      !["auto", "openai-completions", "openai-responses"].includes(
        fields.protocol,
      ))
  )
    throw new Error("接口协议设置无效。");
  return {
    ...connection,
    model,
    protocol: fields.protocol as ProviderProtocol | undefined,
  };
}

/** Local-only settings are deliberately separate from workspace state and exports. */
export class ModelProviderSettings {
  private readonly baseline: Provider[] = modelProviders.map((item) =>
    item.create(),
  );
  private saved = new Map<string, StoredProviderSettings>();
  private writes: Promise<unknown> = Promise.resolve();
  private registry = this.buildRegistry(this.saved);

  constructor(private readonly directory: string) {}

  async init(): Promise<void> {
    const path = join(this.directory, "model-providers.json");
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("无法读取本地模型连接配置。");
    }
    const saved = new Map<string, StoredProviderSettings>();
    try {
      const parsed = JSON.parse(content);
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.providers))
        throw new Error("Invalid configuration");
      for (const entry of parsed.providers) {
        if (!entry || !modelProviders.some((item) => item.id === entry.id))
          throw new Error("Invalid provider");
        const value = validateSettings(entry);
        if (
          entry.id !== "openai" &&
          value.protocol &&
          value.protocol !== "auto"
        )
          throw new Error("Invalid protocol");
        if (!Array.isArray(entry.customModels))
          throw new Error("Invalid models");
        const customModels = entry.customModels.map(
          (id: unknown) => validateSettings({ ...value, model: id }).model,
        );
        if (
          entry.modelContexts !== undefined &&
          !Array.isArray(entry.modelContexts)
        )
          throw new Error("Invalid model contexts");
        const modelContexts = (entry.modelContexts ?? []).map(
          (item: unknown) => {
            if (
              !item ||
              typeof item !== "object" ||
              !("id" in item) ||
              !("contextWindow" in item) ||
              !validContextWindow(item.contextWindow)
            )
              throw new Error("Invalid model context");
            return {
              id: validateSettings({ ...value, model: item.id }).model,
              contextWindow: item.contextWindow,
            };
          },
        );
        saved.set(entry.id, {
          ...value,
          customModels: [...new Set<string>(customModels)],
          modelContexts,
        });
      }
      await chmod(path, 0o600);
    } catch {
      // JSON parser errors may include raw file content, including credentials.
      throw new Error(
        "本地模型连接配置无法读取，请检查 model-providers.json 的格式和权限。",
      );
    }
    const registry = this.buildRegistry(saved);
    for (const value of saved.values())
      if (value.apiKey) localSecrets.add(value.apiKey);
    this.saved = saved;
    this.registry = registry;
  }

  currentRegistry() {
    return this.registry;
  }

  async discover(
    id: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ProviderModelCatalog> {
    const definition = modelProviders.find((item) => item.id === id);
    if (!definition) throw new Error("不支持此模型服务商。");
    const value = validateConnection(input);
    const configuredUrl = this.registry
      .getProvider(id)
      ?.baseUrl?.replace(/\/+$/, "");
    if (!value.apiKey && value.baseUrl !== configuredUrl)
      throw new Error(
        "API URL 已改变，请填写该地址对应的 API Key 后获取模型。",
      );
    let key = value.apiKey ?? this.saved.get(id)?.apiKey;
    let bearer =
      id === "paperbypass" || id === "openai" || id === "xiaomi-token-plan-cn";
    if (!key && id === "anthropic") {
      key = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
      bearer = Boolean(key);
      key ||=
        process.env.ANTHROPIC_OAUTH_TOKEN?.trim() ||
        process.env.ANTHROPIC_API_KEY?.trim();
    }
    key ||= definition.keys
      .map((name) => process.env[name]?.trim())
      .find(Boolean);
    if (!key) throw new Error("请填写 API Key 后获取模型列表。");
    const format =
      id === "google"
        ? "google"
        : id === "paperbypass"
          ? "paperbypass"
          : ["anthropic", "atria"].includes(id)
            ? "anthropic"
            : "openai";
    const headers: Record<string, string> =
      id === "google"
        ? { "x-goog-api-key": key }
        : bearer
          ? { Authorization: `Bearer ${key}` }
          : { "x-api-key": key };
    if (format === "anthropic") headers["anthropic-version"] = "2023-06-01";
    return discoverModels(value.baseUrl, format, headers, signal);
  }

  configured(id: string): boolean {
    return (
      Boolean(this.saved.get(id)?.apiKey) ||
      Boolean(
        modelProviders
          .find((item) => item.id === id)
          ?.keys.some((key) => process.env[key]?.trim()),
      )
    );
  }

  contextWindowSource(
    providerId: string,
    modelId: string,
  ): ContextWindowSource {
    if (
      this.saved
        .get(providerId)
        ?.modelContexts?.some((item) => item.id === modelId)
    )
      return "configured";
    if (providerId === "paperbypass" && modelId !== "Atria-Dawn-Preview")
      return "fallback";
    return this.baseline
      .find((provider) => provider.id === providerId)
      ?.getModels()
      .some((model) => model.id === modelId)
      ? "builtin"
      : "fallback";
  }

  list(): ProviderSettings[] {
    return modelProviders.map((definition) => {
      const provider = this.registry.getProvider(definition.id)!;
      const models = provider
        .getModels()
        .map(({ id, name, contextWindow }) => ({
          id,
          name,
          contextWindow,
          contextWindowSource: this.contextWindowSource(definition.id, id),
        }));
      const preferred = process.env.PANEL_DEFAULT_MODEL?.trim();
      const envModel = preferred?.startsWith(`${definition.id}/`)
        ? preferred.slice(definition.id.length + 1)
        : undefined;
      return {
        id: definition.id,
        name: definition.name,
        baseUrl: provider.baseUrl ?? "",
        model:
          this.saved.get(definition.id)?.model ??
          (envModel && models.some((model) => model.id === envModel)
            ? envModel
            : models.some((model) => model.id === definition.defaultModel)
              ? definition.defaultModel
              : (models[0]?.id ?? "")),
        apiKeyConfigured: this.configured(definition.id),
        supportsContextWindow: true,
        ...(definition.id === "openai"
          ? { protocol: this.saved.get(definition.id)?.protocol ?? "auto" }
          : {}),
        models,
      };
    });
  }

  save(id: string, input: unknown): Promise<void> {
    const operation = this.writes.then(async () => {
      const definition = modelProviders.find((item) => item.id === id);
      if (!definition) throw new Error("不支持此模型服务商。");
      const value = validateSettings(input);
      const contextWindow = (input as Record<string, unknown>).contextWindow;
      if (
        contextWindow !== undefined &&
        contextWindow !== null &&
        !validContextWindow(contextWindow)
      )
        throw new Error(
          "上下文长度必须是 1024 到 100000000 之间的整数（tokens）。",
        );
      if (id !== "openai" && value.protocol && value.protocol !== "auto")
        throw new Error("此服务商不支持修改接口协议。");
      const previous = this.saved.get(id);
      const apiKey = value.apiKey ?? previous?.apiKey;
      if (!apiKey && !definition.keys.some((key) => process.env[key]?.trim()))
        throw new Error("首次配置此服务商时，请填写 API Key。");
      const builtinIds = this.baseline
        .find((provider) => provider.id === id)!
        .getModels()
        .map((model) => model.id);
      const customModels = [
        ...new Set([
          ...(previous?.customModels ?? []),
          ...(!builtinIds.includes(value.model) ? [value.model] : []),
        ]),
      ];
      const saved = new Map(this.saved);
      // A capacity belongs to a model at this endpoint, never to every model or another URL.
      const modelContexts = new Map(
        (previous?.baseUrl === value.baseUrl
          ? (previous.modelContexts ?? [])
          : []
        ).map((item) => [item.id, item.contextWindow]),
      );
      if (contextWindow === null) modelContexts.delete(value.model);
      else if (contextWindow !== undefined)
        modelContexts.set(value.model, contextWindow);
      saved.set(id, {
        ...value,
        apiKey,
        protocol: value.protocol ?? previous?.protocol,
        customModels,
        modelContexts: [...modelContexts].map(([id, contextWindow]) => ({
          id,
          contextWindow,
        })),
      });
      const registry = this.buildRegistry(saved);
      const path = join(this.directory, "model-providers.json");
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await writeFile(
          temporary,
          JSON.stringify(
            {
              version: 1,
              providers: [...saved].map(([id, settings]) => ({
                id,
                ...settings,
              })),
            },
            null,
            2,
          ) + "\n",
          { mode: 0o600, flag: "wx" },
        );
        await rename(temporary, path);
      } catch {
        await rm(temporary, { force: true }).catch(() => {});
        throw new Error("无法保存本地模型连接配置，请检查数据目录权限。");
      }
      if (apiKey) localSecrets.add(apiKey);
      this.saved = saved;
      this.registry = registry;
    });
    this.writes = operation.catch(() => {});
    return operation;
  }

  private buildRegistry(saved: Map<string, StoredProviderSettings>) {
    const registry = createModels();
    for (const provider of this.baseline) {
      const settings = saved.get(provider.id);
      if (!settings) {
        registry.setProvider(provider);
        continue;
      }
      const models: Model<Api>[] = provider
        .getModels()
        .map((model) => ({ ...model, baseUrl: settings.baseUrl }));
      for (const id of settings.customModels) {
        if (models.some((model) => model.id === id)) continue;
        // An unknown model does not inherit capabilities or pricing from an unrelated model.
        models.push({
          id,
          name: id,
          provider: provider.id,
          api: provider.id === "openai" ? "openai-completions" : models[0]!.api,
          baseUrl: settings.baseUrl,
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        });
      }
      const key = settings.apiKey;
      for (const { id, contextWindow } of settings.modelContexts ?? []) {
        const model = models.find((item) => item.id === id);
        if (model) model.contextWindow = contextWindow;
      }
      if (
        provider.id === "openai" &&
        settings.protocol &&
        settings.protocol !== "auto"
      ) {
        for (const model of models) {
          if (model.api !== settings.protocol) delete model.compat;
          model.api = settings.protocol;
        }
      }
      registry.setProvider(
        createProvider({
          ...provider,
          baseUrl: settings.baseUrl,
          models,
          api:
            provider.id === "openai"
              ? {
                  "openai-responses": provider,
                  "openai-completions": openAICompletionsApi(),
                }
              : provider,
          auth: key
            ? {
                apiKey: {
                  name: `${provider.name} API key`,
                  resolve: async ({ signal }) => {
                    signal.throwIfAborted();
                    return {
                      auth:
                        provider.id === "paperbypass"
                          ? { headers: { Authorization: `Bearer ${key}` } }
                          : { apiKey: key },
                      source: "local configuration",
                    };
                  },
                },
              }
            : provider.auth,
        }),
      );
    }
    return registry;
  }
}
