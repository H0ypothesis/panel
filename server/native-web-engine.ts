import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { PiWebResult } from "./pi-web-access.ts";
import { readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  validateNativeWebRequest,
  type NativeWebRequest,
} from "./native-web-contract.ts";
import { webUrl } from "./web-transport.ts";

const require = createRequire(import.meta.url);
const pluginModule = (name: string) =>
  import(pathToFileURL(require.resolve(`pi-web-access/${name}.ts`)).href);

/** Resolve the plugin's private PDF text artifact before exposing it to a model. */
export async function hydratePiWebPdf(content: string): Promise<string> {
  const pdf =
    /^PDF extracted and saved to: (.+)\n\nPages: \d+\nCharacters: \d+$/.exec(
      content,
    );
  if (!pdf) return content;
  const root = await realpath(join(tmpdir(), "pi-web-pdf"));
  const path = await realpath(pdf[1]);
  if (!path.startsWith(root + sep))
    throw new Error("PDF 提取路径超出了本次调用的临时目录。");
  return `PDF 文本（原始 PDF 尚未保存到工作目录）：\n\n${await readFile(path, "utf8")}`;
}

/** One actual upstream extension instance per isolated worker; no copied tool implementations. */
export async function createNativeWebHost() {
  const tools = new Map<string, ToolDefinition>();
  const hooks = new Map<
    string,
    Array<(event: unknown, context: ExtensionContext) => unknown>
  >();
  const notifications: string[] = [];
  const waiters = new Set<() => void>();
  const { default: extension } = await pluginModule("index");
  const storage = await pluginModule("storage");
  const context = {
    hasUI: false,
    cwd: process.cwd(),
    sessionManager: { getBranch: () => [] },
  } as unknown as ExtensionToolContext;
  // Only the headless API used by this pinned extension. Unsupported interactive
  // operations are not exposed, and the config disables model/browser providers.
  extension({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    on(
      name: string,
      hook: (event: unknown, context: ExtensionContext) => unknown,
    ) {
      const list = hooks.get(name) ?? [];
      list.push(hook);
      hooks.set(name, list);
      return () => {
        const index = list.indexOf(hook);
        if (index >= 0) list.splice(index, 1);
      };
    },
    registerShortcut() {},
    registerCommand() {},
    appendEntry() {}, // Upstream storage owns this run's cache; no ambient Pi transcript.
    sendMessage(message: { content: string }) {
      notifications.push(message.content);
      for (const notify of waiters) notify();
    },
  } as unknown as ExtensionAPI);
  for (const hook of hooks.get("session_start") ?? [])
    await hook({ type: "session_start" }, context);

  function sourcesFor(id: unknown): PiWebResult["sources"] {
    if (typeof id !== "string") return [];
    const stored = storage.getResult(id);
    const sources =
      stored?.type === "search"
        ? stored.queries.flatMap(
            (query: { results: unknown[] }) => query.results,
          )
        : stored?.type === "research"
          ? stored.artifact.sources
          : (stored?.urls ?? []);
    return sources.flatMap((source: { title?: string; url: string }) => {
      try {
        return [
          {
            title: source.title || new URL(source.url).hostname,
            url: webUrl(source.url).href,
          },
        ];
      } catch {
        return [];
      }
    });
  }
  async function hydrateFetchedPdf(id: unknown) {
    if (typeof id !== "string") return false;
    const data = storage.getResult(id);
    if (data?.type !== "fetch") return false;
    let changed = false;
    for (const page of data.urls) {
      const text = await hydratePiWebPdf(page.content);
      if (text !== page.content) {
        page.content = text;
        changed = true;
      }
    }
    if (changed) storage.storeFetchedContentResult(id, data);
    return changed;
  }
  return {
    tools,
    async execute(
      request: NativeWebRequest,
      signal?: AbortSignal,
    ): Promise<PiWebResult> {
      const args = validateNativeWebRequest(request);
      signal?.throwIfAborted();
      const tool = tools.get(request.name);
      if (!tool) throw new Error(`pi-web-access 未注册 ${request.name}。`);
      const notificationStart = notifications.length;
      const result = await tool.execute(
        crypto.randomUUID(),
        args,
        signal,
        undefined,
        context,
      );
      signal?.throwIfAborted();
      const details = (result.details ?? {}) as Record<string, unknown>;
      if (details.error || result.isError)
        throw new Error(
          String(
            details.error ??
              result.content
                .filter((item) => item.type === "text")
                .map((item) => item.text)
                .join("\n"),
          ),
        );
      if (request.name === "web_search" && details.successfulQueries === 0)
        throw new Error(
          result.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n"),
        );
      // Finish includeContent's fetches inside the approved invocation. A worker
      // must never continue network work after that tool has been reported done.
      if (
        details.fetchId &&
        Array.isArray(details.fetchUrls) &&
        details.fetchUrls.length
      ) {
        const ready = () =>
          notifications
            .slice(notificationStart)
            .some(
              (text) =>
                text.includes(String(details.fetchId)) ||
                text.startsWith("Content fetch failed"),
            );
        if (!ready())
          await new Promise<void>((resolve, reject) => {
            const finish = () => {
              if (ready()) {
                cleanup();
                resolve();
              }
            };
            const abort = () => {
              cleanup();
              reject(signal?.reason ?? new Error("已取消"));
            };
            const cleanup = () => {
              waiters.delete(finish);
              signal?.removeEventListener("abort", abort);
            };
            waiters.add(finish);
            signal?.addEventListener("abort", abort, { once: true });
            if (signal?.aborted) abort();
            else finish();
          });
      }
      signal?.throwIfAborted();
      const responseId =
        details.responseId ?? details.searchId ?? args.responseId;
      let outputContent = result.content;
      const hydrated = await hydrateFetchedPdf(responseId);
      await hydrateFetchedPdf(details.fetchId);
      if (hydrated && request.name === "fetch_content") {
        const data = storage.getResult(responseId);
        details.totalChars = data.urls.reduce(
          (sum: number, page: { content: string }) => sum + page.content.length,
          0,
        );
        if (data.urls.length === 1) {
          const page = await tools
            .get("get_search_content")!
            .execute(
              crypto.randomUUID(),
              { responseId, urlIndex: 0 },
              signal,
              undefined,
              context,
            );
          outputContent = page.content;
          Object.assign(details, page.details);
        }
      }
      return {
        text:
          outputContent
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n") +
          (details.fetchUrls
            ? "\nPanel 已等待本次附带的原文获取结束，可按 fetchId 读取正文或失败信息。"
            : ""),
        sources: sourcesFor(responseId),
        details: { ...details, ...(responseId ? { responseId } : {}) },
      };
    },
    async close() {
      for (const hook of hooks.get("session_shutdown") ?? [])
        await hook({ type: "session_shutdown" }, context);
    },
  };
}
