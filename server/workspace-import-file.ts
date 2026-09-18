import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { MAX_IMPORT_BYTES } from "./workspace-import.ts";

/** Reads only the user-selected local JSON file; never follows a URL. */
export async function readWorkspaceImportFile(
  value: unknown,
): Promise<unknown> {
  if (typeof value !== "string" || !value.trim() || value.length > 4096)
    throw new Error("请填写有效的 JSON 文件路径。");
  const supplied = value.trim();
  const path = supplied.startsWith("~/")
    ? join(homedir(), supplied.slice(2))
    : supplied;
  if (!isAbsolute(path))
    throw new Error("JSON 文件路径必须为绝对路径或以 ~/ 开头。");

  // Nonblocking open also lets us reject FIFOs without hanging the request.
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK,
  ).catch(() => {
    throw new Error("无法读取 JSON 文件，请检查路径及读取权限。");
  });
  try {
    const info = await file.stat();
    if (!info.isFile())
      throw new Error("请选择 JSON 文件，不能导入目录或特殊文件。");
    if (info.size > MAX_IMPORT_BYTES)
      throw new Error("JSON 文件不能超过 20 MB。");
    const chunks: Buffer[] = [];
    let size = 0;
    // Bound the actual read too, in case another process grows the file.
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > MAX_IMPORT_BYTES) throw new Error("JSON 文件不能超过 20 MB。");
      chunks.push(chunk);
    }
    try {
      return JSON.parse(
        Buffer.concat(chunks)
          .toString("utf8")
          .replace(/^\uFEFF/, ""),
      );
    } catch {
      throw new Error("文件不是有效的 JSON，请选择 Panel 导出的 JSON 文件。");
    }
  } finally {
    await file.close();
  }
}
