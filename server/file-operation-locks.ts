import { lstat, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  BACKGROUND_CONTEXT,
  type Context,
} from "../pi/packages/agent/src/harness/context.ts";
import { NodeExecutionEnv } from "../pi/packages/agent/src/harness/env/nodejs.ts";
import {
  resolveReadToolPath,
  resolveToolPath,
} from "../pi/packages/agent/src/harness/tools/path-utils.ts";

export interface FileOperationResource {
  /** Shell commands and hard links may affect paths outside their apparent cwd. */
  global: boolean;
  mode: "read" | "write";
  workingDirectory: string;
  canonicalPath?: string;
  /** A restore reserves all of its affected paths in one atomic lock request. */
  canonicalPaths?: string[];
  /** Undefined means a full workspace snapshot; ordinary files use one path. */
  snapshotPaths?: string[];
}

function isWithin(parent: string, child: string) {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function lockPath(path: string) {
  // Missing filenames have no realpath yet. On common macOS/Windows volumes,
  // spelling or Unicode normalization variants may still name the same file.
  // Conservatively serialize these even on case-sensitive volumes.
  return process.platform === "darwin" || process.platform === "win32"
    ? path.normalize("NFC").toLowerCase()
    : path;
}

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function boundedCanonicalPath(
  workingDirectory: string,
  addressed: string,
) {
  // lstat must precede realpath: a dangling symlink is not an absent directory.
  let existing = addressed;
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if (!isMissing(error) || dirname(existing) === existing) throw error;
      existing = dirname(existing);
    }
  }
  const canonicalPath = resolve(
    await realpath(existing),
    relative(existing, addressed),
  );
  if (!isWithin(workingDirectory, canonicalPath)) {
    throw new Error("文件路径超出当前工作目录。");
  }
  return canonicalPath;
}

/** Match WorkspaceExecutionEnv's canonicalization before Pi's read variants. */
class ResourcePathEnv extends NodeExecutionEnv {
  override async absolutePath(path: string, context: Context) {
    const addressed = await super.absolutePath(path, context);
    return addressed.ok
      ? {
          ok: true as const,
          value: await boundedCanonicalPath(this.cwd, addressed.value),
        }
      : addressed;
  }

  override async fileInfo(path: string, context: Context) {
    const addressed = await this.absolutePath(path, context);
    return addressed.ok ? super.fileInfo(addressed.value, context) : addressed;
  }
}

/**
 * Reuse Pi's complete tool-path normalization, including @, Unicode spaces,
 * home/file URLs and read filename variants, with Panel's directory boundary.
 */
export async function resolveFileOperationResource(
  cwd: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<FileOperationResource | undefined> {
  if (!["read", "write", "edit", "bash"].includes(toolName)) return undefined;
  const workingDirectory = await realpath(cwd);
  if (!(await stat(workingDirectory)).isDirectory()) {
    throw new Error("工作目录必须是文件夹。");
  }
  if (toolName === "bash") {
    return { global: true, mode: "write", workingDirectory };
  }
  if (typeof args.path !== "string" || args.path.length === 0) {
    throw new Error("文件操作必须指定有效路径。");
  }
  const env = new ResourcePathEnv({ cwd: workingDirectory });
  const resolver = toolName === "read" ? resolveReadToolPath : resolveToolPath;
  const addressed = await resolver(env, args.path, BACKGROUND_CONTEXT);
  const canonicalPath = await boundedCanonicalPath(workingDirectory, addressed);
  let global = false;
  try {
    const info = await stat(canonicalPath);
    // Directories commonly have nlink > 1 without being aliases. File hard
    // links, however, can alias any workspace, so serialize them globally.
    global = !info.isDirectory() && info.nlink > 1;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return {
    global,
    mode: toolName === "read" ? "read" : "write",
    workingDirectory,
    canonicalPath,
    ...(global ? {} : { snapshotPaths: [canonicalPath] }),
  };
}

/**
 * Call after acquire and before snapshots/execution. A queued symlink or cwd
 * may have changed its target, or a file may have gained a hard-link alias.
 * On failure, release the old lock and fail/re-resolve the operation. These
 * process-local locks do not prevent unrelated programs from changing files.
 */
export async function validateFileOperationResource(
  resource: FileOperationResource | undefined,
  cwd: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<void> {
  const current = await resolveFileOperationResource(cwd, toolName, args);
  if (
    resource?.workingDirectory !== current?.workingDirectory ||
    resource?.canonicalPath !== current?.canonicalPath ||
    resource?.global !== current?.global ||
    resource?.mode !== current?.mode
  ) {
    throw new Error("等待期间文件路径或工作目录已变化，请重新发起操作。");
  }
}

/** Git paths are literal filenames, not Pi tool aliases such as @ or file URLs. */
export async function resolveRestoreFileResource(
  cwd: string,
  paths: readonly string[],
): Promise<FileOperationResource | undefined> {
  if (!paths.length) return undefined;
  const workingDirectory = await realpath(cwd);
  if (!(await stat(workingDirectory)).isDirectory())
    throw new Error("Git 回溯工作目录必须是文件夹。");
  const canonicalPaths = new Set<string>();
  let global = false;
  for (const path of paths) {
    if (
      !path ||
      isAbsolute(path) ||
      path.includes("\0") ||
      path.includes("\\") ||
      path
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            [".git", "node_modules"].includes(part.toLowerCase()),
        )
    )
      throw new Error(`Git 回溯路径无效：${path}`);
    const absolute = resolve(workingDirectory, path);
    const parent = await boundedCanonicalPath(
      workingDirectory,
      dirname(absolute),
    );
    canonicalPaths.add(resolve(parent, basename(absolute)));
    try {
      const info = await lstat(absolute);
      // Restoring a link can redirect a tool whose resolved target lies outside
      // this path set. Keep these uncommon cases mutually exclusive with tools.
      global ||=
        info.isSymbolicLink() || (!info.isDirectory() && info.nlink > 1);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return {
    global,
    mode: "write",
    workingDirectory,
    canonicalPaths: [...canonicalPaths].sort(),
  };
}

export function fileOperationsConflict(
  a: FileOperationResource,
  b: FileOperationResource,
) {
  if (a.global || b.global) return true;
  if (a.mode === "read" && b.mode === "read") return false;
  const aPaths = a.canonicalPaths ?? (a.canonicalPath ? [a.canonicalPath] : []);
  const bPaths = b.canonicalPaths ?? (b.canonicalPath ? [b.canonicalPath] : []);
  // A malformed resource must never accidentally omit synchronization.
  if (!aPaths.length || !bPaths.length) return true;
  return aPaths.some((a) =>
    bPaths.some((b) => {
      const aPath = lockPath(a);
      const bPath = lockPath(b);
      return isWithin(aPath, bPath) || isWithin(bPath, aPath);
    }),
  );
}

interface LockRequest {
  resource: FileOperationResource;
  grant: (release: () => void) => void;
  reject: (reason: unknown) => void;
  cleanup: () => void;
}

/**
 * Fair among conflicting operations; independent files may bypass waiters.
 * Aborting removes only queued requests. Holders must release in a finally
 * block after the tool AND its final snapshot have finished, even on abort.
 */
export class FileOperationLocks {
  private readonly active = new Set<LockRequest>();
  private readonly waiting: LockRequest[] = [];

  acquire(
    resource: FileOperationResource | undefined,
    signal?: AbortSignal,
    onWait?: () => void,
  ): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!resource) return Promise.resolve(() => {});
    return new Promise((grant, reject) => {
      const request: LockRequest = {
        // Callers cannot alter which resource a pending or active lock covers.
        resource: {
          ...resource,
          ...(resource.canonicalPaths
            ? { canonicalPaths: [...resource.canonicalPaths] }
            : {}),
        },
        grant,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      const abort = () => {
        const index = this.waiting.indexOf(request);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        request.cleanup();
        reject(signal?.reason);
        this.drain();
      };
      this.waiting.push(request);
      signal?.addEventListener("abort", abort, { once: true });
      this.drain();
      if (this.waiting.includes(request)) {
        try {
          onWait?.();
        } catch (error) {
          const index = this.waiting.indexOf(request);
          if (index >= 0) {
            this.waiting.splice(index, 1);
            request.cleanup();
            request.reject(error);
            this.drain();
          }
        }
      }
    });
  }

  private drain() {
    const earlier: LockRequest[] = [];
    for (let index = 0; index < this.waiting.length; ) {
      const request = this.waiting[index];
      if (
        [...this.active, ...earlier].some((other) =>
          fileOperationsConflict(request.resource, other.resource),
        )
      ) {
        earlier.push(request);
        index += 1;
        continue;
      }
      this.waiting.splice(index, 1);
      request.cleanup();
      this.active.add(request);
      let released = false;
      request.grant(() => {
        if (released) return;
        released = true;
        this.active.delete(request);
        this.drain();
      });
    }
  }
}
