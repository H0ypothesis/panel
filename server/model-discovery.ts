import {
  validContextWindow,
  type ProviderModel,
  type ProviderModelCatalog,
} from "../shared/provider-settings.ts";

type CatalogFormat = "openai" | "anthropic" | "google" | "paperbypass";
class CatalogError extends Error {}
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 5000;

async function readCatalog(
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.body) throw new CatalogError("模型列表响应为空。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES)
        throw new CatalogError("模型列表响应过大，请手动填写 Model ID。");
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Invalid catalog");
    return body;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Read-only discovery never registers models or changes the saved connection. */
export async function discoverModels(
  baseUrl: string,
  format: CatalogFormat,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<ProviderModelCatalog> {
  const timeout = AbortSignal.timeout(12_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const base = baseUrl.replace(/\/+$/, "");
  const versioned = /\/v\d+(?:beta\d*)?$/.test(new URL(base).pathname);
  const needsVersion =
    (format === "anthropic" || format === "paperbypass") && !versioned;
  const endpoint = new URL(`${base}${needsVersion ? "/v1" : ""}/models`);
  const models = new Map<string, ProviderModel>();
  const cursors = new Set<string>();
  let truncated = false;
  try {
    for (let page = 0; page < 20; page++) {
      combined.throwIfAborted();
      const response = await fetch(endpoint, {
        headers: { Accept: "application/json", ...headers },
        redirect: "error",
        signal: combined,
      });
      if (!response.ok) {
        await response.body?.cancel();
        const reason =
          response.status === 401 || response.status === 403
            ? "认证失败，请检查 API Key 和模型列表访问权限。"
            : response.status === 404 || response.status === 405
              ? "服务未提供模型列表接口，可手动填写 Model ID。"
              : response.status === 429
                ? "请求过于频繁，请稍后刷新模型列表。"
                : `获取模型列表失败（HTTP ${response.status}），可稍后重试或手动填写。`;
        throw new CatalogError(reason);
      }
      const body = await readCatalog(response);
      if (body.success === false)
        throw new CatalogError("服务未能返回模型列表，请稍后重试或手动填写。");
      const entries = format === "google" ? body.models : body.data;
      if (!Array.isArray(entries))
        throw new CatalogError(
          "服务返回的模型列表格式不受支持，可手动填写 Model ID。",
        );
      let recognized = false;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue;
        const id =
          format === "google"
            ? typeof entry.name === "string"
              ? entry.name.replace(/^models\//, "")
              : undefined
            : format === "paperbypass"
              ? (entry.slug ?? entry.id)
              : entry.id;
        if (
          typeof id !== "string" ||
          !id ||
          id.length > 240 ||
          /[\s\u0000-\u001f\u007f]/.test(id)
        )
          continue;
        recognized = true;
        if (
          format === "google" &&
          Array.isArray(entry.supportedGenerationMethods) &&
          !entry.supportedGenerationMethods.includes("generateContent")
        )
          continue;
        const display = entry.display_name ?? entry.displayName ?? entry.name;
        const name =
          typeof display === "string" &&
          display.trim() &&
          display.length <= 240 &&
          !/[\u0000-\u001f\u007f]/.test(display)
            ? display.trim()
            : id;
        const contextWindow = validContextWindow(entry.contextWindow)
          ? entry.contextWindow
          : models.get(id)?.contextWindow;
        models.set(id, {
          id,
          name,
          ...(validContextWindow(contextWindow) ? { contextWindow } : {}),
        });
        if (models.size >= MAX_MODELS) {
          truncated = true;
          break;
        }
      }
      if (entries.length && !recognized)
        throw new CatalogError(
          "无法识别服务返回的模型 ID 格式，可手动填写 Model ID。",
        );
      const cursor =
        format === "google"
          ? body.nextPageToken
          : body.has_more
            ? body.last_id
            : undefined;
      if (body.has_more && !cursor && format !== "google")
        throw new CatalogError(
          "服务返回的模型分页信息无效，可手动填写 Model ID。",
        );
      if (!cursor) break;
      if (
        typeof cursor !== "string" ||
        cursor.length > 2048 ||
        cursors.has(cursor)
      )
        throw new CatalogError(
          "服务返回的模型分页信息无效，可手动填写 Model ID。",
        );
      if (truncated || page === 19) {
        truncated = true;
        break;
      }
      cursors.add(cursor);
      endpoint.searchParams.set(
        format === "google" ? "pageToken" : "after_id",
        cursor,
      );
    }
    return {
      models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)),
      truncated,
    };
  } catch (error) {
    if (error instanceof CatalogError) throw error;
    if (timeout.aborted)
      throw new Error("获取模型列表超时，请重试或手动填写 Model ID。");
    if (signal?.aborted) throw new Error("获取模型列表已取消。");
    // Network/parser diagnostics and provider bodies may echo credentials.
    throw new Error(
      "无法获取模型列表，请检查 API URL、网络和接口格式；也可手动填写 Model ID。",
    );
  }
}
