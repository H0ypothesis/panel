import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  LoaderCircle,
  Monitor,
  MousePointer2,
  RefreshCw,
} from "lucide-react";
import type { ComputerUseStatus } from "../shared/types";
import { api, ApiError } from "./api";

export function ComputerUseControls({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ComputerUseStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unsupported, setUnsupported] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const id = useId();

  const refresh = useCallback(async (connect = false) => {
    const current = ++request.current;
    setBusy(true);
    setError("");
    try {
      const next = await api<ComputerUseStatus>(
        connect ? "/computer-use/connect" : "/computer-use",
        connect ? {} : undefined,
      );
      if (current !== request.current) return;
      setStatus(next);
      setUnsupported(false);
    } catch (reason) {
      if (current !== request.current) return;
      if (reason instanceof ApiError && reason.status === 404) {
        setUnsupported(true);
        setError(
          "当前连接的 Panel 服务尚不支持电脑控制。请更新并重新启动服务或桌面应用，再刷新状态。",
        );
      } else {
        setError(
          reason instanceof Error ? reason.message : "无法检查电脑控制状态。",
        );
      }
    } finally {
      if (current === request.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!disabled) void refresh();
    return () => {
      request.current += 1;
    };
  }, [disabled, refresh]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  const statusLabel = busy
    ? "检查中"
    : error
      ? "连接异常"
      : status?.connected
        ? "已连接"
        : status?.available
          ? "待连接"
          : status
            ? "待安装"
            : "未连接";
  const permissions = status?.permissions;
  const permissionsMissing = Boolean(
    permissions && (!permissions.accessibility || !permissions.screenRecording),
  );
  return (
    <div
      className="computer-use-controls"
      ref={container}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          setOpen(false);
          container.current
            ?.querySelector<HTMLButtonElement>("button")
            ?.focus();
          event.stopPropagation();
        }
      }}
    >
      <button
        type="button"
        className={`computer-use-toggle${status?.connected ? " connected" : ""}`}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          setOpen(!open);
          if (!open && !busy) void refresh();
        }}
      >
        <Monitor size={13} />
        <span>电脑控制</span>
        <small>{statusLabel}</small>
        <ChevronDown size={11} />
      </button>
      {open && (
        <section
          id={id}
          className="computer-use-popover"
          aria-label="电脑控制设置"
        >
          <div className="computer-use-heading">
            <b>电脑控制</b>
            <button
              type="button"
              className="icon-button"
              aria-label="刷新电脑控制状态"
              disabled={busy || disabled}
              onClick={() => void refresh()}
            >
              <RefreshCw size={13} className={busy ? "spin" : ""} />
            </button>
          </div>
          <p>在对话中指定应用、窗口或页面，即可让 Panel 查看和操作。</p>
          <div className="computer-use-status-row">
            <span>
              {status?.connected ? <Check size={12} /> : <Monitor size={12} />}
              {statusLabel}
            </span>
            {status?.version && <small>Cua Driver {status.version}</small>}
          </div>
          <div className="computer-use-setting-note">
            <MousePointer2 size={13} />
            <span>
              光标覆盖层
              {status?.overlay === false
                ? "已关闭"
                : status
                  ? "已开启"
                  : "默认开启"}
            </span>
          </div>
          <p className="computer-use-parallel-note">
            同一窗口或页面由一个任务使用；不同目标可并行。需要前台的操作会依次执行。
          </p>
          {permissions && (
            <ul className="computer-use-permissions" aria-label="系统权限">
              <li>
                <span>辅助功能</span>
                <b>{permissions.accessibility ? "已允许" : "待授权"}</b>
              </li>
              <li>
                <span>屏幕录制</span>
                <b>{permissions.screenRecording ? "已允许" : "待授权"}</b>
              </li>
            </ul>
          )}
          {status && !status.available && (
            <div className="computer-use-setup">
              <p>请在 Panel 项目目录安装官方驱动：</p>
              <code>npm run setup:cua</code>
              <p>安装后刷新状态，再连接并完成系统权限授权。</p>
            </div>
          )}
          {(error || status?.error) && (
            <p className="computer-use-error" role="alert">
              {error || status?.error}
            </p>
          )}
          {!unsupported &&
            status?.available &&
            (!status.connected || permissionsMissing) && (
              <button
                type="button"
                className="computer-use-connect"
                disabled={busy || disabled}
                onClick={() => void refresh(true)}
              >
                {busy ? (
                  <LoaderCircle size={13} className="spin" />
                ) : (
                  <MousePointer2 size={13} />
                )}
                {status.connected && permissionsMissing
                  ? "完成权限授权"
                  : "连接电脑控制"}
              </button>
            )}
        </section>
      )}
    </div>
  );
}
