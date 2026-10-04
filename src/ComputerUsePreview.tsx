import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { AppWindow, MonitorPlay, RefreshCw, Square, X } from "lucide-react";
import type { TurnNode } from "../shared/types";
import {
  computerUsePreviewPath,
  type ComputerUsePreviewState,
  type ComputerUsePreviewFrame,
} from "../shared/computer-use-preview";
import { readPreference, savePreference } from "./api";
import { getDesktopBridge } from "./desktop";

export function ComputerUsePreview({
  workspaceId,
  node,
  online,
  onStop,
}: {
  workspaceId: string;
  node: TurnNode;
  online: boolean;
  onStop: () => Promise<void>;
}) {
  const available =
    node.toolRequests?.includes("computer_use") ||
    node.toolCalls?.some((call) => call.name.startsWith("computer_use_"));
  const active = ["queued", "running"].includes(node.status);
  const [enabled, setEnabled] = useState(
    () => readPreference("computer-preview") !== "off",
  );
  const [preview, setPreview] = useState<ComputerUsePreviewState>({
    type: "state",
    status: "waiting",
    label: "等待模型观察操作目标…",
  });
  const [frame, setFrame] = useState<ComputerUsePreviewFrame>();
  const [retry, setRetry] = useState(0);
  const [size, setSize] = useState({ width: 280, height: 175 });
  const [position, setPosition] = useState<{ x: number; y: number }>();
  const [now, setNow] = useState(Date.now());
  const panel = useRef<HTMLElement>(null);
  const entering = useRef<AbortController | undefined>(undefined);
  const [enteringApp, setEnteringApp] = useState(false);
  const [enterError, setEnterError] = useState<string>();
  const gesture = useRef<{
    kind: "move" | "resize";
    pointerId: number;
    x: number;
    y: number;
    rect: DOMRect;
  } | null>(null);
  const scope = useRef<string | undefined>(undefined);
  const bridge = getDesktopBridge();
  const native =
    !!bridge?.setComputerUsePreview && !!bridge?.closeComputerUsePreview;
  const showing = enabled && !!available && active && online;
  const revision = node.revision ?? 0;
  const toggle = (value: boolean) => {
    savePreference("computer-preview", value ? "on" : "off");
    setEnabled(value);
  };
  const beginGesture = (
    kind: "move" | "resize",
    event: PointerEvent<HTMLElement>,
  ) => {
    if (event.button !== 0 || !panel.current) return;
    event.preventDefault();
    event.stopPropagation();
    gesture.current = {
      kind,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      rect: panel.current.getBoundingClientRect(),
    };
    panel.current.setPointerCapture(event.pointerId);
  };
  const endGesture = (event: PointerEvent<HTMLElement>) => {
    gesture.current = null;
    if (panel.current?.hasPointerCapture(event.pointerId))
      panel.current.releasePointerCapture(event.pointerId);
  };
  const enterApp = async () => {
    const scopeId = preview.scope?.id;
    if (!scopeId || preview.status !== "live" || entering.current) return;
    const controller = new AbortController();
    entering.current = controller;
    setEnteringApp(true);
    setEnterError(undefined);
    try {
      const path = computerUsePreviewPath(workspaceId, node.id, revision).split(
        "?",
      )[0];
      const response = await fetch(`${path}/enter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: revision, scopeId }),
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error ?? "无法进入当前应用，请重试。");
    } catch (error) {
      if (
        entering.current === controller &&
        scope.current === scopeId &&
        !controller.signal.aborted
      )
        setEnterError(
          error instanceof Error ? error.message : "无法进入当前应用，请重试。",
        );
    } finally {
      if (entering.current === controller) {
        entering.current = undefined;
        setEnteringApp(false);
      }
    }
  };

  useEffect(() => {
    entering.current?.abort();
    entering.current = undefined;
    setEnteringApp(false);
    setEnterError(undefined);
    return () => {
      entering.current?.abort();
      entering.current = undefined;
    };
  }, [showing, workspaceId, node.id, revision, retry, preview.scope?.id]);

  useEffect(() => {
    const closed = () => toggle(false);
    window.addEventListener("panel:preview-closed", closed);
    return () => window.removeEventListener("panel:preview-closed", closed);
  }, []);

  useEffect(() => {
    if (!showing) return;
    setFrame(undefined);
    scope.current = undefined;
    setPreview({
      type: "state",
      status: "waiting",
      label: "等待模型观察操作目标…",
    });
    if (native) {
      let mounted = true;
      void bridge!.setComputerUsePreview!({
        workspaceId,
        nodeId: node.id,
        revision,
      }).catch((error) => {
        if (mounted)
          setPreview({
            type: "state",
            status: "unavailable",
            label: "无法打开桌面预览",
            error: error instanceof Error ? error.message : "请重试。",
          });
      });
      return () => {
        mounted = false;
        void bridge!.closeComputerUsePreview!().catch(() => {});
      };
    }
    const events = new EventSource(
      computerUsePreviewPath(workspaceId, node.id, revision),
    );
    let mounted = true;
    events.addEventListener("state", (event) => {
      if (!mounted) return;
      let next: ComputerUsePreviewState;
      try {
        next = JSON.parse((event as MessageEvent).data);
        if (
          next?.type !== "state" ||
          !["waiting", "live", "unavailable", "ended"].includes(next.status)
        )
          return;
      } catch {
        return;
      }
      if (scope.current !== next.scope?.id || next.status !== "live")
        setFrame(undefined);
      scope.current = next.scope?.id;
      setPreview(next);
      if (next.status === "ended") {
        mounted = false;
        events.close();
      }
    });
    events.addEventListener("frame", (event) => {
      if (!mounted) return;
      try {
        const next = JSON.parse(
          (event as MessageEvent).data,
        ) as ComputerUsePreviewFrame;
        if (
          next?.type !== "frame" ||
          !scope.current ||
          next.scopeId !== scope.current ||
          !["image/jpeg", "image/png"].includes(next.mimeType) ||
          typeof next.data !== "string" ||
          next.data.length > 2 * 1024 * 1024 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(next.data) ||
          !Number.isFinite(next.timestamp)
        )
          return;
        setFrame(next);
      } catch {
        /* Ignore malformed frames. */
      }
    });
    events.onerror = () => {
      if (!mounted) return;
      mounted = false;
      setFrame(undefined);
      setPreview({
        type: "state",
        status: "unavailable",
        label: "预览连接中断",
        error: "点击重新连接。",
      });
      events.close();
    };
    return () => {
      mounted = false;
      events.close();
    };
  }, [showing, native, workspaceId, node.id, revision, retry]);

  useEffect(() => {
    if (!showing || native) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [showing, native]);

  if (!available) return null;
  const stale = !!frame && now - frame.timestamp > 3000;
  return (
    <>
      <button
        type="button"
        className={`computer-preview-toggle${showing ? " selected" : ""}`}
        disabled={!active || !online}
        aria-pressed={showing}
        onClick={() => toggle(!showing)}
        title={active ? "跟随此卡片的电脑操作" : "任务运行时可打开预览"}
      >
        <MonitorPlay size={13} />
        {showing ? "关闭实时预览" : "实时预览"}
      </button>
      {native && preview.status === "unavailable" && showing && (
        <span className="computer-preview-inline-error" role="alert">
          {preview.error}
        </span>
      )}
      {showing &&
        !native &&
        createPortal(
          <section
            ref={panel}
            className="computer-preview-window"
            style={{
              width: size.width,
              height: size.height,
              ...(position
                ? {
                    left: position.x,
                    top: position.y,
                    right: "auto",
                    bottom: "auto",
                  }
                : {}),
            }}
            aria-label="电脑操作实时预览"
            onPointerDown={(event) => {
              if (
                !(event.target as HTMLElement).closest(
                  "button,[data-preview-resize]",
                )
              )
                beginGesture("move", event);
            }}
            onPointerMove={(event) => {
              const start = gesture.current;
              if (!start || start.pointerId !== event.pointerId) return;
              if (start.kind === "move") {
                setPosition({
                  x: Math.max(
                    0,
                    Math.min(
                      window.innerWidth - start.rect.width,
                      start.rect.left + event.clientX - start.x,
                    ),
                  ),
                  y: Math.max(
                    0,
                    Math.min(
                      window.innerHeight - start.rect.height,
                      start.rect.top + event.clientY - start.y,
                    ),
                  ),
                });
              } else {
                const dx = event.clientX - start.x;
                const dy = (event.clientY - start.y) * 1.6;
                const delta = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
                const maximum = Math.min(
                  560,
                  window.innerWidth - start.rect.left - 8,
                  (window.innerHeight - start.rect.top - 8) * 1.6,
                );
                const width = Math.max(
                  200,
                  Math.min(maximum, start.rect.width + delta),
                );
                setSize({ width, height: width / 1.6 });
                setPosition({ x: start.rect.left, y: start.rect.top });
              }
            }}
            onPointerUp={endGesture}
            onPointerCancel={endGesture}
            onLostPointerCapture={() => {
              gesture.current = null;
            }}
          >
            <div className="computer-preview-picture">
              {frame && preview.status !== "unavailable" ? (
                <img
                  src={`data:${frame.mimeType};base64,${frame.data}`}
                  alt={preview.label}
                  draggable={false}
                />
              ) : (
                <p role="status">{preview.error || preview.label}</p>
              )}
            </div>
            <div className="computer-preview-controls">
              <button
                type="button"
                className="computer-preview-close"
                aria-label="关闭画中画"
                title="关闭画中画"
                onClick={() => toggle(false)}
              >
                <X size={13} />
              </button>
              <div className="computer-preview-actions">
                <button
                  type="button"
                  aria-label="刷新画面"
                  title="刷新画面"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  <RefreshCw size={15} />
                </button>
                <button
                  type="button"
                  className="computer-preview-enter"
                  aria-label="进入被控制的应用"
                  title="进入被控制的应用"
                  disabled={
                    !preview.scope || preview.status !== "live" || enteringApp
                  }
                  onClick={() => void enterApp()}
                >
                  <AppWindow size={21} />
                </button>
                <button
                  type="button"
                  aria-label="中止任务"
                  title="中止任务"
                  onClick={() => void onStop()}
                >
                  <Square size={12} fill="currentColor" />
                </button>
              </div>
              <span className="computer-preview-status" title={preview.label}>
                {enterError ||
                  (enteringApp
                    ? "正在进入应用…"
                    : stale
                      ? "画面暂未更新"
                      : preview.action || "正在连接画面…")}
              </span>
              <div
                className="computer-preview-resize"
                data-preview-resize
                role="slider"
                tabIndex={0}
                aria-label="调节画中画大小"
                aria-valuemin={200}
                aria-valuemax={560}
                aria-valuenow={size.width}
                onPointerDown={(event) => beginGesture("resize", event)}
                onKeyDown={(event) => {
                  if (
                    ![
                      "ArrowRight",
                      "ArrowUp",
                      "ArrowLeft",
                      "ArrowDown",
                    ].includes(event.key)
                  )
                    return;
                  event.preventDefault();
                  const width = Math.max(
                    200,
                    Math.min(
                      560,
                      window.innerWidth - (position?.x ?? 24) - 8,
                      (window.innerHeight - (position?.y ?? 24) - 8) * 1.6,
                      size.width +
                        (["ArrowRight", "ArrowUp"].includes(event.key)
                          ? 20
                          : -20),
                    ),
                  );
                  setSize({ width, height: width / 1.6 });
                }}
              />
            </div>
          </section>,
          document.body,
        )}
    </>
  );
}
