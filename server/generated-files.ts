import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  generatedFileSources,
  type GeneratedFile,
} from "../shared/generated-files.ts";
import type { StoredNode, StoredWorkspace } from "./store.ts";
import { selectDeliveredFiles } from "./delivered-files.ts";

const previewTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};
const textExtensions = new Set([
  ".md",
  ".txt",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".log",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".css",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".sql",
  ".sh",
  ".rs",
  ".go",
  ".c",
  ".h",
  ".cpp",
  ".swift",
]);
// These are documents handled by default applications, not executable bundles/scripts.
const nativeExtensions = new Set([
  ...Object.keys(previewTypes),
  ".md",
  ".txt",
  ".csv",
  ".tsv",
  ".json",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".rtf",
  ".odt",
  ".ods",
  ".odp",
  ".mp3",
  ".wav",
  ".mp4",
  ".mov",
]);
const excludedDirectories = new Set(["node_modules", "__pycache__"]);

export class GeneratedFileError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function inside(root: string, path: string) {
  const suffix = relative(root, path);
  return (
    !!suffix &&
    !isAbsolute(suffix) &&
    suffix !== ".." &&
    !suffix.startsWith(`..${sep}`)
  );
}

/** Only recorded parent/child execution directories may own file candidates. */
function candidates(
  workspace: StoredWorkspace,
  node: StoredNode,
  fallback: string,
) {
  const files = new Map<
    string,
    { id: string; root: string; absolute: string; path: string }
  >();
  for (const source of generatedFileSources(
    { ...workspace, temporaryDirectory: fallback },
    node,
  )) {
    const owner =
      source.nodeId === node.id
        ? node
        : workspace.nodes.find((item) => item.id === source.nodeId);
    if (!owner) continue;
    const base = resolve(
      owner.execution?.workingDirectory ??
        workspace.workingDirectory ??
        fallback,
    );
    const roots = new Set([
      base,
      ...(owner.subagents ?? []).flatMap((child) =>
        child.workingDirectory ? [resolve(child.workingDirectory)] : [],
      ),
    ]);
    const root = resolve(source.workingDirectory ?? base);
    if (
      !roots.has(root) ||
      source.path.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(source.path)
    )
      continue;
    const absolute = resolve(root, source.path);
    if (!inside(root, absolute)) continue;
    const path = relative(root, absolute);
    // Internal sessions, credentials, Git data and handoffs are not deliverables.
    if (
      path
        .split(sep)
        .some((part) => part.startsWith(".") || excludedDirectories.has(part))
    )
      continue;
    const id = createHash("sha256")
      .update(root)
      .update("\0")
      .update(path)
      .digest("hex");
    files.set(id, { id, root, absolute, path });
  }
  return [...files.values()];
}

type Candidate = ReturnType<typeof candidates>[number];

async function validatePath(file: Candidate) {
  // Reject replaced execution directories and symlinks in every file component.
  if ((await realpath(file.root)) !== file.root)
    throw new GeneratedFileError("文件路径已变化，无法访问。", 403);
  let current = file.root;
  for (const part of file.path.split(sep)) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink())
      throw new GeneratedFileError("文件路径已变化，无法访问。", 403);
  }
  if (!inside(file.root, await realpath(file.absolute)))
    throw new GeneratedFileError("文件不在本次探索的工作目录内。", 403);
}

function metadata(file: Candidate): GeneratedFile {
  const extension = extname(file.path).toLowerCase();
  const mediaType =
    previewTypes[extension] ??
    (textExtensions.has(extension)
      ? "text/plain; charset=utf-8"
      : "application/octet-stream");
  return {
    id: file.id,
    name: basename(file.path),
    path: file.path,
    mediaType,
    previewable: mediaType !== "application/octet-stream",
    nativeOpenable: nativeExtensions.has(extension),
    status: "available",
  };
}

function accessError(error: unknown): GeneratedFileError {
  if (error instanceof GeneratedFileError) return error;
  if (
    ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")
  )
    return new GeneratedFileError("文件不存在或已删除。", 404);
  return new GeneratedFileError("文件暂时无法访问，请检查文件及权限。", 403);
}

async function openCandidate(file: Candidate) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await validatePath(file);
    handle = await open(
      file.absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new GeneratedFileError("生成路径不是普通文件。", 403);
    await validatePath(file);
    const current = await lstat(file.absolute);
    if (current.ino !== stat.ino || current.dev !== stat.dev)
      throw new GeneratedFileError("文件已变化，请重新打开。", 409);
    return { handle, stat };
  } catch (error) {
    await handle?.close();
    throw accessError(error);
  }
}

export async function listGeneratedFiles(
  workspace: StoredWorkspace,
  node: StoredNode,
  fallback: string,
) {
  return Promise.all(
    selectDeliveredFiles(candidates(workspace, node, fallback), node).map(
      async (file) => {
        const result = metadata(file);
        try {
          const { handle, stat } = await openCandidate(file);
          await handle.close();
          return { ...result, size: stat.size };
        } catch (error) {
          return {
            ...result,
            status:
              accessError(error).status === 404
                ? ("missing" as const)
                : ("unavailable" as const),
          };
        }
      },
    ),
  );
}

export async function serveGeneratedFile(
  request: IncomingMessage,
  response: ServerResponse,
  workspace: StoredWorkspace,
  node: StoredNode,
  fallback: string,
  id: string,
  mode: "native" | "content",
  download: boolean,
) {
  const file = candidates(workspace, node, fallback).find(
    (candidate) => candidate.id === id,
  );
  if (!file) throw new GeneratedFileError("文件未登记在这次回答中。", 404);
  const { handle, stat } = await openCandidate(file);
  try {
    const info = metadata(file);
    if (mode === "native") {
      // Reveal is allowed for every regular file; opening is restricted to documents.
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(
        JSON.stringify({
          path: file.absolute,
          root: file.root,
          nativeOpenable: info.nativeOpenable,
        }),
      );
      return;
    }
    const filename = encodeURIComponent(info.name).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    const inline = !download && info.previewable;
    response.writeHead(200, {
      "Content-Type": inline ? info.mediaType : "application/octet-stream",
      "Content-Length": stat.size,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="generated-file"; filename*=UTF-8''${filename}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
    });
    await pipeline(handle.createReadStream({ autoClose: false }), response);
  } finally {
    await handle.close();
  }
}
