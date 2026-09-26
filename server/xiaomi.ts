import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export function xiaomiTokenPlanProvider() {
  const baseUrl = (
    process.env.XIAOMI_TOKEN_PLAN_CN_BASE_URL?.trim() ||
    "https://token-plan-cn.xiaomimimo.com/v1"
  ).replace(/\/+$/, "");
  return createProvider({
    id: "xiaomi-token-plan-cn",
    name: "小米 MiMo Token Plan",
    baseUrl,
    auth: {
      apiKey: {
        name: "Xiaomi Token Plan CN API key",
        resolve: async ({ ctx, signal }) => {
          const key = (await ctx.env("XIAOMI_TOKEN_PLAN_CN_API_KEY"))?.trim();
          signal.throwIfAborted();
          if (!key) return undefined;
          return {
            auth: { apiKey: key },
            source: "XIAOMI_TOKEN_PLAN_CN_API_KEY",
          };
        },
      },
    },
    models: ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.5-pro"].map((id) => ({
      id,
      name: id,
      api: "openai-completions",
      provider: "xiaomi-token-plan-cn",
      baseUrl,
      reasoning: true,
      // MiMo exposes an on/off switch, not separate reasoning effort levels.
      thinkingLevelMap: { minimal: null, low: null, medium: null },
      input: id === "mimo-v2.5-pro" ? ["text"] : ["text", "image"],
      contextWindow: 1048576,
      maxTokens: 131072,
      // Subscription usage has no per-request cost estimate in Panel.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: {
        thinkingFormat: "deepseek",
        supportsReasoningEffort: false,
        supportsDeveloperRole: false,
        supportsStore: false,
        requiresReasoningContentOnAssistantMessages: true,
      },
    })),
    api: openAICompletionsApi(),
  });
}
