import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Expand, Monitor, MousePointer2, PanelsTopLeft, X } from "lucide-react";
import type { ToolCall } from "../shared/types";
import { computerUseTargetLabel, toolImageUrl } from "./computer-use";

type ToolImage = NonNullable<ToolCall["images"]>[number];

export function ComputerUseTarget({ call }: { call: ToolCall }) {
  const target = call.computerUse;
  const label = computerUseTargetLabel(call);
  if (!target || !label) return null;
  return (
    <div className="computer-use-target" aria-label="电脑操作目标">
      {target.scope === "page" ? (
        <PanelsTopLeft size={12} aria-hidden="true" />
      ) : (
        <Monitor size={12} aria-hidden="true" />
      )}
      <span title={label}>{label}</span>
      {target.mode && (
        <small>{target.mode === "background" ? "后台操作" : "前台操作"}</small>
      )}
      {target.overlay && (
        <MousePointer2 size={12} aria-label="光标覆盖层已开启" />
      )}
    </div>
  );
}

function ScreenshotDialog({
  image,
  label,
  onClose,
}: {
  image: ToolImage;
  label: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      className="computer-use-screenshot-dialog"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <span>{label}</span>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭截图预览"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="computer-use-screenshot-full">
        <img src={toolImageUrl(image.url)!} alt={label} />
      </div>
    </dialog>,
    document.body,
  );
}

export function ToolScreenshots({ call }: { call: ToolCall }) {
  const [expanded, setExpanded] = useState<string>();
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set());
  const images = (call.images ?? []).filter(
    (image) =>
      ["image/png", "image/jpeg", "image/webp"].includes(image.mimeType) &&
      toolImageUrl(image.url),
  );
  const selected = images.find((image) => image.id === expanded);
  const target = computerUseTargetLabel(call);
  const label = target ? `${target} · 操作截图` : "操作截图";
  if (!images.length) return null;
  return (
    <div className="computer-use-screenshots" aria-label="操作截图">
      {images.map((image, index) => (
        <figure key={image.id}>
          {unavailable.has(image.id) ? (
            <p className="computer-use-screenshot-unavailable">
              截图暂时无法加载
            </p>
          ) : (
            <button
              type="button"
              className="computer-use-screenshot-preview"
              aria-label={`放大${label}${images.length > 1 ? ` ${index + 1}` : ""}`}
              onClick={() => setExpanded(image.id)}
            >
              <img
                src={toolImageUrl(image.url)!}
                alt={`${label}${images.length > 1 ? ` ${index + 1}` : ""}`}
                loading="lazy"
                onError={() =>
                  setUnavailable((current) => new Set(current).add(image.id))
                }
              />
              <span>
                <Expand size={13} /> 放大截图
              </span>
            </button>
          )}
          <figcaption>
            <span>截图{images.length > 1 ? ` ${index + 1}` : ""}</span>
            {image.width && image.height ? (
              <span>
                {image.width} × {image.height}
              </span>
            ) : null}
          </figcaption>
        </figure>
      ))}
      {selected && (
        <ScreenshotDialog
          image={selected}
          label={label}
          onClose={() => setExpanded(undefined)}
        />
      )}
    </div>
  );
}
