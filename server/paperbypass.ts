import { createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { type ModelThinkingSettings } from "../shared/provider-settings.ts";
import { effortApi, thinkingCapabilities } from "./model-thinking.ts";

function isForcedThinkingGlm(id: string) {
  return id === "z-ai/glm-5.3" || id === "z-ai/glm-5.3-flash";
}

export function paperbypassThinking(
  id: string,
): ModelThinkingSettings | undefined {
  // https://docs.z.ai/guides/capabilities/thinking
  if (isForcedThinkingGlm(id))
    return { format: "reasoning-effort", levels: ["low", "high", "max"] };
  // https://platform.claude.com/docs/en/build-with-claude/effort
  if (id === "anthropic/claude-opus-5.5")
    return {
      format: "anthropic-effort",
      levels: ["low", "medium", "high", "xhigh", "max"],
    };
  return undefined;
}

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
      ...new Set([
        id,
        "Atria-Dawn-Preview",
        "z-ai/glm-5.3-flash",
        "z-ai/glm-5.3",
        "anthropic/claude-opus-5.5",
      ]),
    ].map((id) => ({
      id,
      name: id === "openai/gpt-5.6-luna-pro" ? "Luna Pro" : id,
      api: "anthropic-messages",
      provider: "paperbypass",
      baseUrl,
      ...(paperbypassThinking(id)
        ? thinkingCapabilities(paperbypassThinking(id)!)
        : { reasoning: false }),
      // Verified image input: https://huggingface.co/zai-org/GLM-5.3-Flash
      // Unknown gateway models must not inherit another model's capabilities.
      input: id === "z-ai/glm-5.3-flash" ? ["text", "image"] : ["text"],
      // Atria's documented context window; other gateway models use a conservative budget.
      contextWindow: id === "Atria-Dawn-Preview" ? 256000 : 128000,
      maxTokens: id === "Atria-Dawn-Preview" ? 256000 : 128000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    api: effortApi(anthropicMessagesApi(), (model) =>
      paperbypassThinking(model.id),
    ),
  });
}
