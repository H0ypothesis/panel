import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { PiWebJob, PiWebResult } from "./pi-web-access.ts";
import { webUrl } from "./web-transport.ts";

const require = createRequire(import.meta.url);
const pluginModule = (name: string) =>
  import(pathToFileURL(require.resolve(`pi-web-access/${name}.ts`)).href);
const freshness = { pd: "day", pw: "week", pm: "month", py: "year" };
const MAX_CONTENT = 60_000;

interface SearchResponse {
  answer: string;
  results: Array<{ title: string; url: string; snippet: string }>;
}
interface ExtractedContent {
  title: string;
  url: string;
  content: string;
  error: string | null;
}

// The worker installs Panel's pinned-DNS fetch and isolated config before these
// lazy imports. No extension lifecycle/UI hooks or background fetches run here.
export async function executePiWebJob(
  job: PiWebJob,
  signal?: AbortSignal,
  lookup?: (
    hostname: string,
  ) => Promise<Array<{ address: string; family: number }>>,
): Promise<PiWebResult> {
  signal?.throwIfAborted();
  if (job.kind === "search") {
    const { searchWithExa } = await pluginModule("exa");
    const response: SearchResponse | null = await searchWithExa(job.query, {
      numResults: job.count,
      ...(job.freshness ? { recencyFilter: freshness[job.freshness] } : {}),
      includeContent: false,
      signal,
    });
    if (!response) throw new Error("Exa 没有返回搜索结果。");
    const sources: PiWebResult["sources"] = [];
    const blocks: string[] = [];
    for (const item of response.results.slice(0, job.count)) {
      let url: URL;
      try {
        url = webUrl(item.url);
      } catch {
        continue;
      }
      const title = (item.title || url.hostname).slice(0, 500);
      sources.push({ title, url: url.href });
      blocks.push(
        `${sources.length}. ${title}\n${url.href}\n${(item.snippet || "").slice(0, 2000)}`,
      );
    }
    return {
      text: `Exa 搜索结果\n查询：${job.query}\n\n${blocks.length ? blocks.join("\n\n") : "没有找到匹配结果。"}${response.answer ? `\n\n搜索服务摘要：\n${response.answer.slice(0, 12000)}` : ""}`,
      sources,
    };
  }
  const url = webUrl(job.url).href;
  const { extractContent } = await pluginModule("extract");
  const page: ExtractedContent = await extractContent(url, signal, {
    mode: "readable",
    timeoutMs: 30_000,
    ...(lookup ? { lookup } : {}),
  });
  const partial = page.error?.startsWith(
    "Extracted content appears incomplete",
  );
  if (page.error && (!page.content.trim() || !partial))
    throw new Error(page.error);
  if (!page.content.trim())
    throw new Error(
      "没有提取到可读正文；可能是扫描 PDF 或需要 JavaScript 的页面。",
    );
  // PDF's Markdown cache belongs to this invocation and is removed on exit.
  // Do not present that temporary path as a downloadable user artifact.
  let content = page.content;
  const pdf =
    /^PDF extracted and saved to: (.+)\n\nPages: \d+\nCharacters: \d+$/.exec(
      content,
    );
  if (pdf) {
    const root = await realpath(join(tmpdir(), "pi-web-pdf"));
    const path = await realpath(pdf[1]);
    if (!path.startsWith(root + sep))
      throw new Error("PDF 提取路径超出了本次调用的临时目录。");
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(MAX_CONTENT * 4 + 4);
      const { bytesRead } = await file.read(buffer);
      content = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
    content = `PDF 文本（原始 PDF 尚未保存到工作目录）：\n\n${content}`;
  }
  const title = (page.title || new URL(url).hostname).slice(0, 500);
  return {
    text: `标题：${title}\n来源：${url}\n${partial ? "提示：页面正文较短，提取内容可能不完整。\n" : ""}\n${content.slice(0, MAX_CONTENT)}${content.length > MAX_CONTENT ? "\n[正文已截断]" : ""}`,
    sources: [{ title, url }],
  };
}
