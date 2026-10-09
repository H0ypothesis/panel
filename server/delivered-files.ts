import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
import { responseText } from "../shared/response-parts.ts";
import type { StoredNode } from "./store.ts";

export const FILE_DELIVERY_PROMPT =
  "本轮有要交给用户打开、下载或使用的文件时，在最终答复末尾用三级标题「交付文件」单独列出，每项写实际相对路径或绝对路径（行内代码或 Markdown 链接）。只列用户所需的成果文件；网页配图等依赖、临时文件、日志、处理脚本和普通代码修改不自动算成果。用户明确要脚本或图片时，它们可以是交付文件。没有交付文件时省略这一节，不编造路径。";

/** The accumulated response includes progress messages, so prefer the final transcript turn. */
function finalAnswer(node: StoredNode) {
  if (node.status !== "completed") return "";
  if (!node.messages?.length) return responseText(node.response);
  for (let index = node.messages.length - 1; index >= 0; index--) {
    const message = node.messages[index];
    if (message.role === "user") return "";
    if (message.role !== "assistant") continue;
    if (
      message.stopReason !== "stop" ||
      message.content.some((part) => part.type === "toolCall")
    )
      return "";
    return responseText(
      message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n"),
    );
  }
  return "";
}

function text(node: Nodes): string {
  if ("value" in node) return node.value;
  if ("children" in node) return node.children.map(text).join("");
  return "";
}

function localPath(value: string) {
  if (/^(?:https?:|mailto:|data:|#|\/\/)/i.test(value)) return undefined;
  try {
    return decodeURIComponent(value.replace(/^(?:file:\/\/|sandbox:)/i, ""));
  } catch {
    return undefined;
  }
}

function references(node: Nodes, definitions: Map<string, string>): string[] {
  // Image embeds describe supporting resources rather than a delivered file.
  if (["image", "imageReference", "html", "definition"].includes(node.type))
    return [];
  if (node.type === "link" || node.type === "linkReference") {
    const path = localPath(
      node.type === "link"
        ? node.url
        : (definitions.get(node.identifier) ?? "#"),
    );
    return path ? [path] : [];
  }
  if ("value" in node) return [node.value];
  if ("children" in node)
    return node.children.flatMap((child) => references(child, definitions));
  return [];
}

const explicitHeading =
  /^(?:交付文件|交付成果|交付物|成果文件|deliverables?|output files?)\s*[:：]?$/i;
const deliveryHeading =
  /^(?:文件|生成文件|输出文件|完整报告|最终成果|打开方式|下载|files?|downloads?)\s*[:：]?$/i;
const deliveryCue =
  /交付|完整报告|最终(?:成果|文件|报告)|(?:文件(?:路径)?|报告|脚本|图片|压缩包)\s*[:：]|(?:打开|下载)(?:方式)?|已(?:生成|保存|输出|更新).{0,16}(?:文件|报告|网页|脚本|图片)|\b(?:deliverables?|download|open|output file|final report)\b/i;
const processCue =
  /临时|中间(?:文件|产物)|辅助(?:文件|脚本)|配套(?:资源|文件)|依赖|缓存|调试|已删除|不存在|未(?:生成|保存)|\b(?:temporary|intermediate|dependencies|deleted|missing)\s+(?:file|files|resource|resources)\b/i;

function heading(node: Nodes) {
  return text(node)
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
}

function standaloneReference(node: Nodes) {
  if (node.type !== "paragraph") return false;
  return node.children.every(
    (child) =>
      child.type === "inlineCode" ||
      (child.type === "link" && Boolean(localPath(child.url))) ||
      (child.type === "text" && /^[\s,，;；]*$/.test(child.value)),
  );
}

/** Explicit delivery sections are authoritative; legacy answers need a delivery cue. */
export function deliveredFileReferences(node: StoredNode): string[] {
  const answer = finalAnswer(node);
  if (!answer) return [];
  const document = fromMarkdown(answer);
  const definitions = new Map(
    document.children.flatMap((part) =>
      part.type === "definition" ? [[part.identifier, part.url] as const] : [],
    ),
  );
  const explicit = document.children.some(
    (part) => part.type === "heading" && explicitHeading.test(heading(part)),
  );
  // Without a transcript, a tool run's accumulated prose has no reliable final boundary.
  if (!node.messages?.length && node.toolCalls?.length && !explicit) return [];
  const result: string[] = [];
  let section: { depth: number; delivery: boolean } | undefined;
  let previousCue = false;
  const visit = (part: Nodes, inSection: boolean) => {
    if (part.type === "blockquote") return;
    if (part.type === "paragraph") {
      const sentences: (typeof part.children)[] = [[]];
      for (const child of part.children) {
        if (child.type !== "text") sentences.at(-1)!.push(child);
        else {
          const pieces = child.value.split(/(?<=[。！？])|\n+/);
          for (const [index, value] of pieces.entries()) {
            if (index) sentences.push([]);
            if (value) sentences.at(-1)!.push({ type: "text", value });
          }
        }
      }
      if (sentences.length > 1) {
        for (const children of sentences)
          if (children.length)
            visit({ type: "paragraph", children }, inSection);
        return;
      }
    }
    if (part.type === "list" || part.type === "listItem") {
      // Every list item owns its context; a delivery entry cannot bless the next item.
      const previous = previousCue;
      for (const child of part.children) {
        if (part.type === "list") previousCue = previous;
        visit(child, inSection);
      }
      previousCue = previous;
      return;
    }
    const value = text(part);
    const cue = part.type !== "code" && deliveryCue.test(value);
    const label =
      /^(?:网页版.*|Markdown\s*(?:原始|完整)?报告|原始报告)\s*[:：]?$/i.test(
        value.trim(),
      );
    const eligible =
      inSection ||
      (!explicit &&
        (cue ||
          standaloneReference(part) ||
          (part.type === "code" && previousCue)));
    if (eligible && (explicit || !processCue.test(value)))
      result.push(...references(part, definitions));
    previousCue = cue || label;
  };
  for (const part of document.children) {
    if (part.type === "heading") {
      if (section && part.depth <= section.depth) section = undefined;
      const delivery = explicit
        ? explicitHeading.test(heading(part))
        : deliveryHeading.test(heading(part));
      if (delivery) section = { depth: part.depth, delivery: true };
      previousCue = false;
      continue;
    }
    visit(part, section?.delivery ?? false);
  }
  return result;
}

function mentions(reference: string, path: string) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[\\s\u0060\"'<>()[\\]（：:,;=])(?:\\./)?${escaped}(?=$|[\\s\u0060\"'<>()[\\]（），。；！？,;：:!?]|\\.(?:\\s|$))`,
  ).test(reference);
}

/** Match only recorded candidates, and never guess between duplicate filenames. */
export function selectDeliveredFiles<
  T extends { path: string; absolute: string },
>(files: T[], node: StoredNode): T[] {
  const aliases = new Map<string, Set<T>>();
  for (const file of files)
    for (const alias of [
      file.path,
      file.absolute,
      file.path.split("/").at(-1)!,
    ]) {
      const matches = aliases.get(alias) ?? new Set<T>();
      matches.add(file);
      aliases.set(alias, matches);
    }
  const selected = new Set<T>();
  for (const reference of deliveredFileReferences(node))
    for (const [alias, matches] of aliases)
      if (matches.size === 1 && mentions(reference, alias))
        selected.add(matches.values().next().value!);
  return files.filter((file) => selected.has(file));
}
