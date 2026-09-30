import { useEffect, useState } from "react";
import { ArrowDownToLine, RefreshCw, X } from "lucide-react";
import { getDesktopBridge, type DesktopUpdateState } from "./desktop";

export function DesktopUpdate() {
  const [state, setState] = useState<DesktopUpdateState>({ phase: "idle" });
  const [pending, setPending] = useState(false);
  const [errorVisible, setErrorVisible] = useState(false);
  const desktop = getDesktopBridge();
  useEffect(() => {
    if (!desktop?.getUpdateState) return;
    let live = true;
    let receivedEvent = false;
    const receive = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.phase) {
        receivedEvent = true;
        setState(event.detail);
      }
    };
    window.addEventListener("panel:update-state", receive);
    desktop
      .getUpdateState()
      .then((value) => {
        if (live && !receivedEvent) setState(value);
      })
      .catch(() => {});
    return () => {
      live = false;
      window.removeEventListener("panel:update-state", receive);
    };
  }, [desktop]);
  useEffect(() => {
    setErrorVisible(state.phase === "error" && Boolean(state.message));
    if (state.phase !== "error" || !state.message) return;
    const timer = window.setTimeout(() => setErrorVisible(false), 8_000);
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") setErrorVisible(false);
    };
    window.addEventListener("keydown", dismiss);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", dismiss);
    };
  }, [state]);
  if (!desktop?.installUpdate || state.phase === "idle") return null;
  const canInstall = Boolean(state.version) && state.operation !== "check";
  const busy =
    pending ||
    ["checking", "downloading", "verifying", "ready", "installing"].includes(
      state.phase,
    );
  const label =
    state.phase === "downloading"
      ? `下载 ${state.progress ?? 0}%`
      : state.phase === "checking"
        ? "检查中"
        : state.phase === "verifying"
          ? "校验中"
          : state.phase === "ready" || state.phase === "installing"
            ? "安装中"
            : state.phase === "error"
              ? canInstall
                ? "重试更新"
                : "重试检查"
              : "有更新";
  async function update() {
    if (busy) return;
    setErrorVisible(false);
    setPending(true);
    try {
      // Native events own progress; a command reply can predate a newer event.
      if (canInstall) await desktop?.installUpdate?.();
      else await desktop?.checkForUpdates?.();
    } catch (error) {
      setState((previous) => ({
        ...previous,
        phase: "error",
        message: error instanceof Error ? error.message : "更新失败，请重试。",
      }));
    } finally {
      setPending(false);
    }
  }
  return (
    <span className="desktop-update">
      <button
        type="button"
        className="desktop-update-button"
        disabled={busy}
        onClick={() => void update()}
        aria-label={canInstall ? `更新到 ${state.version}` : "检查 App 更新"}
        title={
          state.message ??
          (state.version
            ? `下载并安装 ${state.version}，完成后自动重启`
            : "每天自动检查 GitHub Release")
        }
        aria-busy={busy}
      >
        {busy ? (
          <RefreshCw size={11} aria-hidden="true" />
        ) : (
          <ArrowDownToLine size={11} aria-hidden="true" />
        )}
        <span aria-live="polite">{label}</span>
      </button>
      {state.phase === "error" && state.message && errorVisible && (
        <span className="desktop-update-error" role="alert">
          <span>{state.message}</span>
          <button
            type="button"
            className="desktop-update-dismiss"
            aria-label="关闭更新提示"
            onClick={() => setErrorVisible(false)}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      )}
    </span>
  );
}
