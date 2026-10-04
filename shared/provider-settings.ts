import type { ThinkingLevel } from "./types";

export const effortLevels = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type EffortLevel = (typeof effortLevels)[number];
export type ThinkingFormat =
  | "reasoning-effort"
  | "reasoning-object"
  | "anthropic-effort"
  | "none";
export type ThinkingToggle =
  | "thinking-type"
  | "effort-none"
  | "required"
  | "none";
export interface ModelThinkingSettings {
  format: ThinkingFormat;
  levels: EffortLevel[];
  /** Omission preserves the legacy effort-only profile, which cannot be disabled. */
  toggle?: ThinkingToggle;
}
export interface ThinkingControls {
  toggle: "supported" | "required" | "unknown";
  efforts: EffortLevel[];
  /** This adapter cannot encode an explicit effort alongside disabled thinking. */
  effortRequiresThinking?: boolean;
}
export interface ThinkingProbeInput extends DiscoverProviderModels {
  model: string;
  protocol?: ProviderProtocol;
  format: ThinkingFormat;
}
export interface ThinkingProbeResult {
  format: ThinkingFormat;
  checkedAt: number;
  requests: number;
  rows: {
    option:
      | "baseline"
      | "enabled"
      | "disabled"
      | "invalid-toggle"
      | "invalid-effort"
      | "none"
      | EffortLevel;
    status: "accepted" | "rejected" | "inconclusive";
    detail: string;
    observedThinking?: boolean;
  }[];
}

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
  thinkingLevels?: ThinkingLevel[];
  thinkingFormat?: ThinkingFormat;
  thinkingToggle?: ThinkingToggle;
  thinkingControls?: ThinkingControls;
  /** Present only for a manually configured model at this endpoint. */
  thinking?: ModelThinkingSettings;
  thinkingSource?: ContextWindowSource;
}

export interface ProviderSettings {
  id: string;
  name: string;
  baseUrl: string;
  /** Provider-local model ID, without Panel's provider prefix. */
  model: string;
  apiKeyConfigured: boolean;
  supportsContextWindow?: boolean;
  thinkingFormats?: ThinkingFormat[];
  supportsThinkingProbe?: boolean;
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
  /** Null restores built-in capabilities; omission retains this model's override. */
  thinking?: ModelThinkingSettings | null;
}

export interface DiscoverProviderModels {
  baseUrl: string;
  apiKey?: string;
}

export interface ProviderModelCatalog {
  models: ProviderModel[];
  truncated: boolean;
}
