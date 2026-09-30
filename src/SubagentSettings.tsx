import { useEffect, useId, useState } from "react";
import {
  DEFAULT_SUBAGENT_CONCURRENCY,
  MAX_SUBAGENT_BATCH_SIZE,
  validSubagentConcurrency,
  type SubagentSettings as Settings,
} from "../shared/subagent-settings";
import type { SubagentCatalog } from "../shared/subagent-profiles";
import { api } from "./api";
import "./subagent-settings.css";

export function SubagentSettings({ workspaceId }: { workspaceId?: string }) {
  const id = useId();
  const [catalog, setCatalog] = useState<SubagentCatalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setCatalog(null);
    setCatalogError("");
    void api<SubagentCatalog>(
      `/subagent-profiles${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ""}`,
    )
      .then((value) => {
        if (active) setCatalog(value);
      })
      .catch((error) => {
        if (active) setCatalogError(error.message);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, refresh]);
  const [nativeOptions, setNativeOptions] =
    useState<Settings["nativeOptions"]>();
  const [saved, setSaved] = useState<number | null>(null);
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void api<Settings>("/subagent-settings")
      .then((settings) => {
        if (!validSubagentConcurrency(settings.maxConcurrentSubagents))
          throw new Error("无法读取子代理并发设置，请更新并重启服务。");
        if (!active) return;
        setSaved(settings.maxConcurrentSubagents);
        setNativeOptions(settings.nativeOptions);
        setValue(String(settings.maxConcurrentSubagents));
      })
      .catch((error) => {
        if (active)
          setError(error instanceof Error ? error.message : "读取设置失败。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  const valid = value.trim() !== "" && validSubagentConcurrency(Number(value));
  return (
    <section
      className="web-settings subagent-settings"
      aria-label="Subagents 设置"
    >
      <h3>Subagents 子代理</h3>
      <p>
        限制每次委派任务同时运行的子代理数，包含嵌套子任务；超出后排队。保存后对新一轮任务生效。
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (!valid || saving || loading || saved === null) return;
          setSaving(true);
          setError("");
          setMessage("");
          try {
            const settings = await api<Settings>(
              "/subagent-settings",
              {
                maxConcurrentSubagents: Number(value),
                ...(nativeOptions === undefined ? {} : { nativeOptions }),
              },
              "PUT",
            );
            setSaved(settings.maxConcurrentSubagents);
            setNativeOptions(settings.nativeOptions);
            setValue(String(settings.maxConcurrentSubagents));
            setMessage("已保存，将用于新一轮任务。");
          } catch (error) {
            setError(error instanceof Error ? error.message : "保存设置失败。");
          } finally {
            setSaving(false);
          }
        }}
      >
        <label htmlFor={id}>最大并发子代理数</label>
        <div className="subagent-settings-controls">
          <input
            id={id}
            type="number"
            min={1}
            max={MAX_SUBAGENT_BATCH_SIZE}
            step={1}
            required
            value={value}
            disabled={loading || saving || saved === null}
            aria-describedby={`${id}-hint`}
            aria-invalid={!loading && saved !== null && !valid}
            onChange={(event) => {
              setValue(event.target.value);
              setMessage("");
              setError("");
            }}
          />
          <button
            type="submit"
            disabled={
              loading ||
              saving ||
              saved === null ||
              !valid ||
              Number(value) === saved
            }
          >
            {saving ? "保存中…" : "保存"}
          </button>
          <button
            type="button"
            disabled={
              loading ||
              saving ||
              saved === null ||
              Number(value) === DEFAULT_SUBAGENT_CONCURRENCY
            }
            onClick={() => {
              setValue(String(DEFAULT_SUBAGENT_CONCURRENCY));
              setMessage("");
              setError("");
            }}
          >
            恢复默认
          </button>
        </div>
        <p id={`${id}-hint`} className="subagent-settings-hint">
          默认 {DEFAULT_SUBAGENT_CONCURRENCY} 个；可设为 1–
          {MAX_SUBAGENT_BATCH_SIZE}，与单批任务上限一致。主代理不计入。
        </p>
        {loading && <p role="status">读取设置中…</p>}
        {message && <p role="status">{message}</p>}
        {error && <p role="alert">{error}</p>}
        {!loading && saved === null && (
          <button type="button" onClick={() => setAttempt(attempt + 1)}>
            重新读取
          </button>
        )}
      </form>
      <div className="subagent-catalog">
        <div className="subagent-catalog-heading">
          <h4>原生角色</h4>
          <button type="button" onClick={() => setRefresh(refresh + 1)}>
            重新读取角色
          </button>
        </div>
        <p>
          读取插件内置、用户和当前项目的角色。编辑 ~/.pi/agent/agents/*.md
          或项目 .pi/agents/*.md 后重新读取；同名项目角色优先。
        </p>
        {!catalog && !catalogError && <p role="status">读取原生角色中…</p>}
        {catalogError && <p role="alert">{catalogError}</p>}
        {catalog?.diagnostics.map((diagnostic) => (
          <p role="alert" key={diagnostic.filePath}>
            {diagnostic.filePath}：{diagnostic.error}
          </p>
        ))}
        {[...(catalog?.profiles ?? [])]
          .sort(
            (a, b) =>
              Number(a.diagnostics.length > 0) -
              Number(b.diagnostics.length > 0),
          )
          .map((profile) => (
            <details key={profile.name}>
              <summary>
                <strong>{profile.name}</strong>
                <span>
                  {profile.source}
                  {profile.diagnostics.length ? " · 需要适配" : ""}
                </span>
              </summary>
              <p>{profile.description}</p>
              <dl>
                <dt>配置文件</dt>
                <dd>{profile.filePath}</dd>
                <dt>模型 / 思考</dt>
                <dd>
                  {profile.model ?? "继承本轮模型"} /{" "}
                  {String(profile.thinking ?? "继承本轮思考强度")}
                </dd>
                <dt>工具</dt>
                <dd>
                  {profile.tools?.join(", ") ?? "Pi 默认工具"}
                  {profile.excludeTools?.length
                    ? `；排除 ${profile.excludeTools.join(", ")}`
                    : ""}
                </dd>
                <dt>技能 / 扩展</dt>
                <dd>
                  {[
                    ...(profile.skills ?? []),
                    ...(profile.extensions ?? []),
                  ].join(", ") || "未单独指定"}
                </dd>
                <dt>指令继承</dt>
                <dd>
                  {profile.systemPromptMode} · 项目{" "}
                  {profile.inheritProjectContext ? "开" : "关"} · 全局{" "}
                  {profile.inheritGlobalContext ? "开" : "关"} · 技能目录{" "}
                  {profile.inheritSkills ? "开" : "关"}
                </dd>
              </dl>
              {profile.diagnostics.map((issue) => (
                <p role="status" key={issue}>
                  {issue}
                </p>
              ))}
            </details>
          ))}
        <p>
          扩展提供的工具会在启动时校验，缺失时明确报错。子代理的工具调用沿用当前卡片的审批设置。
        </p>
      </div>
    </section>
  );
}
