import type { Message } from "@earendil-works/pi-ai";
import type { ToolCall } from "../shared/types.ts";

export const MAX_TOOL_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) * 4;
const MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

interface ValidImage {
  mimeType: string;
  byteLength: number;
  width?: number;
  height?: number;
}

// Streaming snapshots repeatedly visit the same immutable message blocks. Cache
// validation metadata only; image bytes remain in the original transcript.
const validated = new WeakMap<
  object,
  {
    data: unknown;
    mimeType: unknown;
    result: ValidImage | undefined;
  }
>();

function validateImage(part: Record<string, unknown>): ValidImage | undefined {
  const { data, mimeType } = part;
  if (typeof data !== "string" || typeof mimeType !== "string") return;
  if (
    !MIME_TYPES.has(mimeType) ||
    !data.length ||
    data.length > MAX_BASE64_LENGTH
  )
    return;
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const last = BASE64.indexOf(data[data.length - padding - 1]);
  // Reject alternate encodings with nonzero unused pad bits as well as malformed
  // alphabet/padding. Buffer.from(base64) alone silently tolerates both.
  if (
    last < 0 ||
    (padding === 2 && (last & 15) !== 0) ||
    (padding === 1 && (last & 3) !== 0)
  )
    return;
  const byteLength = (data.length / 4) * 3 - padding;
  if (byteLength <= 0 || byteLength > MAX_TOOL_IMAGE_BYTES) return;
  const header = Buffer.from(data.slice(0, 48), "base64");
  if (mimeType === "image/png") {
    if (
      byteLength < 33 ||
      !header
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      header.readUInt32BE(8) !== 13 ||
      header.toString("ascii", 12, 16) !== "IHDR"
    )
      return;
    const width = header.readUInt32BE(16);
    const height = header.readUInt32BE(20);
    if (!width || !height) return;
    return { mimeType, byteLength, width, height };
  }
  if (mimeType === "image/jpeg") {
    if (
      byteLength < 4 ||
      header[0] !== 0xff ||
      header[1] !== 0xd8 ||
      header[2] !== 0xff
    )
      return;
    return { mimeType, byteLength };
  }
  if (
    byteLength < 20 ||
    header.toString("ascii", 0, 4) !== "RIFF" ||
    header.toString("ascii", 8, 12) !== "WEBP" ||
    !["VP8 ", "VP8L", "VP8X"].includes(header.toString("ascii", 12, 16)) ||
    header.readUInt32LE(4) + 8 !== byteLength
  )
    return;
  return { mimeType, byteLength };
}

function imageInfo(part: unknown): ValidImage | undefined {
  if (!part || typeof part !== "object") return;
  const block = part as Record<string, unknown>;
  if (block.type !== "image") return;
  const cached = validated.get(block);
  if (
    cached &&
    cached.data === block.data &&
    cached.mimeType === block.mimeType
  )
    return cached.result;
  const result = validateImage(block);
  validated.set(block, { data: block.data, mimeType: block.mimeType, result });
  return result;
}

function imageBlocks(
  messages: readonly Message[] | undefined,
  toolCallId: string,
): unknown[] | undefined {
  if (!Array.isArray(messages) || !toolCallId) return;
  const results = messages.filter(
    (message) =>
      message?.role === "toolResult" && message.toolCallId === toolCallId,
  );
  // A tool call ID should have one final result in one run. Never guess which
  // duplicate result a persisted reference was intended to identify.
  if (results.length !== 1) return;
  const content = results[0].content;
  if (!Array.isArray(content)) return;
  return content.filter(
    (part) => part && typeof part === "object" && part.type === "image",
  );
}

/** Image-only ordinal is stable even when another image in the result is invalid. */
export function readToolImage(
  messages: readonly Message[] | undefined,
  toolCallId: string,
  index: number,
): { mimeType: string; data: Buffer } | undefined {
  if (!Number.isSafeInteger(index) || index < 0) return;
  const part = imageBlocks(messages, toolCallId)?.[index];
  const info = imageInfo(part);
  if (!info) return;
  const data = Buffer.from((part as { data: string }).data, "base64");
  return { mimeType: info.mimeType, data };
}

/** Derive public references without copying base64 into state snapshots. */
export function toolImageReferences(
  workspaceId: string,
  nodeId: string,
  revision: number,
  messages: readonly Message[] | undefined,
  toolCallId: string,
): ToolCall["images"] | undefined {
  if (!Number.isSafeInteger(revision) || revision < 0) return;
  const ids = [workspaceId, nodeId, toolCallId];
  if (ids.some((id) => !id || id === "." || id === "..")) return;
  let encoded: string[];
  try {
    encoded = ids.map((id) => encodeURIComponent(id));
  } catch {
    return;
  }
  const [workspace, node, call] = encoded;
  const images = imageBlocks(messages, toolCallId)?.flatMap((part, index) => {
    const info = imageInfo(part);
    return info
      ? [
          {
            id: `${toolCallId}:${index}:${revision}`,
            url: `/api/workspaces/${workspace}/nodes/${node}/tool-images/${call}/${index}?revision=${revision}`,
            mimeType: info.mimeType,
            ...(info.width && info.height
              ? { width: info.width, height: info.height }
              : {}),
          },
        ]
      : [];
  });
  return images?.length ? images : undefined;
}
