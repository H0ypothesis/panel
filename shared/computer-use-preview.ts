import type { ComputerUseScope } from "./types";

export interface ComputerUsePreviewState {
  type: "state";
  status: "waiting" | "live" | "unavailable" | "ended";
  source?: "native" | "cdp" | "snapshots";
  scope?: ComputerUseScope;
  label: string;
  action?: string;
  error?: string;
  /** The exact Panel-owned driver process; never supplied by a model/client. */
  nativeOverlay?: { pid: number; bundlePath: string };
}

export interface ComputerUsePreviewOverlay {
  type: "overlay";
  scopeId: string;
  visible: boolean;
  viewport?: { width: number; height: number };
  timestamp: number;
}

export interface ComputerUsePreviewFrame {
  type: "frame";
  scopeId: string;
  mimeType: "image/jpeg" | "image/png";
  data: string;
  timestamp: number;
}

export interface ComputerUsePreviewCursor {
  type: "cursor";
  scopeId: string;
  id: string;
  visible: boolean;
  /** Coordinates relative to the preview image, not its surrounding letterbox. */
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  action: "move" | "click" | "drag" | "scroll" | "text" | "key";
  pressed: boolean;
  durationMs: number;
  reducedMotion: boolean;
  timestamp: number;
}

export type ComputerUsePreviewEvent =
  | ComputerUsePreviewState
  | ComputerUsePreviewFrame
  | ComputerUsePreviewCursor
  | ComputerUsePreviewOverlay;

export function computerUsePreviewPath(
  workspaceId: string,
  nodeId: string,
  revision: number,
  native = false,
) {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/nodes/${encodeURIComponent(nodeId)}/computer-use/preview?revision=${revision}${native ? "&native=1" : ""}`;
}
