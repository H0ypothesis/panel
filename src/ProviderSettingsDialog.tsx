import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Save,
} from "lucide-react";
import type { ModelOption } from "../shared/types";
import type { ProviderSettings } from "../shared/provider-settings";
import { api } from "./api";
import "./provider-settings.css";

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
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

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
    if (!settings || pending.current) return;
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
      <button
        type="button"
        className="provider-settings-back"
        onClick={onClose}
        disabled={busy}
      >
        <ArrowLeft size={15} /> 返回模型连接
      </button>
      <div className="modal-illustration">
        <KeyRound size={24} />
      </div>
      <h2 id="provider-settings-title">配置 {providerName}</h2>
      <p className="modal-intro" id="provider-settings-description">
        填写服务商提供的接口信息，保存后即可在对话中选择模型。
      </p>
      {loading ? (
        <p className="provider-settings-loading" role="status">
          <LoaderCircle className="spin" size={17} /> 正在读取配置…
        </p>
      ) : settings ? (
        <form onSubmit={submit} aria-busy={busy}>
          <fieldset disabled={busy}>
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
                onChange={(event) => setBaseUrl(event.target.value)}
                aria-describedby="provider-url-hint"
              />
            </label>
            <p className="provider-field-hint" id="provider-url-hint">
              填写 API 基础地址，不包含具体请求路径（如 /chat/completions）。
            </p>
            <label
              className="form-label provider-key-label"
              htmlFor="provider-api-key"
            >
              API Key{" "}
              <span>
                {settings.apiKeyConfigured ? "已设置 · 留空保留原密钥" : "必填"}
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
            <label className="form-label" htmlFor="provider-model">
              Model
              <input
                id="provider-model"
                required
                maxLength={240}
                autoComplete="off"
                spellCheck={false}
                list="provider-model-options"
                value={model}
                placeholder="选择或输入模型 ID"
                onChange={(event) => setModel(event.target.value)}
                aria-describedby="provider-model-hint"
              />
              <datalist id="provider-model-options">
                {settings.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </datalist>
            </label>
            <p className="provider-field-hint" id="provider-model-hint">
              可选择已有模型，或输入服务商提供的完整模型 ID。
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
          </fieldset>
          <p className="provider-settings-privacy">
            密钥仅保存在本机服务中，不写入浏览器存储，也不会随探索导出。
          </p>
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
          <div className="provider-settings-actions">
            <button
              type="button"
              className="provider-settings-cancel"
              disabled={busy}
              onClick={onClose}
            >
              取消
            </button>
            <button type="submit" className="primary-button" disabled={busy}>
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
