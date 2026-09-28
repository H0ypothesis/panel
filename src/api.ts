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

async function requireBranchMerging(preparation = false) {
  let capabilities: {
    branchMerging?: boolean;
    mergeContextPreparation?: boolean;
  };
  try {
    const response = await fetch("/api/capabilities", { cache: "no-store" });
    if (!response.ok) throw new Error("Capability request failed");
    capabilities = await response.json();
  } catch {
    throw new Error(
      "无法确认当前后端支持多分支融合，请检查连接后重试。问题尚未发送。",
    );
  }
  if (capabilities?.branchMerging !== true)
    throw new Error(
      "当前后端尚未加载多分支融合功能，请重启 Panel 服务后重试。问题尚未发送。",
    );
  if (preparation && capabilities.mergeContextPreparation !== true)
    throw new Error(
      "当前后端尚未加载整体主动压缩功能，请重启 Panel 服务后重试。问题尚未发送。",
    );
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const usesMergedCheckpoint = !!(
    body &&
    typeof body === "object" &&
    "mergedContextCheckpointId" in body &&
    body.mergedContextCheckpointId
  );
  if (
    method === "POST" &&
    (/^\/workspaces\/[^/]+\/merge-context\/compact$/.test(path) ||
      (/^\/workspaces\/[^/]+\/nodes$/.test(path) &&
        (usesMergedCheckpoint ||
          (body &&
            typeof body === "object" &&
            "contextParents" in body &&
            Array.isArray(body.contextParents) &&
            body.contextParents.length > 0))))
  )
    await requireBranchMerging(
      usesMergedCheckpoint || path.endsWith("/merge-context/compact"),
    );
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
  if (!response.ok)
    throw new ApiError(data.error ?? "请求失败，请稍后重试。", response.status);
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
