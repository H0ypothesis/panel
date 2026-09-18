import type { AppState } from "../shared/types";

export async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
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
