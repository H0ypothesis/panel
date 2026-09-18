import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { deflate } from "node:zlib";
import type { GitHistoryEntry } from "../shared/types.ts";

export interface GitBaseline {
  workingDirectory: string;
  repository: string;
  commit: string;
  /** Exact root-relative files; omitted for a whole-directory snapshot. */
  scope?: string[];
}

export interface GitSnapshotResult {
  commit: string;
  parentCommit: string;
  files: Array<{ path: string; status: "added" | "modified" | "deleted" }>;
}

export interface GitRestoreFileState {
  blob: string;
  mode: "100644" | "100755" | "120000";
  /** Full Unix permissions when recorded; older snapshots only have Git mode. */
  permissions?: number;
}

export interface GitRestorePlan {
  version: 1;
  id: string;
  workspaceId: string;
  workingDirectory: string;
  repository: string;
  files: Array<{
    path: string;
    target: GitRestoreFileState | null;
    expected: GitRestoreFileState | null;
  }>;
}

const compress = promisify(deflate);
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_ENTRIES = 50_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_TIMEOUT_MS = 30_000;
const COMMIT = /^[a-f0-9]{40}$/;

function within(parent: string, child: string) {
  const path = relative(parent, child);
  return (
    path === "" ||
    (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
  );
}

function checkDeadline(deadline: number) {
  if (Date.now() >= deadline)
    throw new Error("Git 快照超过 30 秒时限，请缩小项目范围。");
}

function blobHash(content: Buffer) {
  return createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");
}

function sameState(
  a: GitRestoreFileState | null,
  b: GitRestoreFileState | null,
) {
  if (!a || !b) return a === b;
  return (
    a.blob === b.blob &&
    a.mode === b.mode &&
    (a.permissions === undefined ||
      b.permissions === undefined ||
      a.permissions === b.permissions)
  );
}

// Do not inherit Git overrides, runtime injection variables, credentials, global
// Git configuration, or user identity from the server environment.
function gitEnvironment(index?: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_AUTHOR_NAME: "Panel",
    GIT_AUTHOR_EMAIL: "snapshots@panel.local",
    GIT_COMMITTER_NAME: "Panel",
    GIT_COMMITTER_EMAIL: "snapshots@panel.local",
    ...(index ? { GIT_INDEX_FILE: index } : {}),
  };
}

async function gitBuffer(
  args: string[],
  deadline: number,
  options: {
    input?: string | Buffer;
    index?: string;
    allowExitOne?: boolean;
  } = {},
): Promise<Buffer> {
  checkDeadline(deadline);
  return new Promise((resolveOutput, reject) => {
    const child = spawn(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.autocrlf=false",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "gc.auto=0",
        ...args,
      ],
      { env: gitEnvironment(options.index), stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: Error | undefined;
    const timer = setTimeout(
      () => {
        failure = new Error("Git 快照超过 30 秒时限，请缩小项目范围。");
        child.kill("SIGKILL");
      },
      Math.max(1, deadline - Date.now()),
    );
    const receive = (chunk: Buffer, error: boolean) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        failure = new Error("Git 快照文件清单过大，超过 16 MiB 限制。");
        child.kill("SIGKILL");
      } else if (error) {
        stderr.push(chunk);
      } else {
        stdout.push(chunk);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => receive(chunk, false));
    child.stderr.on("data", (chunk: Buffer) => receive(chunk, true));
    child.stdin.on("error", () => {
      /* Git's exit status reports a closed pipe. */
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Git 快照无法运行 Git：${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code === 0 || (code === 1 && options.allowExitOne))
        resolveOutput(Buffer.concat(stdout));
      else
        reject(
          new Error(
            `Git 快照失败：${Buffer.concat(stderr).toString("utf8").trim() || `Git 退出码 ${code}`}`,
          ),
        );
    });
    child.stdin.end(options.input);
  });
}

async function git(
  args: string[],
  deadline: number,
  options: Parameters<typeof gitBuffer>[2] = {},
) {
  return (await gitBuffer(args, deadline, options)).toString("utf8");
}

export class GitSnapshots {
  private readonly dataDirectory: string;
  private readonly repositories: string;

  constructor(dataDirectory: string) {
    this.dataDirectory = resolve(dataDirectory);
    this.repositories = join(this.dataDirectory, "git-snapshots");
  }

  /**
   * Omit paths for a whole-directory snapshot. Otherwise use canonical absolute
   * or root-relative file paths (no dot segments); directories are not expanded.
   * The persisted scope freezes exclusions for capture, including after restart.
   */
  async prepare(
    workspaceId: string,
    workingDirectory: string,
    paths?: string[],
  ): Promise<GitBaseline> {
    const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
    const cwd = await realpath(workingDirectory);
    if (!(await lstat(cwd)).isDirectory())
      throw new Error("Git 快照工作目录不是目录。");
    const key = createHash("sha256")
      .update(JSON.stringify([workspaceId, cwd]))
      .digest("hex");
    await mkdir(this.repositories, { recursive: true, mode: 0o700 });
    const repository = join(await realpath(this.repositories), `${key}.git`);
    await this.ensureRepository(repository, deadline);
    const scope =
      paths === undefined
        ? undefined
        : await this.prepareScope(repository, cwd, paths, deadline);
    const { tree, permissions } = await this.writeTree(
      repository,
      cwd,
      deadline,
      scope,
    );
    // Scoped snapshots form independent operation chains in the shared object
    // database. They must neither depend on nor update another operation's HEAD.
    const previous =
      scope !== undefined
        ? ""
        : (
            await git(
              [
                `--git-dir=${repository}`,
                "rev-parse",
                "--verify",
                "--quiet",
                "HEAD",
              ],
              deadline,
              { allowExitOne: true },
            )
          ).trim();
    if (previous) {
      const previousTree = (
        await git(
          [`--git-dir=${repository}`, "rev-parse", `${previous}^{tree}`],
          deadline,
        )
      ).trim();
      if (
        tree === previousTree &&
        JSON.stringify(permissions) ===
          JSON.stringify(await this.readPermissions(repository, previous))
      )
        return { workingDirectory: cwd, repository, commit: previous };
    }
    const commit = await this.commit(
      repository,
      tree,
      previous || undefined,
      "Panel: before file operation",
      deadline,
      permissions,
      scope === undefined,
    );
    return {
      workingDirectory: cwd,
      repository,
      commit,
      ...(scope === undefined ? {} : { scope }),
    };
  }

  async capture(
    baseline: GitBaseline,
    message: string,
  ): Promise<GitSnapshotResult | undefined> {
    const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
    const repositoryRoot = await realpath(this.repositories);
    if (
      dirname(baseline.repository) !== repositoryRoot ||
      !/^[a-f0-9]{64}\.git$/.test(basename(baseline.repository)) ||
      !COMMIT.test(baseline.commit) ||
      (await realpath(baseline.repository)) !== baseline.repository
    )
      throw new Error("Git 快照基线无效。");
    const cwd = await realpath(baseline.workingDirectory);
    if (cwd !== baseline.workingDirectory)
      throw new Error("Git 快照工作目录已改变。");
    const scope =
      baseline.scope === undefined
        ? undefined
        : this.normalizeScope(cwd, baseline.scope);
    if (scope && JSON.stringify(scope) !== JSON.stringify(baseline.scope))
      throw new Error("Git 快照文件范围无效。");
    if (scope) {
      const excludedRoots = await this.excludedRoots(cwd);
      if (
        scope.some(
          (path) =>
            path
              .split("/")
              .some((part) =>
                [".git", "node_modules"].includes(part.toLowerCase()),
              ) || excludedRoots.some((root) => within(root, join(cwd, path))),
        )
      )
        throw new Error("Git 快照文件范围包含排除目录。");
    }
    const { tree, permissions } = await this.writeTree(
      baseline.repository,
      cwd,
      deadline,
      scope,
    );
    const previousTree = (
      await git(
        [
          `--git-dir=${baseline.repository}`,
          "rev-parse",
          `${baseline.commit}^{tree}`,
        ],
        deadline,
      )
    ).trim();
    const previousPermissions = await this.readPermissions(
      baseline.repository,
      baseline.commit,
    );
    const permissionChanges = previousPermissions
      ? Object.keys(permissions).filter(
          (path) =>
            previousPermissions[path] !== undefined &&
            previousPermissions[path] !== permissions[path],
        )
      : [];
    if (tree === previousTree && !permissionChanges.length) return undefined;
    const commit = await this.commit(
      baseline.repository,
      tree,
      baseline.commit,
      message,
      deadline,
      permissions,
      scope === undefined,
    );
    const changes = (
      await git(
        [
          `--git-dir=${baseline.repository}`,
          "diff-tree",
          "--no-commit-id",
          "--name-status",
          "--no-renames",
          "--no-ext-diff",
          "-r",
          "-z",
          baseline.commit,
          commit,
          "--",
        ],
        deadline,
      )
    ).split("\0");
    const files: GitSnapshotResult["files"] = [];
    for (let i = 0; i + 1 < changes.length; i += 2) {
      files.push({
        path: changes[i + 1],
        status:
          changes[i] === "A"
            ? "added"
            : changes[i] === "D"
              ? "deleted"
              : "modified",
      });
    }
    for (const path of permissionChanges) {
      if (!files.some((file) => file.path === path))
        files.push({ path, status: "modified" });
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { commit, parentCommit: baseline.commit, files };
  }

  /** Build a durable, file-scoped inverse of one node revision's operations. */
  async prepareRestore(
    workspaceId: string,
    workingDirectory: string,
    entries: GitHistoryEntry[],
  ): Promise<GitRestorePlan> {
    const cwd = await realpath(workingDirectory);
    const key = createHash("sha256")
      .update(JSON.stringify([workspaceId, cwd]))
      .digest("hex");
    const plan: GitRestorePlan = {
      version: 1,
      id: randomUUID(),
      workspaceId,
      workingDirectory: cwd,
      repository: join(this.repositories, `${key}.git`),
      files: [],
    };
    if (!entries.length) return plan;
    plan.repository = join(await realpath(this.repositories), `${key}.git`);
    if ((await realpath(plan.repository)) !== plan.repository)
      throw new Error("Git 回溯仓库不匹配。");
    await this.validateRestorePlan(plan);
    const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
    const ordered = [...entries].sort((a, b) => a.createdAt - b.createdAt);
    const files = new Map<string, GitRestorePlan["files"][number]>();
    const trees = new Map<string, Map<string, GitRestoreFileState>>();
    const readTree = async (commit: string) => {
      let tree = trees.get(commit);
      if (!tree) {
        tree = await this.readTree(plan.repository, commit, deadline);
        trees.set(commit, tree);
      }
      return tree;
    };
    for (const entry of ordered) {
      if (
        entry.nodeId !== ordered[0].nodeId ||
        entry.nodeRevision !== ordered[0].nodeRevision
      )
        throw new Error("只能回溯同一卡片同一轮运行的 Git 快照。");
      if (
        entry.status !== "completed" ||
        !entry.commit ||
        !entry.parentCommit ||
        !COMMIT.test(entry.commit) ||
        !COMMIT.test(entry.parentCommit)
      )
        throw new Error("本轮存在缺失或失败的 Git 快照，无法安全原地重试。");
      if ((await realpath(entry.workingDirectory)) !== cwd)
        throw new Error("卡片的 Git 快照执行目录与当前目录不一致，无法回溯。");
      const parents = (
        await git(
          [
            `--git-dir=${plan.repository}`,
            "show",
            "-s",
            "--format=%P",
            entry.commit,
          ],
          deadline,
        )
      ).trim();
      if (parents !== entry.parentCommit)
        throw new Error("Git 快照父版本不匹配，无法安全回溯。");
      const before = await readTree(entry.parentCommit);
      const after = await readTree(entry.commit);
      const declaredPaths = new Set(entry.files.map((file) => file.path));
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
        (path) => !sameState(before.get(path) ?? null, after.get(path) ?? null),
      );
      if (
        changed.length !== entry.files.length ||
        changed.some((path) => !declaredPaths.has(path))
      )
        throw new Error("Git 快照文件清单不完整，无法安全回溯。");
      for (const path of changed) {
        const target = before.get(path) ?? null;
        const expected = after.get(path) ?? null;
        const previous = files.get(path);
        if (previous && !sameState(previous.expected, target))
          throw new Error(
            `文件在本轮操作之间被其他操作修改，无法回溯：${path}`,
          );
        files.set(path, {
          path,
          target: previous ? previous.target : target,
          expected,
        });
      }
    }
    plan.files = [...files.values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    await this.validateRestorePlan(plan);
    await this.preflightRestore(plan, false, deadline);
    await this.validateRestoreObjects(plan, deadline);
    return plan;
  }

  /** Safe to replay from the persisted plan after an interrupted restore. */
  async applyRestore(plan: GitRestorePlan): Promise<void> {
    await this.validateRestorePlan(plan);
    const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
    const current = await this.preflightRestore(plan, true, deadline);
    await this.validateRestoreObjects(plan, deadline);
    // Resolve every required blob before changing any working file. A missing
    // object must not produce a partially applied restore.
    const contents = new Map<string, Buffer>();
    let totalBytes = 0;
    for (const file of plan.files) {
      if (
        file.target &&
        !sameState(current.get(file.path) ?? null, file.target)
      ) {
        const content = await gitBuffer(
          [
            `--git-dir=${plan.repository}`,
            "cat-file",
            "blob",
            file.target.blob,
          ],
          deadline,
        );
        if (
          blobHash(content) !== file.target.blob ||
          (file.target.mode === "120000" &&
            (!content.length || content.includes(0)))
        )
          throw new Error(`Git 快照文件内容无效：${file.path}`);
        totalBytes += content.length;
        if (totalBytes > MAX_TOTAL_BYTES)
          throw new Error("Git 回溯总内容超过 128 MiB 限制。");
        contents.set(file.path, content);
      }
    }
    for (const file of plan.files) {
      checkDeadline(deadline);
      const before = await this.readWorkingState(
        plan.workingDirectory,
        file.path,
      );
      const absolute = join(plan.workingDirectory, file.path);
      const temporary = join(
        dirname(absolute),
        `.panel-restore-${plan.id}-${createHash("sha256").update(file.path).digest("hex").slice(0, 16)}`,
      );
      // A crash before rename can leave an incomplete staging file. Its name
      // belongs to this durable plan, so replay can discard and rebuild it.
      try {
        await unlink(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (sameState(before, file.target)) continue;
      if (
        !sameState(before, file.expected) ||
        !sameState(before, current.get(file.path) ?? null)
      )
        throw new Error(
          `文件在回溯期间发生变化，已停止；可处理冲突后重试：${file.path}`,
        );
      if (!file.target) {
        await this.checkRestoreParents(plan.workingDirectory, file.path);
        await unlink(absolute);
        continue;
      }
      await this.ensureRestoreParents(plan.workingDirectory, file.path);
      try {
        const content = contents.get(file.path)!;
        if (file.target.mode === "120000") {
          await symlink(content.toString("utf8"), temporary);
        } else {
          const mode =
            file.target.permissions ??
            ((before?.permissions ?? 0o644) & ~0o111) |
              (file.target.mode === "100755"
                ? (before?.permissions ?? 0) & 0o111 || 0o111
                : 0);
          const handle = await open(temporary, "wx", 0o600);
          try {
            await handle.writeFile(content);
            await handle.chmod(mode);
          } finally {
            await handle.close();
          }
        }
        // Recheck ancestors immediately before replacement; never follow a
        // symlink substituted for a directory since the global preflight.
        await this.checkRestoreParents(plan.workingDirectory, file.path);
        if (
          !sameState(
            await this.readWorkingState(plan.workingDirectory, file.path),
            before,
          )
        )
          throw new Error(`文件在回溯期间发生变化，已停止：${file.path}`);
        await rename(temporary, absolute);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }

  private async validateRestoreObjects(plan: GitRestorePlan, deadline: number) {
    const blobs = [
      ...new Set(
        plan.files.flatMap((file) =>
          [file.target?.blob, file.expected?.blob].filter(
            (blob): blob is string => !!blob,
          ),
        ),
      ),
    ];
    if (!blobs.length) return;
    const lines = (
      await git(
        [`--git-dir=${plan.repository}`, "cat-file", "--batch-check"],
        deadline,
        { input: `${blobs.join("\n")}\n` },
      )
    )
      .trim()
      .split("\n");
    if (
      lines.length !== blobs.length ||
      lines.some((line, index) => {
        const parts = line.split(" ");
        return (
          parts.length !== 3 ||
          parts[0] !== blobs[index] ||
          parts[1] !== "blob" ||
          !/^\d+$/.test(parts[2]) ||
          Number(parts[2]) > MAX_FILE_BYTES
        );
      })
    )
      throw new Error("Git 快照文件对象缺失或无效，无法安全回溯。");
  }

  private async readPermissions(
    repository: string,
    commit: string,
  ): Promise<Record<string, number> | undefined> {
    try {
      const permissions = JSON.parse(
        await readFile(
          join(repository, "panel-permissions", `${commit}.json`),
          "utf8",
        ),
      ) as Record<string, number>;
      if (
        !permissions ||
        typeof permissions !== "object" ||
        Array.isArray(permissions) ||
        Object.values(permissions).some(
          (mode) => !Number.isInteger(mode) || mode < 0 || mode > 0o777,
        )
      )
        throw new Error("Git 快照文件权限元数据无效。");
      return Object.assign(Object.create(null), permissions) as Record<
        string,
        number
      >;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async readTree(repository: string, commit: string, deadline: number) {
    const tree = new Map<string, GitRestoreFileState>();
    const permissions = await this.readPermissions(repository, commit);
    const output = await git(
      [`--git-dir=${repository}`, "ls-tree", "-r", "-z", commit],
      deadline,
    );
    for (const entry of output.split("\0")) {
      if (!entry) continue;
      const match =
        /^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
      if (!match) throw new Error("Git 快照包含无法恢复的文件类型。");
      const [, mode, blob, path] = match;
      tree.set(path, {
        blob,
        mode: mode as GitRestoreFileState["mode"],
        ...(permissions?.[path] === undefined
          ? {}
          : { permissions: permissions[path] }),
      });
    }
    return tree;
  }

  private async validateRestorePlan(plan: GitRestorePlan) {
    if (
      plan.version !== 1 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        plan.id,
      ) ||
      typeof plan.workspaceId !== "string" ||
      !Array.isArray(plan.files) ||
      plan.files.length > MAX_FILES
    )
      throw new Error("Git 回溯计划无效。");
    const cwd = await realpath(plan.workingDirectory);
    if (cwd !== plan.workingDirectory || !(await lstat(cwd)).isDirectory())
      throw new Error("Git 回溯工作目录已改变。");
    if (!plan.files.length) return;
    const repositories = await realpath(this.repositories);
    const key = createHash("sha256")
      .update(JSON.stringify([plan.workspaceId, cwd]))
      .digest("hex");
    if (
      plan.repository !== join(repositories, `${key}.git`) ||
      (await realpath(plan.repository)) !== plan.repository
    )
      throw new Error("Git 回溯仓库不匹配。");
    const paths = new Set<string>();
    for (const file of plan.files) {
      const parts = file.path.split("/");
      if (
        !file.path ||
        file.path.includes("\0") ||
        file.path.includes("\\") ||
        parts.some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part.toLowerCase() === ".git" ||
            part.toLowerCase() === "node_modules",
        ) ||
        !within(cwd, join(cwd, file.path)) ||
        paths.has(file.path)
      )
        throw new Error(`Git 回溯路径无效：${file.path}`);
      paths.add(file.path);
      for (const state of [file.target, file.expected]) {
        if (
          state !== null &&
          (!state ||
            !COMMIT.test(state.blob) ||
            !["100644", "100755", "120000"].includes(state.mode) ||
            (state.permissions !== undefined &&
              (!Number.isInteger(state.permissions) ||
                state.permissions < 0 ||
                state.permissions > 0o777)))
        )
          throw new Error(`Git 回溯文件状态无效：${file.path}`);
      }
    }
    for (const path of paths) {
      let parent = dirname(path);
      while (parent !== ".") {
        if (paths.has(parent))
          throw new Error(
            `Git 回溯涉及文件与目录互换，请先手动处理：${parent}`,
          );
        parent = dirname(parent);
      }
    }
  }

  private async checkRestoreParents(cwd: string, path: string) {
    if ((await realpath(cwd)) !== cwd)
      throw new Error("Git 回溯工作目录已改变。");
    let directory = cwd;
    for (const part of path.split("/").slice(0, -1)) {
      directory = join(directory, part);
      try {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error(
            `Git 回溯路径包含符号链接或非目录，无法安全恢复：${path}`,
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
  }

  private async ensureRestoreParents(cwd: string, path: string) {
    let directory = cwd;
    for (const part of path.split("/").slice(0, -1)) {
      directory = join(directory, part);
      try {
        await mkdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`Git 回溯路径包含符号链接或非目录：${path}`);
    }
  }

  private async readWorkingState(
    cwd: string,
    path: string,
  ): Promise<GitRestoreFileState | null> {
    await this.checkRestoreParents(cwd, path);
    const absolute = join(cwd, path);
    let stat;
    try {
      stat = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const content = Buffer.from(await readlink(absolute));
      return { mode: "120000", blob: blobHash(content) };
    }
    if (!stat.isFile()) throw new Error(`Git 回溯文件类型冲突：${path}`);
    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_FILE_BYTES)
        throw new Error(`Git 回溯文件类型或大小冲突：${path}`);
      const parts: Buffer[] = [];
      let size = 0;
      for (;;) {
        const part = Buffer.allocUnsafe(64 * 1024);
        const { bytesRead } = await handle.read(part);
        if (!bytesRead) break;
        size += bytesRead;
        if (size > MAX_FILE_BYTES)
          throw new Error(`Git 回溯文件超过大小限制：${path}`);
        parts.push(part.subarray(0, bytesRead));
      }
      const content = Buffer.concat(parts, size);
      return {
        mode: opened.mode & 0o111 ? "100755" : "100644",
        permissions: opened.mode & 0o777,
        blob: blobHash(content),
      };
    } finally {
      await handle.close();
    }
  }

  private async preflightRestore(
    plan: GitRestorePlan,
    allowTarget: boolean,
    deadline: number,
  ) {
    const current = new Map<string, GitRestoreFileState | null>();
    for (const file of plan.files) {
      checkDeadline(deadline);
      const state = await this.readWorkingState(
        plan.workingDirectory,
        file.path,
      );
      if (
        !sameState(state, file.expected) &&
        !(allowTarget && sameState(state, file.target))
      )
        throw new Error(
          `文件已被后续操作或手动修改，无法安全原地重试：${file.path}`,
        );
      current.set(file.path, state);
    }
    return current;
  }

  private async commit(
    repository: string,
    tree: string,
    parent: string | undefined,
    message: string,
    deadline: number,
    permissions: Record<string, number>,
    updateHead = true,
  ) {
    const commit = (
      await git(
        [
          `--git-dir=${repository}`,
          "commit-tree",
          tree,
          ...(parent ? ["-p", parent] : []),
        ],
        deadline,
        {
          input: `${message.slice(0, 4096)}\n${updateHead ? "" : `\nPanel operation: ${randomUUID()}\n`}`,
        },
      )
    ).trim();
    const permissionsDirectory = join(repository, "panel-permissions");
    await mkdir(permissionsDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      join(permissionsDirectory, `${commit}.json`),
      JSON.stringify(permissions),
      { mode: 0o600 },
    );
    // Keep every operation reachable, including when capture runs after recovery.
    await git(
      [
        `--git-dir=${repository}`,
        "update-ref",
        `refs/snapshots/${commit}`,
        commit,
      ],
      deadline,
    );
    if (updateHead)
      await git(
        [`--git-dir=${repository}`, "update-ref", "HEAD", commit],
        deadline,
      );
    return commit;
  }

  private async ensureRepository(repository: string, deadline: number) {
    try {
      if (
        !(await lstat(repository)).isDirectory() ||
        (await realpath(repository)) !== repository
      )
        throw new Error("Git 快照仓库路径无效。");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Publish a completely initialized repository atomically. Concurrent first
    // operations may each stage one, but never run git init over each other.
    const temporary = `${repository}.${randomUUID()}.tmp`;
    try {
      await git(
        ["init", "--bare", "--template=", "--object-format=sha1", temporary],
        deadline,
      );
      try {
        await rename(temporary, repository);
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
        if (
          !(await lstat(repository)).isDirectory() ||
          (await realpath(repository)) !== repository
        )
          throw new Error("Git 快照仓库路径无效。");
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  /** Scope names are literal files, never Git pathspecs or recursive directories. */
  private normalizeScope(cwd: string, paths: string[]) {
    if (!Array.isArray(paths) || paths.length > MAX_FILES)
      throw new Error("Git 快照文件范围无效。");
    const normalized = paths.map((path) => {
      if (
        typeof path !== "string" ||
        !path ||
        path.includes("\0") ||
        path.includes("\\") ||
        path.split(sep).some((part) => part === "." || part === "..")
      )
        throw new Error("Git 快照文件路径无效。");
      const absolute = resolve(cwd, path);
      const local = relative(cwd, absolute);
      if (!local || !within(cwd, absolute))
        throw new Error(`Git 快照文件路径不在工作目录内：${path}`);
      return local;
    });
    return [...new Set(normalized)].sort();
  }

  private async excludedRoots(cwd: string) {
    const dataDirectory = await realpath(this.dataDirectory);
    const repositoryRoot = await realpath(this.repositories);
    const excludedRoots = [repositoryRoot];
    if (dataDirectory !== cwd && within(cwd, dataDirectory))
      excludedRoots.push(dataDirectory);
    return excludedRoots;
  }

  private async prepareScope(
    repository: string,
    cwd: string,
    paths: string[],
    deadline: number,
  ) {
    const excludedRoots = await this.excludedRoots(cwd);
    const candidates = this.normalizeScope(cwd, paths).filter(
      (path) =>
        !path
          .split("/")
          .some((part) =>
            [".git", "node_modules"].includes(part.toLowerCase()),
          ) && !excludedRoots.some((root) => within(root, join(cwd, path))),
    );
    for (const path of candidates) {
      checkDeadline(deadline);
      await this.checkRestoreParents(cwd, path);
    }
    if (!candidates.length) return [];
    const ignored = new Set(
      (
        await git(
          [
            `--git-dir=${repository}`,
            `--work-tree=${cwd}`,
            "check-ignore",
            "--no-index",
            "-z",
            "--stdin",
          ],
          deadline,
          {
            // check-ignore rejects pathspec magic, including --literal-pathspecs.
            // A leading ./ keeps literal colon-prefixed filenames unambiguous.
            input: `${candidates.map((path) => `./${path}`).join("\0")}\0`,
            allowExitOne: true,
          },
        )
      )
        .split("\0")
        .map((path) => (path.startsWith("./") ? path.slice(2) : path)),
    );
    // Freeze eligibility with the baseline, so another operation editing an
    // ignore file cannot turn an unrelated file into a deletion or addition.
    return candidates.filter((path) => !ignored.has(path));
  }

  private async writeTree(
    repository: string,
    cwd: string,
    deadline: number,
    scope?: string[],
  ) {
    const excludedRoots = await this.excludedRoots(cwd);
    let directories = scope === undefined ? [""] : [];
    let pendingScope = scope;
    let fileCount = 0;
    let entryCount = 0;
    let totalBytes = 0;
    const entries: string[] = [];
    const permissions: Record<string, number> = Object.create(null);
    while (directories.length || pendingScope !== undefined) {
      checkDeadline(deadline);
      const candidates: string[] = pendingScope ?? [];
      pendingScope = undefined;
      for (const directory of directories) {
        checkDeadline(deadline);
        const absoluteDirectory = join(cwd, directory);
        if ((await realpath(absoluteDirectory)) !== absoluteDirectory) {
          throw new Error(`Git 快照扫描期间目录发生变化：${directory}`);
        }
        for await (const child of await opendir(absoluteDirectory)) {
          if (
            child.name.toLowerCase() === ".git" ||
            child.name.toLowerCase() === "node_modules"
          )
            continue;
          const path = directory ? `${directory}/${child.name}` : child.name;
          if (excludedRoots.some((root) => within(root, join(cwd, path))))
            continue;
          if (++entryCount > MAX_ENTRIES)
            throw new Error(
              "Git 快照超过 50,000 个文件及目录条目限制，请缩小项目范围。",
            );
          candidates.push(path);
        }
      }
      if (!candidates.length) break;
      const ignored =
        scope !== undefined
          ? new Set<string>()
          : new Set(
              (
                await git(
                  [
                    `--git-dir=${repository}`,
                    `--work-tree=${cwd}`,
                    "check-ignore",
                    "--no-index",
                    "-z",
                    "--stdin",
                  ],
                  deadline,
                  {
                    input: `${candidates.map((path) => `./${path}`).join("\0")}\0`,
                    allowExitOne: true,
                  },
                )
              )
                .split("\0")
                .map((path) => (path.startsWith("./") ? path.slice(2) : path)),
            );
      directories = [];
      for (const path of candidates.sort()) {
        if (ignored.has(path)) continue;
        checkDeadline(deadline);
        const absolutePath = join(cwd, path);
        if (scope !== undefined) await this.checkRestoreParents(cwd, path);
        let stat;
        try {
          stat = await lstat(absolutePath);
        } catch (error) {
          if (
            scope !== undefined &&
            (error as NodeJS.ErrnoException).code === "ENOENT"
          )
            continue;
          throw error;
        }
        if (stat.isDirectory()) {
          if (scope !== undefined)
            throw new Error(`Git 快照文件范围不能包含目录：${path}`);
          directories.push(path);
          continue;
        }
        if (++fileCount > MAX_FILES)
          throw new Error(
            "Git 快照超过 20,000 个文件限制，请调整 .gitignore。",
          );
        let content: Buffer;
        let mode: string;
        if (stat.isSymbolicLink()) {
          content = Buffer.from(await readlink(absolutePath));
          mode = "120000";
        } else if (stat.isFile()) {
          const handle = await open(
            absolutePath,
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const openedStat = await handle.stat();
            if (!openedStat.isFile())
              throw new Error(`Git 快照文件类型已改变：${path}`);
            if (openedStat.size > MAX_FILE_BYTES)
              throw new Error(`Git 快照单个文件超过 16 MiB：${path}`);
            const parts: Buffer[] = [];
            let size = 0;
            for (;;) {
              checkDeadline(deadline);
              const part = Buffer.allocUnsafe(64 * 1024);
              const { bytesRead } = await handle.read(part);
              if (!bytesRead) break;
              size += bytesRead;
              if (size > MAX_FILE_BYTES)
                throw new Error(`Git 快照单个文件超过 16 MiB：${path}`);
              if (totalBytes + size > MAX_TOTAL_BYTES)
                throw new Error(
                  "Git 快照总内容超过 128 MiB 限制，请调整 .gitignore。",
                );
              parts.push(part.subarray(0, bytesRead));
            }
            content = Buffer.concat(parts, size);
            mode = openedStat.mode & 0o111 ? "100755" : "100644";
            permissions[path] = openedStat.mode & 0o777;
          } finally {
            await handle.close();
          }
        } else {
          throw new Error(`Git 快照不支持特殊文件：${path}`);
        }
        totalBytes += content.length;
        if (totalBytes > MAX_TOTAL_BYTES)
          throw new Error(
            "Git 快照总内容超过 128 MiB 限制，请调整 .gitignore。",
          );
        const object = Buffer.concat([
          Buffer.from(`blob ${content.length}\0`),
          content,
        ]);
        const hash = createHash("sha1").update(object).digest("hex");
        const objectDirectory = join(repository, "objects", hash.slice(0, 2));
        const objectPath = join(objectDirectory, hash.slice(2));
        let exists = false;
        try {
          exists = (await lstat(objectPath)).isFile();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!exists) {
          await mkdir(objectDirectory, { recursive: true });
          const temporary = join(objectDirectory, `panel-${randomUUID()}`);
          try {
            await writeFile(temporary, await compress(object), {
              mode: 0o600,
              flag: "wx",
            });
            await rename(temporary, objectPath);
          } finally {
            await rm(temporary, { force: true });
          }
        }
        entries.push(`${mode} ${hash}\t${path}\0`);
      }
    }
    const index = join(repository, `panel-index-${randomUUID()}`);
    try {
      await git([`--git-dir=${repository}`, "read-tree", "--empty"], deadline, {
        index,
      });
      if (entries.length) {
        await git(
          [`--git-dir=${repository}`, "update-index", "-z", "--index-info"],
          deadline,
          { index, input: entries.join("") },
        );
      }
      const tree = (
        await git([`--git-dir=${repository}`, "write-tree"], deadline, {
          index,
        })
      ).trim();
      return { tree, permissions };
    } finally {
      await rm(index, { force: true });
      await rm(`${index}.lock`, { force: true });
    }
  }
}
