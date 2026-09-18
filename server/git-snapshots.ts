import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readlink,
  realpath,
  rename,
  rm,
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

export interface GitBaseline {
  workingDirectory: string;
  repository: string;
  commit: string;
}

export interface GitSnapshotResult {
  commit: string;
  parentCommit: string;
  files: Array<{ path: string; status: "added" | "modified" | "deleted" }>;
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

async function git(
  args: string[],
  deadline: number,
  options: {
    input?: string | Buffer;
    index?: string;
    allowExitOne?: boolean;
  } = {},
): Promise<string> {
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
        resolveOutput(Buffer.concat(stdout).toString("utf8"));
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

export class GitSnapshots {
  private readonly dataDirectory: string;
  private readonly repositories: string;

  constructor(dataDirectory: string) {
    this.dataDirectory = resolve(dataDirectory);
    this.repositories = join(this.dataDirectory, "git-snapshots");
  }

  async prepare(
    workspaceId: string,
    workingDirectory: string,
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
    await git(
      ["init", "--bare", "--template=", "--object-format=sha1", repository],
      deadline,
    );
    const tree = await this.writeTree(repository, cwd, deadline);
    const previous = (
      await git(
        [`--git-dir=${repository}`, "rev-parse", "--verify", "--quiet", "HEAD"],
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
      if (tree === previousTree)
        return { workingDirectory: cwd, repository, commit: previous };
    }
    const commit = await this.commit(
      repository,
      tree,
      previous || undefined,
      "Panel: before file operation",
      deadline,
    );
    return { workingDirectory: cwd, repository, commit };
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
    const tree = await this.writeTree(baseline.repository, cwd, deadline);
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
    if (tree === previousTree) return undefined;
    const commit = await this.commit(
      baseline.repository,
      tree,
      baseline.commit,
      message,
      deadline,
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
    return { commit, parentCommit: baseline.commit, files };
  }

  private async commit(
    repository: string,
    tree: string,
    parent: string | undefined,
    message: string,
    deadline: number,
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
        { input: `${message.slice(0, 4096)}\n` },
      )
    ).trim();
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
    await git(
      [`--git-dir=${repository}`, "update-ref", "HEAD", commit],
      deadline,
    );
    return commit;
  }

  private async writeTree(repository: string, cwd: string, deadline: number) {
    const dataDirectory = await realpath(this.dataDirectory);
    const repositoryRoot = await realpath(this.repositories);
    const excludedRoots = [repositoryRoot];
    if (dataDirectory !== cwd && within(cwd, dataDirectory))
      excludedRoots.push(dataDirectory);
    let directories = [""];
    let fileCount = 0;
    let entryCount = 0;
    let totalBytes = 0;
    const entries: string[] = [];
    while (directories.length) {
      checkDeadline(deadline);
      const candidates: string[] = [];
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
            { input: `${candidates.join("\0")}\0`, allowExitOne: true },
          )
        ).split("\0"),
      );
      directories = [];
      for (const path of candidates.sort()) {
        if (ignored.has(path)) continue;
        checkDeadline(deadline);
        const absolutePath = join(cwd, path);
        const stat = await lstat(absolutePath);
        if (stat.isDirectory()) {
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
      return (
        await git([`--git-dir=${repository}`, "write-tree"], deadline, {
          index,
        })
      ).trim();
    } finally {
      await rm(index, { force: true });
      await rm(`${index}.lock`, { force: true });
    }
  }
}
