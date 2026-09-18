import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";

export function paperbypassProvider() {
  const baseUrl = (
    process.env.PAPERBYPASS_BASE_URL?.trim() ||
    "https://aigateway.paperbypass.com/api"
  ).replace(/\/+$/, "");
  const id = process.env.PAPERBYPASS_MODEL?.trim() || "openai/gpt-5.6-luna-pro";
  return createProvider({
    id: "paperbypass",
    name: "Paperbypass",
    baseUrl,
    auth: {
      apiKey: {
        name: "Paperbypass API key",
        resolve: async ({ ctx, signal }) => {
          const key = (await ctx.env("PAPERBYPASS_API_KEY"))?.trim();
          signal.throwIfAborted();
          if (!key) return undefined;
          return {
            auth: { headers: { Authorization: `Bearer ${key}` } },
            source: "PAPERBYPASS_API_KEY",
          };
        },
      },
    },
    models: [
      {
        id,
        name: id === "openai/gpt-5.6-luna-pro" ? "Luna Pro" : id,
        api: "anthropic-messages",
        provider: "paperbypass",
        baseUrl,
        // Text-only input; Pi's Messages adapter also handles tools and tool-result history.
        reasoning: false,
        input: ["text"],
        // Local conservative limits; gateway pricing is not available here.
        contextWindow: 128000,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    api: anthropicMessagesApi(),
  });
}
