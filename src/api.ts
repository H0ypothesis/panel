import type { AppState } from "../shared/types";

function needsCardReferences(path: string, body: unknown, method: string) {
  return (
    method === "POST" &&
    /^\/workspaces\/[^/]+\/nodes(?:\/[^/]+\/regenerate)?$/.test(path) &&
    body !== null &&
    typeof body === "object" &&
    "referenceNodeIds" in body &&
    Array.isArray(body.referenceNodeIds) &&
    body.referenceNodeIds.length > 0
  );
}

async function requireCardReferences() {
  let capabilities: unknown;
  try {
    // Check each submission: the backend can restart independently of Vite's
    // frontend updates, and an older API silently ignores referenceNodeIds.
    const response = await fetch("/api/capabilities", { cache: "no-store" });
    if (!response.ok) throw new Error("Capability request failed");
    capabilities = await response.json();
  } catch {
    throw new Error(
      "无法确认当前后端支持卡片引用，请检查连接后重试。引用内容尚未发送。",
    );
  }
  if (
    !capabilities ||
    typeof capabilities !== "object" ||
    !("cardReferences" in capabilities) ||
    capabilities.cardReferences !== true
  ) {
    throw new Error(
      "当前后端尚未加载卡片引用功能，请重启 Panel 服务后重试。引用内容尚未发送。",
    );
  }
}

export async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  if (needsCardReferences(path, body, method)) await requireCardReferences();
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? {}
      : {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "请求失败，请稍后重试。");
  return data as T;
}

export function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(`panel:${key}`);
  } catch {
    return null;
  }
}
export function savePreference(key: string, value: string) {
  try {
    localStorage.setItem(`panel:${key}`, value);
  } catch {
    /* Persistence may be disabled by the browser. */
  }
}
export type MutationResult = {
  state: AppState;
  nodeId?: string;
  workspaceId?: string;
};
