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

async function requireToolRequests() {
  let capabilities: unknown;
  try {
    const response = await fetch("/api/capabilities", { cache: "no-store" });
    if (!response.ok) throw new Error("Capability request failed");
    capabilities = await response.json();
  } catch {
    throw new Error(
      "无法确认当前后端支持指定工具，请检查连接后重试。消息尚未发送。",
    );
  }
  if (
    !capabilities ||
    typeof capabilities !== "object" ||
    !("toolRequests" in capabilities) ||
    capabilities.toolRequests !== true
  )
    throw new Error(
      "当前后端尚未加载指定工具功能，请重启 Panel 服务后重试。消息尚未发送。",
    );
}

async function requireLongTasks() {
  let capabilities: unknown;
  try {
    const response = await fetch("/api/capabilities", { cache: "no-store" });
    if (!response.ok) throw new Error("Capability request failed");
    capabilities = await response.json();
  } catch {
    throw new Error(
      "无法确认当前后端支持长程任务，请检查连接后重试。消息尚未发送。",
    );
  }
  if (
    !capabilities ||
    typeof capabilities !== "object" ||
    !("longTasks" in capabilities) ||
    capabilities.longTasks !== true
  )
    throw new Error(
      "当前后端尚不支持长程任务，请更新并重启 Panel 服务或桌面应用后重试。消息尚未发送。",
    );
}

async function requireComputerUseTakeover(taskControl = false) {
  let capabilities: unknown;
  try {
    const response = await fetch("/api/capabilities", { cache: "no-store" });
    if (!response.ok) throw new Error("Capability request failed");
    capabilities = await response.json();
  } catch {
    throw new Error(
      "无法确认当前后端支持 CUA 接管，请检查连接后重试。开关尚未更改。",
    );
  }
  if (
    !capabilities ||
    typeof capabilities !== "object" ||
    !("computerUseTakeover" in capabilities) ||
    capabilities.computerUseTakeover !== true
  )
    throw new Error(
      "当前后端尚不支持 CUA 接管，请更新并重启 Panel 服务或桌面应用后重试。开关尚未更改。",
    );
  if (
    taskControl &&
    (!("computerUseTaskControl" in capabilities) ||
      capabilities.computerUseTaskControl !== true)
  )
    throw new Error(
      "当前后端尚不支持本任务控制，请更新并重启 Panel 服务或桌面应用后重试。授权尚未更改。",
    );
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
  if (
    method === "POST" &&
    /^\/workspaces\/[^/]+\/nodes\/[^/]+\/inputs$/.test(path)
  ) {
    let capabilities: { runInputs?: boolean };
    try {
      const response = await fetch("/api/capabilities", { cache: "no-store" });
      if (!response.ok) throw new Error("Capability request failed");
      capabilities = await response.json();
    } catch {
      throw new Error(
        "无法确认当前后端支持运行中引导，请检查连接后重试。消息尚未发送。",
      );
    }
    if (capabilities?.runInputs !== true)
      throw new Error(
        "当前后端尚不支持运行中引导，请更新并重启 Panel 服务或桌面应用后重试。消息尚未发送。",
      );
  }
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
  if (
    method === "POST" &&
    /^\/workspaces\/[^/]+\/nodes(?:\/[^/]+\/regenerate)?$/.test(path) &&
    body &&
    typeof body === "object" &&
    "toolRequests" in body &&
    Array.isArray(body.toolRequests) &&
    body.toolRequests.length
  )
    await requireToolRequests();
  if (
    method === "POST" &&
    /^\/workspaces\/[^/]+\/nodes(?:\/[^/]+\/regenerate)?$/.test(path) &&
    body &&
    typeof body === "object" &&
    (("config" in body &&
      body.config &&
      typeof body.config === "object" &&
      "longTask" in body.config &&
      body.config.longTask === true) ||
      ("toolRequests" in body &&
        Array.isArray(body.toolRequests) &&
        body.toolRequests.some((tool) =>
          ["computer_use", "subagents"].includes(tool),
        )))
  )
    await requireLongTasks();
  if (
    method === "POST" &&
    /^\/workspaces\/[^/]+\/nodes\/[^/]+\/computer-use-takeover$/.test(path)
  )
    await requireComputerUseTakeover(
      !!body &&
        typeof body === "object" &&
        "mode" in body &&
        body.mode === "task",
    );
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
