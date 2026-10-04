import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Save,
  RefreshCw,
  LockKeyhole,
  SlidersHorizontal,
} from "lucide-react";
import type { ModelOption } from "../shared/types";
import type {
  ProviderSettings,
  ProviderModelCatalog,
  ModelThinkingSettings,
  ThinkingFormat,
} from "../shared/provider-settings";
import {
  MAX_CONTEXT_WINDOW,
  validContextWindow,
  effortLevels,
} from "../shared/provider-settings";
import { api } from "./api";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { ThinkingProbe, thinkingFormatLabels } from "./ThinkingProbe";
import "./provider-settings.css";

const CONTEXT_PRESETS = [
  { label: "128K", value: 128_000 },
  { label: "256K", value: 256_000 },
  { label: "512K", value: 512_000 },
  { label: "1M", value: 1_000_000 },
];

export function ProviderSettingsDialog({
  providerId,
  providerName,
  onClose,
  onSaved,
}: {
  providerId: string;
  providerName: string;
  onClose: () => void;
  onSaved: (models: ModelOption[]) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const contextInput = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [protocol, setProtocol] = useState<
    "auto" | "openai-completions" | "openai-responses"
  >("auto");
  const [visibleKey, setVisibleKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [probeBusy, setProbeBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [catalog, setCatalog] = useState<ProviderModelCatalog | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [contextOverride, setContextOverride] = useState<string | null>(null);
  const [thinkingOverride, setThinkingOverride] = useState<
    ModelThinkingSettings | null | undefined
  >(undefined);
  const normalizedUrl = baseUrl.trim().replace(/\/+$/, "");
  const unchangedUrl = normalizedUrl === settings?.baseUrl.replace(/\/+$/, "");
  let validUrl = false;
  try {
    const url = new URL(normalizedUrl);
    validUrl =
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash;
  } catch {
    /* Wait until the user has entered a URL. */
  }
  const canDiscover =
    validUrl &&
    Boolean(apiKey.trim() || (settings?.apiKeyConfigured && unchangedUrl));
  const catalogModel = catalog?.models.find((item) => item.id === model.trim());
  const savedModel = unchangedUrl
    ? settings?.models.find((item) => item.id === model.trim())
    : undefined;
  const savedContext =
    savedModel?.contextWindowSource !== "fallback"
      ? savedModel?.contextWindow
      : undefined;
  const suggestedContext =
    savedModel?.contextWindowSource === "configured"
      ? savedContext
      : (catalogModel?.contextWindow ?? savedContext);
  const contextValue = contextOverride ?? suggestedContext?.toString() ?? "";
  const thinkingValue =
    thinkingOverride === undefined ? savedModel?.thinking : thinkingOverride;

  useEffect(() => {
    setCatalog(null);
    setCatalogError("");
    setCatalogBusy(false);
    if (loading || !settings || !canDiscover) return;
    const controller = new AbortController();
    setCatalogBusy(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(
            `/api/model-providers/${encodeURIComponent(providerId)}/models`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                baseUrl: normalizedUrl,
                ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
              }),
              signal: controller.signal,
            },
          );
          if (response.status === 404)
            throw new Error("当前服务不支持获取模型列表，请更新并重启 Panel。");
          const result = await response.json();
          if (!response.ok)
            throw new Error(
              result.error || "获取模型列表失败，可手动填写 Model ID。",
            );
          if (!controller.signal.aborted)
            setCatalog(result as ProviderModelCatalog);
        } catch (reason) {
          if (!controller.signal.aborted)
            setCatalogError(
              reason instanceof Error
                ? reason.message
                : "获取失败，可手动填写 Model ID。",
            );
        } finally {
          if (!controller.signal.aborted) setCatalogBusy(false);
        }
      })();
    }, 650);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    loading,
    settings,
    providerId,
    normalizedUrl,
    apiKey,
    canDiscover,
    catalogAttempt,
  ]);

  useEffect(() => {
    mounted.current = true;
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      mounted.current = false;
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    void api<ProviderSettings[]>("/model-providers")
      .then((providers) => {
        if (!current) return;
        const provider = providers.find((item) => item.id === providerId);
        if (!provider) throw new Error("找不到此供应商的配置，请关闭后重试。");
        setSettings(provider);
        setBaseUrl(provider.baseUrl);
        setModel(provider.model);
        setProtocol(provider.protocol ?? "auto");
      })
      .catch((reason) => {
        if (current)
          setError(
            reason instanceof Error ? reason.message : "无法读取配置，请重试。",
          );
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [providerId, attempt]);

  useEffect(() => {
    if (!loading && settings) urlInput.current?.focus();
  }, [loading, settings]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings || pending.current || probeBusy) return;
    if (
      !baseUrl.trim() ||
      !model.trim() ||
      (!settings.apiKeyConfigured && !apiKey.trim())
    ) {
      setError("请填写 API URL、API Key 和 Model。");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const contextWindow =
        contextOverride !== null
          ? contextOverride.trim()
            ? Number(contextOverride)
            : null
          : savedModel?.contextWindowSource !== "configured"
            ? catalogModel?.contextWindow
            : undefined;
      if (
        contextWindow !== undefined &&
        contextWindow !== null &&
        !validContextWindow(contextWindow)
      )
        throw new Error(
          "上下文长度必须是 1024 到 100000000 之间的整数（tokens）。",
        );
      if (contextWindow !== undefined && !settings.supportsContextWindow)
        throw new Error("当前服务不支持设置上下文长度，请更新并重启 Panel。");
      if (thinkingOverride !== undefined && !settings.thinkingFormats?.length)
        throw new Error("当前服务不支持设置思考档位，请更新并重启 Panel。");
      if (
        thinkingOverride &&
        thinkingOverride.format !== "none" &&
        !thinkingOverride.levels.length
      )
        throw new Error("请至少选择一个思考档位。");
      const result = await api<{
        provider: ProviderSettings;
        models: ModelOption[];
      }>(
        `/model-providers/${encodeURIComponent(providerId)}`,
        {
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          ...(providerId === "openai" ? { protocol } : {}),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(thinkingOverride !== undefined
            ? { thinking: thinkingOverride }
            : {}),
        },
        "PUT",
      );
      if (mounted.current) {
        setApiKey("");
        onSaved(result.models);
      }
    } catch (reason) {
      if (mounted.current)
        setError(
          reason instanceof Error ? reason.message : "保存失败，请重试。",
        );
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="modal provider-settings-dialog"
      aria-labelledby="provider-settings-title"
      aria-describedby="provider-settings-description"
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending.current) onClose();
      }}
    >
      <header className="provider-settings-header">
        <button
          type="button"
          className="provider-settings-back"
          onClick={onClose}
          disabled={busy}
        >
          <ArrowLeft size={15} /> 返回模型连接
        </button>
        <div className="provider-settings-heading">
          <div className="modal-illustration">
            <SlidersHorizontal size={20} />
          </div>
          <div>
            <h2 id="provider-settings-title">配置 {providerName}</h2>
            <p className="modal-intro" id="provider-settings-description">
              连接模型，设置对话中可用的思考选项。
            </p>
          </div>
        </div>
      </header>
      {loading ? (
        <p className="provider-settings-loading" role="status">
          <LoaderCircle className="spin" size={17} /> 正在读取配置…
        </p>
      ) : settings ? (
        <form onSubmit={submit} aria-busy={busy}>
          <div className="provider-settings-content">
            <fieldset disabled={busy}>
              <section className="provider-form-section" aria-label="连接设置">
                <h3>
                  <KeyRound size={14} /> 连接
                </h3>
                <label className="form-label" htmlFor="provider-base-url">
                  API URL
                  <input
                    ref={urlInput}
                    id="provider-base-url"
                    type="url"
                    required
                    maxLength={2048}
                    autoComplete="off"
                    spellCheck={false}
                    value={baseUrl}
                    placeholder="https://api.example.com/v1"
                    onChange={(event) => {
                      setBaseUrl(event.target.value);
                      setContextOverride(null);
                      setThinkingOverride(undefined);
                    }}
                    aria-describedby="provider-url-hint"
                  />
                </label>
                <p className="provider-field-hint" id="provider-url-hint">
                  填写 API 基础地址，不包含具体请求路径（如
                  /chat/completions）。
                </p>
                <label
                  className="form-label provider-key-label"
                  htmlFor="provider-api-key"
                >
                  API Key{" "}
                  <span>
                    {settings.apiKeyConfigured
                      ? "已设置 · 留空保留原密钥"
                      : "必填"}
                  </span>
                  <span className="provider-key-input">
                    <input
                      id="provider-api-key"
                      type={visibleKey ? "text" : "password"}
                      required={!settings.apiKeyConfigured}
                      maxLength={8192}
                      autoComplete="new-password"
                      spellCheck={false}
                      autoCapitalize="none"
                      value={apiKey}
                      placeholder={
                        settings.apiKeyConfigured
                          ? "输入新密钥以替换"
                          : "输入 API Key"
                      }
                      onChange={(event) => setApiKey(event.target.value)}
                    />
                    <button
                      type="button"
                      aria-label={visibleKey ? "隐藏 API Key" : "显示 API Key"}
                      aria-pressed={visibleKey}
                      onClick={() => setVisibleKey(!visibleKey)}
                    >
                      {visibleKey ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </span>
                </label>
              </section>
              <section className="provider-form-section" aria-label="模型设置">
                <h3>模型</h3>
                <div className="form-label">
                  <div className="provider-model-label">
                    <label htmlFor="provider-model">Model</label>
                    <button
                      type="button"
                      className="provider-model-refresh"
                      aria-label="刷新模型列表"
                      title="刷新模型列表"
                      disabled={!canDiscover || catalogBusy}
                      onClick={() => setCatalogAttempt((value) => value + 1)}
                    >
                      {catalogBusy ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <RefreshCw size={14} />
                      )}
                    </button>
                  </div>
                  <ProviderModelPicker
                    disabled={busy}
                    value={model}
                    onChange={(value) => {
                      setModel(value);
                      setContextOverride(null);
                      setThinkingOverride(undefined);
                    }}
                    models={
                      catalog?.models ?? (unchangedUrl ? settings.models : [])
                    }
                  />
                </div>
                <p
                  className="provider-field-hint"
                  id="provider-model-hint"
                  role="status"
                >
                  {catalogBusy
                    ? "正在获取模型列表…"
                    : catalogError ||
                      (catalog
                        ? `已获取 ${catalog.models.length} 个模型${catalog.truncated ? "（部分结果）" : ""}${catalog.models.length ? "" : "，可手动填写 Model ID"}`
                        : !unchangedUrl &&
                            settings.apiKeyConfigured &&
                            !apiKey.trim()
                          ? "地址已改变，请填写对应的 API Key。"
                          : "可手动填写完整 Model ID。")}
                </p>
                <div className="form-label">
                  <label htmlFor="provider-context-window">
                    上下文长度（tokens）
                  </label>
                  <div className="provider-context-inputs">
                    <select
                      id="provider-context-preset"
                      aria-label="上下文长度预设"
                      value={
                        CONTEXT_PRESETS.some(
                          (preset) => preset.value === Number(contextValue),
                        )
                          ? Number(contextValue).toString()
                          : "custom"
                      }
                      onChange={(event) => {
                        const value = event.target.value;
                        setContextOverride(value === "custom" ? "" : value);
                        if (value === "custom") contextInput.current?.focus();
                      }}
                    >
                      <option value="custom">自定义</option>
                      {CONTEXT_PRESETS.map((preset) => (
                        <option key={preset.value} value={preset.value}>
                          {preset.label}
                        </option>
                      ))}
                    </select>
                    <input
                      ref={contextInput}
                      id="provider-context-window"
                      type="number"
                      min={1024}
                      max={MAX_CONTEXT_WINDOW}
                      step={1}
                      value={contextValue}
                      placeholder="未知（本地预算 128000）"
                      onChange={(event) =>
                        setContextOverride(event.target.value)
                      }
                      aria-describedby="provider-context-hint"
                    />
                  </div>
                </div>
                <p className="provider-field-hint" id="provider-context-hint">
                  {contextOverride !== null
                    ? contextValue
                      ? "自定义上下文预算"
                      : "保存后恢复默认预算"
                    : savedModel?.contextWindowSource === "configured" &&
                        contextOverride === null
                      ? "已保存的上下文预算"
                      : catalogModel?.contextWindow && contextOverride === null
                        ? "来源：服务商模型目录"
                        : savedContext
                          ? "来源：内置模型目录"
                          : "模型上限未知；当前使用 128,000 tokens 本地兜底预算。"}
                </p>
                {providerId === "openai" && (
                  <label className="form-label" htmlFor="provider-protocol">
                    接口协议
                    <select
                      id="provider-protocol"
                      value={protocol}
                      onChange={(event) =>
                        setProtocol(event.target.value as typeof protocol)
                      }
                    >
                      <option value="auto">
                        自动（内置 Responses / 自定义 Chat Completions）
                      </option>
                      <option value="openai-completions">
                        Chat Completions（兼容接口）
                      </option>
                      <option value="openai-responses">Responses</option>
                    </select>
                  </label>
                )}
              </section>
            </fieldset>
            <div className="provider-capabilities">
              <fieldset disabled={busy}>
                <section
                  className="provider-form-section provider-thinking-section"
                  aria-label="思考能力设置"
                >
                  <h3>
                    <SlidersHorizontal size={14} /> 思考能力
                  </h3>
                  <p className="provider-section-description">
                    决定对话中显示哪些开关和强度。
                  </p>
                  <label
                    className="form-label"
                    htmlFor="provider-thinking-mode"
                  >
                    配置方式
                    <select
                      id="provider-thinking-mode"
                      value={thinkingValue ? "custom" : "auto"}
                      disabled={!settings.thinkingFormats?.length}
                      onChange={(event) =>
                        setThinkingOverride(
                          event.target.value === "auto"
                            ? null
                            : {
                                format:
                                  savedModel?.thinkingFormat ??
                                  settings.thinkingFormats![0],
                                toggle:
                                  savedModel?.thinkingToggle ??
                                  (savedModel?.thinkingControls?.toggle ===
                                  "required"
                                    ? "required"
                                    : "none"),
                                levels:
                                  savedModel?.thinkingFormat === "none"
                                    ? []
                                    : effortLevels.filter((level) =>
                                          savedModel?.thinkingLevels?.includes(
                                            level,
                                          ),
                                        ).length
                                      ? effortLevels.filter((level) =>
                                          savedModel?.thinkingLevels?.includes(
                                            level,
                                          ),
                                        )
                                      : ["low", "medium", "high"],
                              },
                        )
                      }
                      aria-describedby="provider-thinking-hint"
                    >
                      <option value="auto">使用内置能力</option>
                      <option value="custom">自定义此模型</option>
                    </select>
                  </label>
                  {thinkingValue && (
                    <>
                      <label
                        className="form-label"
                        htmlFor="provider-thinking-toggle"
                      >
                        开关控制
                        <select
                          id="provider-thinking-toggle"
                          value={thinkingValue.toggle ?? "required"}
                          onChange={(event) =>
                            setThinkingOverride({
                              ...thinkingValue,
                              toggle: event.target
                                .value as ModelThinkingSettings["toggle"],
                            })
                          }
                        >
                          <option value="none">未确认 / 不发送开关</option>
                          <option value="thinking-type">
                            thinking.type（enabled / disabled）
                          </option>
                          <option
                            value="effort-none"
                            disabled={thinkingValue.format === "none"}
                          >
                            effort = none 关闭
                          </option>
                          <option value="required">模型必须开启思考</option>
                        </select>
                      </label>
                      <label
                        className="form-label"
                        htmlFor="provider-thinking-format"
                      >
                        Effort 参数
                        <select
                          id="provider-thinking-format"
                          value={thinkingValue.format}
                          onChange={(event) =>
                            setThinkingOverride({
                              ...thinkingValue,
                              format: event.target.value as ThinkingFormat,
                              ...(event.target.value === "none"
                                ? {
                                    levels: [],
                                    toggle:
                                      thinkingValue.toggle === "effort-none"
                                        ? "none"
                                        : thinkingValue.toggle,
                                  }
                                : {}),
                            })
                          }
                        >
                          {settings.thinkingFormats?.map((format) => (
                            <option key={format} value={format}>
                              {thinkingFormatLabels[format]}
                            </option>
                          ))}
                        </select>
                      </label>
                      {thinkingValue.format !== "none" && (
                        <div
                          className="provider-thinking-levels"
                          role="group"
                          aria-label="可用思考档位"
                        >
                          {effortLevels.map((level) => (
                            <label key={level}>
                              <input
                                type="checkbox"
                                value={level}
                                checked={thinkingValue.levels.includes(level)}
                                onChange={(event) =>
                                  setThinkingOverride({
                                    ...thinkingValue,
                                    levels: effortLevels.filter((item) =>
                                      item === level
                                        ? event.target.checked
                                        : thinkingValue.levels.includes(item),
                                    ),
                                  })
                                }
                              />
                              <span>{level}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  {!thinkingValue && (
                    <div className="provider-capability-summary">
                      <div>
                        <span>思考开关</span>
                        <strong>
                          {savedModel?.thinkingControls?.toggle === "required"
                            ? "始终开启"
                            : savedModel?.thinkingControls?.toggle ===
                                "supported"
                              ? "可开启 / 关闭"
                              : "服务默认"}
                        </strong>
                      </div>
                      <div>
                        <span>Effort</span>
                        <strong>
                          {(savedModel?.thinkingControls?.efforts ?? []).join(
                            " · ",
                          ) || "默认"}
                        </strong>
                      </div>
                    </div>
                  )}
                  <p
                    className="provider-field-hint"
                    id="provider-thinking-hint"
                  >
                    {thinkingValue
                      ? "仅为此地址下的当前模型保存。按服务商支持的参数格式和档位勾选；配置不会增加模型本身的能力。"
                      : thinkingOverride === null
                        ? "保存后恢复此模型的内置能力。"
                        : savedModel?.thinkingSource === "builtin"
                          ? `内置档位：${savedModel.thinkingLevels?.join(" / ") ?? "off"}`
                          : settings.thinkingFormats?.length
                            ? "尚未识别此模型的思考能力，使用服务默认；可检测或自定义支持的开关和档位。"
                            : "尚未识别此模型的思考能力，使用服务默认；此服务暂未提供自定义配置。"}
                  </p>
                </section>
              </fieldset>
              {settings.supportsThinkingProbe && (
                <ThinkingProbe
                  providerId={providerId}
                  input={{
                    baseUrl: normalizedUrl,
                    model: model.trim(),
                    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
                    ...(providerId === "openai" ? { protocol } : {}),
                    format:
                      thinkingValue?.format ??
                      savedModel?.thinkingFormat ??
                      settings.thinkingFormats![0],
                  }}
                  formats={settings.thinkingFormats ?? []}
                  disabled={busy || !canDiscover || !model.trim()}
                  onApply={setThinkingOverride}
                  onBusy={setProbeBusy}
                />
              )}
            </div>
          </div>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          <div className="provider-settings-actions">
            <p
              className="provider-settings-privacy"
              title="密钥仅保存在本机服务中，不写入浏览器存储，也不会随探索导出。"
            >
              <LockKeyhole size={13} /> 密钥仅保存在本机
            </p>
            <button
              type="button"
              className="provider-settings-cancel"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="submit"
              className="primary-button"
              disabled={busy || probeBusy}
            >
              {busy ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Save size={15} />
              )}
              {busy ? "正在保存…" : "保存配置"}
            </button>
          </div>
        </form>
      ) : (
        <div>
          <div className="inline-error" role="alert">
            {error}
          </div>
          <button
            type="button"
            className="primary-button"
            onClick={() => setAttempt(attempt + 1)}
          >
            重新读取
          </button>
        </div>
      )}
    </dialog>
  );
}
