import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Infinity as InfinityIcon, X } from "lucide-react";
import type { ThinkingLevel } from "../shared/types";

type IntensityLevel = ThinkingLevel | "default";

const descriptions: Record<IntensityLevel, string> = {
  default: "由模型自动选择思考强度。",
  off: "关闭额外思考，直接生成回答。",
  minimal: "轻量思考，适合简单问题。",
  low: "快速思考，适合日常任务。",
  medium: "平衡思考深度与响应速度。",
  high: "深入思考，适合复杂问题。",
  xhigh: "投入更多思考，处理高难度任务。",
  max: "全力思考，探索更深的可能。",
};

const levelLabel = (level: IntensityLevel) =>
  level === "default" ? "默认" : level;

const sparks = Array.from({ length: 28 }, (_, index) => {
  const angle = (index / 28) * Math.PI * 2;
  const distance = 27 + ((index * 17) % 31);
  return {
    "--spark-x": `${Math.cos(angle) * distance}px`,
    "--spark-y": `${Math.sin(angle) * distance}px`,
    "--spark-delay": `${(index % 7) * -0.31}s`,
    "--spark-size": `${index % 4 === 0 ? 3 : 2}px`,
  } as CSSProperties;
});

const pixelFlowSeconds = 1.8;
const pixelColors = [
  "#86c9e7",
  "#a3a8f4",
  "#ba9fe8",
  "#d4a1dd",
  "#edb6d9",
  "#a4d9df",
];
const pixelNoise = (seed: number) => {
  let hash = Math.imul(seed, 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  return ((hash ^ (hash >>> 16)) >>> 0) / 0xffffffff;
};
const mosaic = Array.from({ length: 64 * 5 }, (_, index) => {
  const column = index % 64;
  const row = Math.floor(index / 64);
  const noise = pixelNoise(index + 17);
  const density = 0.07 + 0.83 * (column / 63) ** 1.35;
  // Grid anchors stay fixed while independently timed blocks change the pattern.
  return {
    left: `${2 + (column / 63) * 96}%`,
    top: `${7 + row * 19}%`,
    "--pixel-delay": `${-(column / 63) * pixelFlowSeconds - row * 0.025 - noise * 0.02}s`,
    "--pixel-duration": `${pixelFlowSeconds}s`,
    "--pixel-pop-delay": `${-noise * 5}s`,
    "--pixel-pop-duration": `${1.15 + noise * 1.85}s`,
    "--pixel-on-a": noise < density ? 1 : 0,
    "--pixel-on-b": pixelNoise(index + 997) < density ? 1 : 0,
    "--pixel-on-c": pixelNoise(index + 2017) < density ? 1 : 0,
    "--pixel-on-d": pixelNoise(index + 4093) < density ? 1 : 0,
    "--pixel-color":
      pixelColors[Math.floor(noise * pixelColors.length) % pixelColors.length],
    "--pixel-alternate":
      pixelColors[
        (Math.floor(noise * pixelColors.length) + 2) % pixelColors.length
      ],
  } as CSSProperties;
});

const IntensityPixels = memo(function IntensityPixels() {
  return (
    <div
      className="intensity-pixels"
      style={
        {
          "--pixel-flow-duration": `${pixelFlowSeconds}s`,
          "--pixel-bloom-delay": `${-pixelFlowSeconds * 0.66}s`,
        } as CSSProperties
      }
    >
      {mosaic.map((style, key) => (
        <i key={key} style={style}>
          <span />
        </i>
      ))}
    </div>
  );
});

export function ThinkingIntensityControl<T extends IntensityLevel>({
  value,
  levels,
  label,
  title,
  disabled = false,
  conflict,
  compact = false,
  onChange,
}: {
  value: T;
  levels: readonly T[];
  label: string;
  title?: string;
  disabled?: boolean;
  conflict?: string;
  compact?: boolean;
  onChange: (level: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const [dragPosition, setDragPosition] = useState<number | null>(null);
  const dragging = useRef<number | null>(null);
  const selection = useRef({ levels, value, disabled, onChange });
  const trigger = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const cardId = useId();
  const descriptionId = useId();
  const index = Math.max(0, levels.indexOf(value));
  const sliderPosition = dragPosition ?? index;
  const fraction = levels.length > 1 ? sliderPosition / (levels.length - 1) : 0;
  const previewIndex = Math.round(sliderPosition);
  const preview = levels[previewIndex] ?? value;
  const isMax = preview === "max";
  const active = open && !disabled && levels.length > 0;

  const close = (restoreFocus = false) => {
    dragging.current = null;
    setDragPosition(null);
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  };

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useLayoutEffect(() => {
    selection.current = { levels, value, disabled, onChange };
  }, [levels, value, disabled, onChange]);

  useEffect(() => {
    dragging.current = null;
    setDragPosition(null);
    if (!active) return;
    const finishDrag = () => {
      const position = dragging.current;
      if (position === null) return;
      dragging.current = null;
      setDragPosition(null);
      const current = selection.current;
      const next = current.levels[Math.round(position)];
      if (!current.disabled && next && next !== current.value)
        current.onChange(next);
    };
    const cancelDrag = () => {
      dragging.current = null;
      setDragPosition(null);
    };
    // Range inputs can finish outside the card; persist only the final stop.
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", cancelDrag);
    window.addEventListener("blur", cancelDrag);
    return () => {
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", cancelDrag);
      window.removeEventListener("blur", cancelDrag);
    };
  }, [active]);

  useLayoutEffect(() => {
    if (!active) return;
    const reposition = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const margin = 12;
      const width = Math.min(320, window.innerWidth - margin * 2);
      const height = card.current?.getBoundingClientRect().height || 240;
      const above = anchor.top >= height + margin + 8;
      setPosition({
        width,
        left: Math.max(
          margin,
          Math.min(anchor.right - width, window.innerWidth - width - margin),
        ),
        top: Math.max(
          margin,
          Math.min(
            above ? anchor.top - height - 8 : anchor.bottom + 8,
            window.innerHeight - height - margin,
          ),
        ),
        maxHeight: window.innerHeight - margin * 2,
      });
    };
    reposition();
    if (slider.current?.disabled) card.current?.focus({ preventScroll: true });
    else slider.current?.focus({ preventScroll: true });
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(reposition)
        : undefined;
    if (trigger.current) observer?.observe(trigger.current);
    if (card.current) observer?.observe(card.current);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      if (
        target &&
        !card.current?.contains(target) &&
        !trigger.current?.contains(target)
      )
        close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [active]);

  const choose = (next: T) => {
    if (!disabled && levels.includes(next) && next !== value) onChange(next);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`thinking-intensity-trigger${compact ? " is-compact" : ""}${value === "max" ? " is-max" : ""}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={active}
        aria-controls={active ? cardId : undefined}
        aria-invalid={Boolean(conflict)}
        aria-description={conflict}
        title={conflict ?? title ?? "调整思考强度"}
        disabled={disabled || !levels.length}
        onClick={() => setOpen(!active)}
      >
        {!compact && <InfinityIcon size={13} aria-hidden="true" />}
        <span>{levelLabel(value)}</span>
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      {active &&
        createPortal(
          <div
            ref={card}
            id={cardId}
            role="dialog"
            tabIndex={-1}
            aria-label={`${label}设置`}
            className={`thinking-intensity-card nodrag nopan nowheel${isMax ? " is-max" : ""}`}
            style={position}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <div className="intensity-card-heading">
              <span>
                思考强度 <strong>{levelLabel(preview)}</strong>
              </span>
              <button
                type="button"
                aria-label="关闭思考强度卡片"
                onClick={() => close(true)}
              >
                <X size={15} />
              </button>
            </div>
            <div className="intensity-endpoints" aria-hidden="true">
              <span>更快响应</span>
              <span>更深思考</span>
            </div>
            <div
              className={`intensity-slider${dragPosition !== null ? " is-dragging" : ""}`}
              style={
                {
                  "--intensity-progress": `${fraction * 100}%`,
                  "--intensity-fraction": fraction,
                } as CSSProperties
              }
            >
              <div className="intensity-rail" aria-hidden="true">
                <div className="intensity-fill" />
                {isMax && <IntensityPixels />}
                <div className="intensity-ticks">
                  {levels.map((level, tick) => (
                    <i
                      key={level}
                      className={`intensity-tick${tick <= previewIndex ? " is-filled" : ""}`}
                      style={{
                        left: `${levels.length > 1 ? (tick / (levels.length - 1)) * 100 : 0}%`,
                      }}
                    />
                  ))}
                </div>
              </div>
              <div className="intensity-thumb-lane" aria-hidden="true">
                <div className="intensity-thumb">
                  {isMax && (
                    <div className="intensity-sparks">
                      {sparks.map((style, key) => (
                        <i key={key} style={style} />
                      ))}
                    </div>
                  )}
                  <InfinityIcon size={25} strokeWidth={2.3} />
                </div>
              </div>
              <input
                ref={slider}
                type="range"
                aria-label={label}
                aria-valuetext={levelLabel(preview)}
                aria-describedby={descriptionId}
                aria-invalid={Boolean(conflict)}
                min={0}
                max={Math.max(0, levels.length - 1)}
                step="any"
                value={sliderPosition}
                disabled={levels.length <= 1}
                onPointerDown={(event) => {
                  if (event.button !== 0 || levels.length <= 1) return;
                  dragging.current = Number(event.currentTarget.value);
                  setDragPosition(dragging.current);
                }}
                onChange={(event) => {
                  const next = Number(event.currentTarget.value);
                  if (dragging.current !== null) {
                    dragging.current = next;
                    setDragPosition(next);
                  } else choose(levels[Math.round(next)]);
                }}
                onKeyDown={(event) => {
                  let next: number;
                  switch (event.key) {
                    case "ArrowLeft":
                    case "ArrowDown":
                      next = index - 1;
                      break;
                    case "ArrowRight":
                    case "ArrowUp":
                      next = index + 1;
                      break;
                    case "Home":
                      next = 0;
                      break;
                    case "End":
                      next = levels.length - 1;
                      break;
                    default:
                      return;
                  }
                  event.preventDefault();
                  dragging.current = null;
                  setDragPosition(null);
                  choose(
                    levels[Math.max(0, Math.min(levels.length - 1, next))],
                  );
                }}
              />
            </div>
            <div
              className="intensity-levels"
              role="group"
              aria-label="可选强度"
            >
              {levels.map((level, tick) => (
                <button
                  key={level}
                  type="button"
                  aria-label={`选择 ${levelLabel(level)} 强度`}
                  aria-pressed={level === preview}
                  style={{
                    left: `${levels.length > 1 ? (tick / (levels.length - 1)) * 100 : 0}%`,
                  }}
                  onClick={() => choose(level)}
                >
                  {levelLabel(level)}
                </button>
              ))}
            </div>
            <div className="intensity-card-footer">
              <p id={descriptionId}>
                {conflict ??
                  (levels.length === 1
                    ? `此模型仅支持 ${levelLabel(value)}。`
                    : descriptions[preview])}
              </p>
            </div>
          </div>,
          // Native modal dialogs require their controls to stay in the top layer.
          trigger.current?.closest("dialog[open]") ?? document.body,
        )}
    </>
  );
}
