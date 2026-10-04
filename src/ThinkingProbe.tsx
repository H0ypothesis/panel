import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  FlaskConical,
  LoaderCircle,
  ArrowUpRight,
} from "lucide-react";
import {
  effortLevels,
  type ModelThinkingSettings,
  type ThinkingFormat,
  type ThinkingProbeInput,
  type ThinkingProbeResult,
} from "../shared/provider-settings";

export const thinkingFormatLabels: Record<ThinkingFormat, string> = {
  "reasoning-effort": "reasoning_effort / Responses",
  "reasoning-object": "reasoning.effort",
  "anthropic-effort": "output_config.effort",
  none: "不发送 effort",
};

export function ThinkingProbe({
  providerId,
  input,
  formats,
  disabled,
  onApply,
  onBusy,
}: {
  providerId: string;
  input: ThinkingProbeInput;
  formats: ThinkingFormat[];
  disabled: boolean;
  onApply: (value: ModelThinkingSettings) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [format, setFormat] = useState(input.format);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ThinkingProbeResult>();
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setFormat(input.format);
  }, [input.format]);
  useEffect(() => {
    setResult(undefined);
    setError("");
    setBusy(false);
    return () => {
      controller.current?.abort();
      controller.current = null;
      onBusy(false);
    };
  }, [
    providerId,
    input.baseUrl,
    input.apiKey,
    input.model,
    input.protocol,
    format,
    onBusy,
  ]);

  async function detect() {
    if (controller.current || disabled) return;
    const active = new AbortController();
    controller.current = active;
    setBusy(true);
    onBusy(true);
    setError("");
    setResult(undefined);
    try {
      const response = await fetch(
        `/api/model-providers/${encodeURIComponent(providerId)}/thinking-probe`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...input, format }),
          signal: active.signal,
        },
      );
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "检测失败，请重试。");
      if (!active.signal.aborted) setResult(value as ThinkingProbeResult);
    } catch (reason) {
      if (!active.signal.aborted)
        setError(
          reason instanceof Error ? reason.message : "检测失败，请重试。",
        );
    } finally {
      if (controller.current === active) {
        controller.current = null;
        setBusy(false);
        onBusy(false);
      }
    }
  }
  function cancel() {
    controller.current?.abort();
    controller.current = null;
    setBusy(false);
    onBusy(false);
    setError("检测已取消，结果未保存。");
  }
  const status = (option: string) =>
    result?.rows.find((row) => row.option === option)?.status;
  const verifiedEffort = status("invalid-effort") === "rejected";
  const levels = verifiedEffort
    ? effortLevels.filter((level) => status(level) === "accepted")
    : [];
  const verifiedToggle =
    status("invalid-toggle") === "rejected" &&
    status("enabled") === "accepted" &&
    status("disabled") === "accepted";
  const suggestion: ModelThinkingSettings | undefined =
    verifiedToggle || levels.length
      ? {
          format: levels.length ? result!.format : "none",
          levels,
          toggle: verifiedToggle
            ? "thinking-type"
            : verifiedEffort && status("none") === "accepted"
              ? "effort-none"
              : "none",
        }
      : undefined;
  const names: Record<string, string> = {
    baseline: "无参数基线",
    enabled: "thinking.type = enabled",
    disabled: "thinking.type = disabled",
    "invalid-toggle": "开关无效值对照",
    "invalid-effort": "effort 无效值对照",
    none: "effort = none",
  };
  return (
    <section className="thinking-probe" aria-label="检测思考选项">
      <details className="thinking-probe-disclosure">
        <summary>
          <FlaskConical size={15} />
          <span>
            兼容性检测
            <small>
              {busy
                ? "正在检测当前模型…"
                : result
                  ? "检测完成，结果尚未保存"
                  : "用短测试确认可用选项"}
            </small>
          </span>
          <ChevronDown size={14} />
        </summary>
        <div className="thinking-probe-body">
          <label className="form-label">
            检测参数格式
            <select
              aria-label="检测参数格式"
              value={format}
              disabled={disabled || busy}
              onChange={(event) =>
                setFormat(event.target.value as ThinkingFormat)
              }
            >
              {formats.map((item) => (
                <option key={item} value={item}>
                  {thinkingFormatLabels[item]}
                </option>
              ))}
            </select>
          </label>
          <p className="provider-field-hint">
            最多 12 次短调用，按服务商计费。仅发送固定测试，不发送对话内容。
          </p>
          <div className="thinking-probe-actions">
            <button
              type="button"
              className="thinking-probe-run"
              title="使用当前地址、密钥和模型检测；每次最多 256 输出 tokens，整体最多两分钟，可随时停止。"
              disabled={disabled || busy}
              onClick={() => void detect()}
            >
              {busy ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <FlaskConical size={13} />
              )}
              {busy ? "正在检测…" : result ? "重新检测" : "开始检测"}
            </button>
            {busy && (
              <button
                type="button"
                className="thinking-probe-stop"
                onClick={cancel}
              >
                停止检测
              </button>
            )}
          </div>
          {error && (
            <p role="status" className="thinking-probe-message">
              {error}
            </p>
          )}
          {result && (
            <div className="thinking-probe-results" aria-live="polite">
              <div className="thinking-probe-result-heading">
                <strong>检测完成</strong>
                <span>{result.requests} 次调用</span>
              </div>
              {(status("invalid-toggle") === "accepted" ||
                status("invalid-effort") === "accepted") && (
                <p className="thinking-probe-warning">
                  无效值也被接受：网关可能忽略该字段，该字段的选项不会自动填入。
                </p>
              )}
              <details className="thinking-probe-detail">
                <summary>
                  查看 {result.rows.length} 项检测明细
                  <ChevronDown size={12} />
                </summary>
                <table>
                  <thead>
                    <tr>
                      <th>选项</th>
                      <th>结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row) => (
                      <tr key={row.option}>
                        <td>{names[row.option] ?? `effort = ${row.option}`}</td>
                        <td title={row.detail}>
                          <span
                            className={`probe-status probe-status-${row.status}`}
                          >
                            {row.status === "accepted"
                              ? "请求接受"
                              : row.status === "rejected"
                                ? "请求拒绝"
                                : "未确认"}
                          </span>
                          {row.observedThinking ? (
                            <small>有思考输出</small>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
              {suggestion && (
                <button
                  type="button"
                  className="thinking-probe-apply"
                  disabled={disabled}
                  onClick={() => onApply(suggestion)}
                >
                  填入可用选项 <ArrowUpRight size={13} />
                </button>
              )}
              <p className="provider-field-hint">
                填入后需保存配置。接受参数不代表强度差异；没有思考输出也不代表思考已关闭。
              </p>
            </div>
          )}
        </div>
      </details>
    </section>
  );
}
