import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ProviderStreams,
  type StreamOptions,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  effortLevels,
  type ModelThinkingSettings,
  type ThinkingFormat,
  type ThinkingControls,
} from "../shared/provider-settings.ts";
import type { RunConfig } from "../shared/types.ts";
import { thinkingConflict } from "../shared/thinking-controls.ts";

const configuredProfiles = new WeakMap<object, ModelThinkingSettings>();
export function registerThinkingProfile(
  model: Model<Api>,
  profile: ModelThinkingSettings,
) {
  configuredProfiles.set(model, profile);
}
export function modelThinkingProfile(
  model: Model<Api>,
): ModelThinkingSettings | undefined {
  const configured = configuredProfiles.get(model);
  if (configured) return configured;
  if (model.provider === "xiaomi-token-plan-cn")
    return { format: "none", levels: [], toggle: "thinking-type" };
  if (model.provider === "paperbypass") {
    if (["z-ai/glm-5.3", "z-ai/glm-5.3-flash"].includes(model.id))
      return {
        format: "reasoning-effort",
        levels: ["low", "high", "max"],
        toggle: "required",
      };
    if (model.id === "anthropic/claude-opus-5.5")
      return {
        format: "anthropic-effort",
        levels: ["low", "medium", "high", "xhigh", "max"],
        toggle: "required",
      };
  }
  return undefined;
}
export function modelThinkingControls(model: Model<Api>): ThinkingControls {
  const profile = modelThinkingProfile(model);
  if (profile)
    return {
      toggle:
        profile.toggle === "thinking-type" || profile.toggle === "effort-none"
          ? "supported"
          : profile.toggle === "none"
            ? "unknown"
            : "required",
      efforts: profile.format === "none" ? [] : profile.levels,
      ...(profile.toggle === "effort-none"
        ? { effortRequiresThinking: true }
        : {}),
    };
  const levels = getSupportedThinkingLevels(model);
  return {
    toggle: !model.reasoning
      ? "unknown"
      : levels.includes("off")
        ? "supported"
        : "required",
    efforts: effortLevels.filter((level) => levels.includes(level)),
    ...(model.reasoning && !nativeIndependentEffortFormat(model)
      ? { effortRequiresThinking: true }
      : {}),
  };
}

function nativeIndependentEffortFormat(
  model: Model<Api>,
): ThinkingFormat | undefined {
  if (
    model.api === "anthropic-messages" &&
    (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking ===
      true
  )
    return "anthropic-effort";
  if (
    model.api === "openai-completions" &&
    (model as Model<"openai-completions">).compat?.supportsReasoningEffort ===
      true &&
    ["zai", "deepseek", "qwen", "together"].includes(
      (model as Model<"openai-completions">).compat?.thinkingFormat ?? "",
    )
  )
    return "reasoning-effort";
}

export function thinkingFormats(provider: string): ThinkingFormat[] {
  if (["paperbypass", "atria"].includes(provider))
    return ["reasoning-effort", "anthropic-effort", "reasoning-object", "none"];
  if (provider === "anthropic") return ["anthropic-effort", "none"];
  if (["openai", "xiaomi-token-plan-cn"].includes(provider))
    return ["reasoning-effort", "reasoning-object", "none"];
  return [];
}

export function validateThinking(
  value: unknown,
  provider: string,
): ModelThinkingSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("思考模式配置无效。");
  const { format, levels, toggle } = value as Record<string, unknown>;
  if (!thinkingFormats(provider).includes(format as ThinkingFormat))
    throw new Error("此服务商不支持该思考参数格式。");
  if (
    !Array.isArray(levels) ||
    (format !== "none" && !levels.length) ||
    levels.some((level) => !effortLevels.includes(level))
  )
    throw new Error("请至少选择一个有效的思考档位。");
  if (
    toggle !== undefined &&
    !["thinking-type", "effort-none", "required", "none"].includes(
      String(toggle),
    )
  )
    throw new Error("思考开关格式无效。");
  if (format === "none" && toggle === "effort-none")
    throw new Error("effort 关闭方式需要启用 effort 参数。");
  return {
    format: format as ThinkingFormat,
    levels:
      format === "none"
        ? []
        : effortLevels.filter((level) => levels.includes(level)),
    ...(toggle !== undefined
      ? { toggle: toggle as ModelThinkingSettings["toggle"] }
      : {}),
  };
}

export function thinkingCapabilities(settings: ModelThinkingSettings) {
  const levels = settings.format === "none" ? ["high"] : settings.levels;
  return {
    reasoning: true,
    thinkingLevelMap: Object.fromEntries(
      ["off", ...effortLevels].map((level) => [
        level,
        (level === "off" &&
          ["thinking-type", "effort-none", "none"].includes(
            settings.toggle ?? "required",
          )) ||
        levels.includes(level as (typeof effortLevels)[number])
          ? level
          : null,
      ]),
    ) as Model<Api>["thinkingLevelMap"],
  };
}

/** Shared by real runs and probes, so accepted probe parameters match saved requests. */
export function setEffort(
  payload: Record<string, unknown>,
  format: ThinkingFormat,
  api: string,
  effort?: string,
) {
  delete payload.reasoning_effort;
  for (const field of ["reasoning", "output_config"]) {
    const current = payload[field];
    if (current && typeof current === "object") {
      const copy = { ...current } as Record<string, unknown>;
      delete copy.effort;
      if (Object.keys(copy).length) payload[field] = copy;
      else delete payload[field];
    }
  }
  if (!effort || format === "none") return;
  if (format === "anthropic-effort")
    payload.output_config = { ...(payload.output_config as object), effort };
  else if (format === "reasoning-object" || api === "openai-responses")
    payload.reasoning = { ...(payload.reasoning as object), effort };
  else payload.reasoning_effort = effort;
}

export function runThinkingOptions(
  model: Model<Api>,
  config: RunConfig,
  options?: SimpleStreamOptions,
): SimpleStreamOptions | undefined {
  if (config.thinkingMode === undefined && config.effort === undefined)
    return options;
  const control = modelThinkingControls(model);
  const profile = modelThinkingProfile(model);
  const format =
    profile?.format ??
    (model.api === "anthropic-messages"
      ? "anthropic-effort"
      : model.baseUrl.includes("openrouter.ai")
        ? "reasoning-object"
        : "reasoning-effort");
  if (
    config.thinkingMode !== undefined &&
    !["default", "enabled", "disabled"].includes(config.thinkingMode)
  )
    throw new Error("思考开关值无效。");
  if (config.thinkingMode === "enabled" && control.toggle === "unknown")
    throw new Error("请先在模型设置中配置思考开关。");
  if (config.thinkingMode === "disabled" && control.toggle !== "supported")
    throw new Error("此模型尚不支持显式关闭思考。");
  if (
    config.effort !== undefined &&
    config.effort !== "default" &&
    !control.efforts.includes(config.effort)
  )
    throw new Error("此模型不支持所选 effort。");
  const conflict = thinkingConflict(config, control);
  if (conflict) throw new Error(conflict);
  const reasoning =
    config.effort && config.effort !== "default"
      ? config.effort
      : config.thinkingMode === "enabled" && config.thinking === "off"
        ? (getSupportedThinkingLevels(model).find((level) => level !== "off") ??
          "off")
        : config.thinking;
  return {
    ...options,
    reasoning:
      config.thinkingMode === "disabled" || reasoning === "off"
        ? undefined
        : reasoning,
    onPayload: async (payload, requestModel) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new Error("模型请求格式无效。");
      const adapted: Record<string, unknown> = { ...payload };
      if (config.thinkingMode === "default") {
        delete adapted.thinking;
        if (profile || !config.effort || config.effort === "default")
          setEffort(adapted, format, model.api);
      }
      if (
        profile?.toggle === "thinking-type" &&
        config.thinkingMode &&
        config.thinkingMode !== "default"
      )
        adapted.thinking = {
          type: config.thinkingMode === "disabled" ? "disabled" : "enabled",
        };
      if (profile) {
        setEffort(
          adapted,
          format,
          model.api,
          profile.toggle === "effort-none" && config.thinkingMode === "disabled"
            ? "none"
            : config.effort && config.effort !== "default"
              ? config.effort
              : profile.toggle === "effort-none" &&
                  config.thinkingMode === "enabled"
                ? profile.levels[0]
                : undefined,
        );
      } else if (
        config.thinkingMode === "disabled" &&
        config.effort &&
        config.effort !== "default"
      ) {
        // Keep the SDK's native off encoding and map only the independent effort.
        const mapped = model.thinkingLevelMap?.[config.effort];
        const effort =
          typeof mapped === "string"
            ? mapped
            : format === "anthropic-effort" && config.effort === "minimal"
              ? "low"
              : config.effort;
        setEffort(
          adapted,
          nativeIndependentEffortFormat(model)!,
          model.api,
          effort,
        );
      }
      const replacement = await options?.onPayload?.(adapted, requestModel);
      return replacement === undefined ? adapted : replacement;
    },
  };
}

/** Explicit gateway effort controls must not acquire Claude's token budgets. */
export function effortApi(
  underlying: ProviderStreams,
  resolve: (model: Model<Api>) => ModelThinkingSettings | undefined,
): ProviderStreams {
  function optionsFor(
    model: Model<Api>,
    settings: ModelThinkingSettings,
    effort: string,
    options?: StreamOptions,
  ): StreamOptions {
    return {
      ...options,
      onPayload: async (payload) => {
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
          throw new Error("思考参数请求格式无效。");
        const adapted: Record<string, unknown> = { ...payload };
        delete adapted.thinking;
        if (settings.toggle === "thinking-type")
          adapted.thinking = {
            type: effort === "off" ? "disabled" : "enabled",
          };
        setEffort(
          adapted,
          settings.format,
          model.api,
          effort === "off"
            ? settings.toggle === "effort-none"
              ? "none"
              : undefined
            : effort,
        );
        const replacement = await options?.onPayload?.(adapted, model);
        return replacement === undefined ? adapted : replacement;
      },
    };
  }
  function transportModel(model: Model<Api>): Model<Api> {
    return {
      ...model,
      reasoning: false,
      ...(model.api === "anthropic-messages" ? { compat: undefined } : {}),
    };
  }
  return {
    stream(model, context, options) {
      const settings = resolve(model);
      if (!settings) return underlying.stream(model, context, options);
      const requested = options as
        | (StreamOptions & { effort?: string; reasoningEffort?: string })
        | undefined;
      const effort = clampThinkingLevel(
        model,
        (requested?.effort ??
          requested?.reasoningEffort ??
          settings.levels[0] ??
          "high") as Parameters<typeof clampThinkingLevel>[1],
      );
      return underlying.stream(
        transportModel(model),
        context,
        optionsFor(model, settings, effort, options),
      );
    },
    streamSimple(model, context, options) {
      const settings = resolve(model);
      if (!settings) return underlying.streamSimple(model, context, options);
      const effort = clampThinkingLevel(model, options?.reasoning ?? "off");
      return underlying.streamSimple(transportModel(model), context, {
        ...options,
        ...optionsFor(model, settings, effort, options),
        reasoning: undefined,
      });
    },
  };
}
