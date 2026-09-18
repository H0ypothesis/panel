import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";

export function atriaProvider() {
  const baseUrl = (
    process.env.ATRIA_BASE_URL?.trim() || "https://api.atria-asi.ai"
  ).replace(/\/+$/, "");
  const id = process.env.ATRIA_MODEL?.trim() || "Atria-Dawn-Preview";
  return createProvider({
    id: "atria",
    name: "Atria",
    baseUrl,
    auth: {
      apiKey: {
        name: "Atria API key",
        resolve: async ({ ctx, signal }) => {
          const key = (await ctx.env("ATRIA_API_KEY"))?.trim();
          signal.throwIfAborted();
          if (!key) return undefined;
          // Atria's Messages endpoint uses x-api-key via the Anthropic SDK.
          return { auth: { apiKey: key }, source: "ATRIA_API_KEY" };
        },
      },
    },
    models: [
      {
        id,
        name: id,
        api: "anthropic-messages",
        provider: "atria",
        baseUrl,
        // Text-only input without thinking extensions; Pi handles tools and tool-result history.
        reasoning: false,
        input: ["text"],
        contextWindow: 256000,
        // Local output budget within Atria's documented 65,536-token maximum.
        maxTokens: 8192,
        // Pricing is unknown; PiRuntime omits cost estimates for this provider.
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    api: anthropicMessagesApi(),
  });
}
