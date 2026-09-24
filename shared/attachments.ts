export interface AttachmentUpload {
  name: string;
  mediaType: string;
  /** The file bytes as canonical base64, without a data URL prefix. */
  data: string;
}

export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  kind: "text" | "pdf" | "image";
  truncated?: boolean;
  extractedCharacters?: number;
}

export const MAX_ATTACHMENT_COUNT = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024;
// Base64 expands 20 MiB to ~26.7 MiB. Leave room for prompts and JSON framing.
export const MAX_ATTACHMENT_REQUEST_BYTES = 29 * 1024 * 1024;
export const ATTACHMENT_PATH_HINT =
  "可在消息中发送本机文件的绝对路径，让模型按需选择读取方式。";

const textExtensions = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "sass",
  "less",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "sh",
  "bash",
  "zsh",
  "sql",
  "toml",
  "ini",
  "conf",
  "config",
  "log",
  "vue",
  "svelte",
  "swift",
  "kt",
  "kts",
  "r",
  "tex",
  "ipynb",
  "env",
  "gitignore",
  "dockerignore",
]);
const imageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function extension(name: string) {
  return name.trim().toLowerCase().split(".").at(-1) ?? "";
}

export function attachmentKind(name: string): Attachment["kind"] | undefined {
  const ext = extension(name);
  if (ext === "pdf") return "pdf";
  if (Object.hasOwn(imageTypes, ext)) return "image";
  if (textExtensions.has(ext)) return "text";
  return undefined;
}

export function attachmentMediaType(name: string): string | undefined {
  const ext = extension(name);
  if (ext === "pdf") return "application/pdf";
  if (Object.hasOwn(imageTypes, ext)) return imageTypes[ext];
  if (!textExtensions.has(ext)) return undefined;
  if (ext === "json" || ext === "ipynb") return "application/json";
  if (ext === "xml") return "application/xml";
  if (ext === "csv") return "text/csv";
  if (ext === "html" || ext === "htm") return "text/html";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  return "text/plain";
}

export const ATTACHMENT_ACCEPT = [
  ...[...textExtensions].map((ext) => `.${ext}`),
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
].join(",");

export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentSelectionError(
  files: readonly { name: string; size: number }[],
): string | undefined {
  if (files.length > MAX_ATTACHMENT_COUNT)
    return `每条消息最多上传 ${MAX_ATTACHMENT_COUNT} 个文件。`;
  let total = 0;
  for (const file of files) {
    if (!attachmentKind(file.name))
      return `不支持文件「${file.name}」，请选择文本、代码、PDF 或 PNG/JPEG/WebP 图片。`;
    if (!Number.isSafeInteger(file.size) || file.size <= 0)
      return `文件「${file.name}」为空或大小无效。`;
    if (file.size > MAX_ATTACHMENT_BYTES)
      return `文件「${file.name}」超过 10 MB。${ATTACHMENT_PATH_HINT}`;
    total += file.size;
  }
  if (total > MAX_ATTACHMENTS_BYTES)
    return `每条消息的附件总大小不能超过 20 MB。${ATTACHMENT_PATH_HINT}`;
  return undefined;
}
