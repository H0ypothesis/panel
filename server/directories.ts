import {
  access,
  lstat,
  mkdir,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export function temporaryWorkspaceDirectory(dataDirectory: string, id: string) {
  // Workspace IDs are server-generated and immutable. Never interpret one as a path.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id))
    throw new Error("空间 ID 无效，无法确定临时工作目录。");
  return join(dataDirectory, "workspaces", id);
}

export async function prepareTemporaryDirectory(
  dataDirectory: string,
  id: string,
): Promise<string> {
  const directory = temporaryWorkspaceDirectory(dataDirectory, id);
  try {
    for (const path of [dirname(directory), directory]) {
      try {
        // Do not recursively follow an existing symlink into another space.
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== path)
        throw new Error("临时目录不能是符号链接或普通文件。");
      await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
    }
    return directory;
  } catch (error) {
    throw new Error(
      `无法准备临时工作目录 ${directory}，请检查路径和权限，或选择其他工作目录。`,
      { cause: error },
    );
  }
}

export async function workingDirectory(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value.trim() || value.length > 4096)
    throw new Error("请选择有效的本地工作目录。");
  const expanded =
    value === "~"
      ? homedir()
      : value.startsWith("~/")
        ? join(homedir(), value.slice(2))
        : value;
  if (!isAbsolute(expanded)) throw new Error("工作目录必须是绝对路径。");
  try {
    const path = await realpath(expanded);
    if (!(await stat(path)).isDirectory()) throw new Error("not a directory");
    await access(path, constants.R_OK | constants.X_OK);
    return path;
  } catch {
    throw new Error("工作目录不存在或无法访问，请检查路径和权限。");
  }
}

export function directoriesOverlap(first: string, second: string): boolean {
  const contains = (a: string, b: string) => {
    const path = relative(a, b);
    return (
      path === "" ||
      (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
    );
  };
  return contains(first, second) || contains(second, first);
}

export async function listDirectories(value?: string | null) {
  const path = await workingDirectory(value || resolve(process.cwd()));
  const entries = await readdir(path, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({ name: entry.name, path: join(path, entry.name) }));
  return {
    path,
    parent: dirname(path) === path ? null : dirname(path),
    directories,
  };
}
