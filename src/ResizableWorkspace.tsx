import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { readPreference, savePreference } from "./api";

const DEFAULT_WIDTH = 440;
const MIN_WIDTH = 320;
const MAX_WIDTH = 960;
const MIN_CANVAS_WIDTH = 300;

export function ResizableWorkspace({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    width: number;
    changed: boolean;
  } | null>(null);
  const [preferredWidth, setPreferredWidth] = useState(() => {
    const saved = Number(readPreference("inspector-width"));
    return Number.isFinite(saved) && saved >= MIN_WIDTH
      ? Math.min(saved, MAX_WIDTH)
      : DEFAULT_WIDTH;
  });
  const [containerWidth, setContainerWidth] = useState(window.innerWidth);
  const [resizing, setResizing] = useState(false);
  const maxWidth = Math.max(
    MIN_WIDTH,
    Math.min(MAX_WIDTH, Math.floor(containerWidth - MIN_CANVAS_WIDTH)),
  );
  const width = Math.min(preferredWidth, maxWidth);
  const clamp = (next: number) =>
    Math.round(Math.max(MIN_WIDTH, Math.min(next, maxWidth)));

  useLayoutEffect(() => {
    const container = containerRef.current!;
    const measure = () =>
      setContainerWidth(container.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const finishResize = useCallback(() => {
    if (!dragRef.current) return;
    if (dragRef.current.changed) {
      savePreference("inspector-width", String(dragRef.current.width));
    }
    dragRef.current = null;
    setResizing(false);
  }, []);

  useEffect(() => {
    window.addEventListener("blur", finishResize);
    return () => window.removeEventListener("blur", finishResize);
  }, [finishResize]);

  const resize = (next: number) => {
    const clamped = clamp(next);
    setPreferredWidth(clamped);
    savePreference("inspector-width", String(clamped));
  };

  return (
    <div
      ref={containerRef}
      className={`workspace-body ${resizing ? "is-resizing" : ""}`}
      style={{ "--inspector-width": `${width}px` } as CSSProperties}
    >
      {children}
      <div
        className="inspector-resizer"
        role="separator"
        tabIndex={0}
        aria-label="调整详情面板宽度"
        aria-orientation="vertical"
        aria-controls="node-inspector"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maxWidth}
        aria-valuenow={width}
        aria-valuetext={`${width} 像素`}
        title="拖动调整详情宽度，双击恢复默认；也可使用左右方向键"
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: width,
            width,
            changed: false,
          };
          setResizing(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const next = clamp(drag.startWidth + drag.startX - event.clientX);
          if (next !== drag.width) {
            drag.width = next;
            drag.changed = true;
            setPreferredWidth(next);
          }
        }}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
        onDoubleClick={() => resize(DEFAULT_WIDTH)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 64 : 16;
          const next = {
            ArrowLeft: width + step,
            ArrowRight: width - step,
            Home: MIN_WIDTH,
            End: maxWidth,
            Enter: DEFAULT_WIDTH,
          }[event.key];
          if (next === undefined) return;
          event.preventDefault();
          resize(next);
        }}
      >
        <span />
      </div>
    </div>
  );
}
