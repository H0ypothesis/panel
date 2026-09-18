import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";

export function BrandHint({
  children,
  available,
  onOpenHelp,
}: {
  children: ReactNode;
  available: boolean;
  onOpenHelp: () => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!available) setOpen(false);
  }, [available]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (container.current?.contains(document.activeElement)) {
        trigger.current?.focus();
      }
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissOnEscape, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissOnEscape, true);
    };
  }, [open]);

  return (
    <div
      className="brand-hint"
      ref={container}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") setOpen(true);
      }}
      onPointerLeave={() => {
        if (!container.current?.contains(document.activeElement))
          setOpen(false);
      }}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={trigger}
        className="brand-hint-trigger"
        aria-label="关于 Panel"
        aria-expanded={available && open}
        aria-controls="panel-brand-hint"
        onClick={() => setOpen(true)}
      >
        {children}
      </button>
      <div
        id="panel-brand-hint"
        className="thought-card brand-hint-card"
        role="region"
        aria-labelledby="panel-brand-hint-title"
        hidden={!available || !open}
      >
        <div className="mini-tree" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <svg viewBox="0 0 150 42">
            <path d="M8 22H43Q53 22 61 11H89M53 22H108M53 22Q61 35 81 35H134" />
          </svg>
        </div>
        <b id="panel-brand-hint-title">好想法，值得多走一条路。</b>
        <p>
          从任意节点出发，
          <br />
          让不同的可能同时生长。
        </p>
        <button
          onClick={() => {
            setOpen(false);
            onOpenHelp();
          }}
        >
          认识非线性对话 <ArrowUpRight size={12} />
        </button>
      </div>
    </div>
  );
}
