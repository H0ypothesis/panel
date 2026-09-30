export type ProviderProtocol =
  | "auto"
  | "openai-completions"
  | "openai-responses";

export type ContextWindowSource = "builtin" | "configured" | "fallback";
export const MAX_CONTEXT_WINDOW = 100_000_000;
export function validContextWindow(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1024 &&
    value <= MAX_CONTEXT_WINDOW
  );
}

export interface ProviderModel {
  id: string;
  name: string;
  contextWindow?: number;
  contextWindowSource?: ContextWindowSource;
}

export interface ProviderSettings {
  id: string;
  name: string;
  baseUrl: string;
  /** Provider-local model ID, without Panel's provider prefix. */
  model: string;
  apiKeyConfigured: boolean;
  supportsContextWindow?: boolean;
  protocol?: ProviderProtocol;
  models: ProviderModel[];
}

export interface SaveProviderSettings {
  baseUrl: string;
  model: string;
  /** Empty or omitted retains the existing key, including environment fallback. */
  apiKey?: string;
  protocol?: ProviderProtocol;
  /** Tokens for this model at this URL. Null clears its override; omission retains it. */
  contextWindow?: number | null;
}

export interface DiscoverProviderModels {
  baseUrl: string;
  apiKey?: string;
}

export interface ProviderModelCatalog {
  models: ProviderModel[];
  truncated: boolean;
}
