export type ProviderProtocol =
  | "auto"
  | "openai-completions"
  | "openai-responses";

export interface ProviderSettings {
  id: string;
  name: string;
  baseUrl: string;
  /** Provider-local model ID, without Panel's provider prefix. */
  model: string;
  apiKeyConfigured: boolean;
  protocol?: ProviderProtocol;
  models: { id: string; name: string }[];
}

export interface SaveProviderSettings {
  baseUrl: string;
  model: string;
  /** Empty or omitted retains the existing key, including environment fallback. */
  apiKey?: string;
  protocol?: ProviderProtocol;
}
