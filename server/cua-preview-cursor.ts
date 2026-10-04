import type { ComputerUsePreviewCursor } from "../shared/computer-use-preview.ts";

export type PreviewCursorSample = ComputerUsePreviewCursor & {
  space: "normalized" | "viewport";
};

export const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function windowCursorPoint(position: unknown, bounds: unknown) {
  const p = position as Record<string, unknown> | null;
  const b = bounds as Record<string, unknown> | null;
  if (
    !p ||
    !b ||
    !finite(p.x) ||
    !finite(p.y) ||
    !finite(b.x) ||
    !finite(b.y) ||
    !finite(b.width) ||
    !finite(b.height) ||
    b.width <= 0 ||
    b.height <= 0
  )
    return;
  const x = (p.x - b.x) / b.width;
  const y = (p.y - b.y) / b.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : undefined;
}

export function normalizePreviewCursor(
  sample: PreviewCursorSample,
  viewport?: { width: number; height: number },
): ComputerUsePreviewCursor {
  const { space, ...event } = sample;
  const width = space === "normalized" ? 1 : viewport?.width;
  const height = space === "normalized" ? 1 : viewport?.height;
  if (
    !event.visible ||
    !finite(width) ||
    !finite(height) ||
    width <= 0 ||
    height <= 0 ||
    !finite(event.x) ||
    !finite(event.y)
  )
    return {
      ...event,
      visible: false,
      x: undefined,
      y: undefined,
      toX: undefined,
      toY: undefined,
    };
  const x = event.x / width,
    y = event.y / height;
  if (x < 0 || x > 1 || y < 0 || y > 1)
    return {
      ...event,
      visible: false,
      x: undefined,
      y: undefined,
      toX: undefined,
      toY: undefined,
    };
  const toX = finite(event.toX) ? event.toX / width : undefined;
  const toY = finite(event.toY) ? event.toY / height : undefined;
  const validEnd =
    finite(toX) && finite(toY) && toX >= 0 && toX <= 1 && toY >= 0 && toY <= 1;
  return {
    ...event,
    x,
    y,
    toX: validEnd ? toX : undefined,
    toY: validEnd ? toY : undefined,
  };
}
