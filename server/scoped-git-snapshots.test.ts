import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import type { GitHistoryEntry } from "../shared/types.ts";
import {
  GitSnapshots,
  type GitBaseline,
  type GitSnapshotResult,
} from "./git-snapshots.ts";

const exec = promisify(execFile);

async function git(args: string[]) {
  const { stdout } = await exec("git", args, {
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    },
  });
  return stdout.trimEnd();
}

async function fixture(t: TestContext) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-scoped-git-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "work");
  const data = join(directory, "data");
  await mkdir(cwd);
  return { directory, cwd, data, snapshots: new GitSnapshots(data) };
}

function history(
  baseline: GitBaseline,
  result: GitSnapshotResult | undefined,
  nodeId: string,
  createdAt = 1,
): GitHistoryEntry {
  assert.ok(result);
  return {
    id: `${nodeId}-${createdAt}`,
    nodeId,
    nodeRevision: 0,
    nodePrompt: "test",
    toolCallId: `${nodeId}-${createdAt}`,
    toolName: "write",
    workingDirectory: baseline.workingDirectory,
    createdAt,
    summary: "test",
    status: "completed",
    ...result,
  };
}

test("parallel first operations capture only their own files and restore independently without touching user Git", async (t) => {
  const { cwd, data, snapshots } = await fixture(t);
  await git(["init", "--template=", cwd]);
  const paths = Array.from({ length: 6 }, (_, index) => `file-${index}.txt`);
  for (const path of paths)
    await writeFile(join(cwd, path), `original ${path}`);
  await git(["-C", cwd, "add", "."]);
  await git(["-C", cwd, "commit", "-m", "original"]);
  await writeFile(join(cwd, paths[0]), "staged content");
  await git(["-C", cwd, "add", paths[0]]);
  await writeFile(join(cwd, paths[0]), "user dirty content");
  const userGit = await Promise.all(
    ["HEAD", "index", "config"].map((path) =>
      readFile(join(cwd, ".git", path)),
    ),
  );

  // Separate instances also exercise the on-disk first initialization race.
  const baselines = await Promise.all(
    paths.map((path, index) =>
      new GitSnapshots(data).prepare("workspace", cwd, [
        index % 2 ? path : join(cwd, path),
      ]),
    ),
  );
  assert.equal(
    new Set(baselines.map((baseline) => baseline.repository)).size,
    1,
  );
  for (const path of paths) await writeFile(join(cwd, path), `changed ${path}`);
  const results = await Promise.all(
    baselines.map((baseline) => snapshots.capture(baseline, "parallel edit")),
  );
  for (const [index, result] of results.entries()) {
    assert.deepEqual(result?.files, [
      { path: paths[index], status: "modified" },
    ]);
    assert.equal(
      await git([
        `--git-dir=${baselines[index].repository}`,
        "ls-tree",
        "-r",
        "--name-only",
        result!.commit,
      ]),
      paths[index],
    );
  }
  assert.equal(
    await git([`--git-dir=${baselines[0].repository}`, "symbolic-ref", "HEAD"]),
    "refs/heads/master",
  );
  await assert.rejects(
    git([
      `--git-dir=${baselines[0].repository}`,
      "rev-parse",
      "--verify",
      "HEAD",
    ]),
  );
  for (const index of [2, 0, 5, 1, 4, 3]) {
    await snapshots.applyRestore(
      await snapshots.prepareRestore("workspace", cwd, [
        history(baselines[index], results[index], `node-${index}`),
      ]),
    );
    assert.equal(
      await readFile(join(cwd, paths[index]), "utf8"),
      index === 0 ? "user dirty content" : `original ${paths[index]}`,
    );
    for (const other of ["HEAD", "index", "config"].entries()) {
      assert.deepEqual(
        await readFile(join(cwd, ".git", other[1])),
        userGit[other[0]],
      );
    }
  }
  assert.deepEqual(
    (await readdir(join(data, "git-snapshots"))).filter(
      (name) => !name.endsWith(".git"),
    ),
    [],
  );
  assert.deepEqual(
    (await readdir(baselines[0].repository)).filter((name) =>
      name.startsWith("panel-index"),
    ),
    [],
  );
  await git([`--git-dir=${baselines[0].repository}`, "fsck", "--no-dangling"]);
});

test("scoped and whole-directory operations compose into one node restore and keep unrelated parallel edits", async (t) => {
  const { cwd, snapshots } = await fixture(t);
  await writeFile(join(cwd, "a"), "original a");
  await writeFile(join(cwd, "b"), "original b");
  const whole = await snapshots.prepare("workspace", cwd);
  await writeFile(join(cwd, "a"), "first a");
  const first = history(
    whole,
    await snapshots.capture(whole, "bash"),
    "node",
    1,
  );
  const a = await snapshots.prepare("workspace", cwd, ["a"]);
  const b = await snapshots.prepare("workspace", cwd, ["b"]);
  await writeFile(join(cwd, "a"), "second a");
  await writeFile(join(cwd, "b"), "parallel b");
  const second = history(a, await snapshots.capture(a, "write a"), "node", 2);
  const other = history(b, await snapshots.capture(b, "write b"), "other");
  const thirdBaseline = await snapshots.prepare("workspace", cwd, ["new"]);
  await writeFile(join(cwd, "new"), "third operation");
  const third = history(
    thirdBaseline,
    await snapshots.capture(thirdBaseline, "create"),
    "node",
    3,
  );
  await snapshots.applyRestore(
    await snapshots.prepareRestore("workspace", cwd, [third, first, second]),
  );
  assert.equal(await readFile(join(cwd, "a"), "utf8"), "original a");
  assert.equal(await readFile(join(cwd, "b"), "utf8"), "parallel b");
  await assert.rejects(lstat(join(cwd, "new")), { code: "ENOENT" });
  await snapshots.applyRestore(
    await snapshots.prepareRestore("workspace", cwd, [other]),
  );
  assert.equal(await readFile(join(cwd, "b"), "utf8"), "original b");
});

test("scoped restores detect later and interleaved edits to the same file", async (t) => {
  const { cwd, snapshots } = await fixture(t);
  await writeFile(join(cwd, "same"), "original");
  const first = await snapshots.prepare("workspace", cwd, ["same"]);
  await writeFile(join(cwd, "same"), "first node edit");
  const firstEntry = history(
    first,
    await snapshots.capture(first, "first"),
    "node",
    1,
  );
  const other = await snapshots.prepare("workspace", cwd, ["same"]);
  await writeFile(join(cwd, "same"), "other node edit");
  await snapshots.capture(other, "other");
  await assert.rejects(
    snapshots.prepareRestore("workspace", cwd, [firstEntry]),
    /后续操作.*same/,
  );
  const second = await snapshots.prepare("workspace", cwd, ["same"]);
  await writeFile(join(cwd, "same"), "second node edit");
  const secondEntry = history(
    second,
    await snapshots.capture(second, "second"),
    "node",
    2,
  );
  await assert.rejects(
    snapshots.prepareRestore("workspace", cwd, [firstEntry, secondEntry]),
    /操作之间.*same/,
  );
  assert.equal(await readFile(join(cwd, "same"), "utf8"), "second node edit");
});

test("serialized scopes recover additions, deletions and permission-only changes after restart", async (t) => {
  const { cwd, data, snapshots } = await fixture(t);
  await writeFile(join(cwd, "deleted"), Buffer.from([0, 255, 42]));
  await chmod(join(cwd, "deleted"), 0o640);
  await writeFile(join(cwd, "mode"), "same content");
  await chmod(join(cwd, "mode"), 0o600);
  const paths = ["missing/新增 空格\n文件", "deleted", "mode"];
  const baselines: GitBaseline[] = JSON.parse(
    JSON.stringify(
      await Promise.all(
        paths.map((path) => snapshots.prepare("workspace", cwd, [path])),
      ),
    ),
  );
  await mkdir(join(cwd, "missing"));
  await writeFile(join(cwd, paths[0]), "created");
  await rm(join(cwd, "deleted"));
  await chmod(join(cwd, "mode"), 0o640);
  await writeFile(join(cwd, "unrelated"), "not in recovered history");
  const recovered = new GitSnapshots(data);
  const results = await Promise.all(
    baselines.map((baseline) => recovered.capture(baseline, "recovered")),
  );
  assert.deepEqual(
    results.map((result) => result?.files),
    [
      [{ path: paths[0], status: "added" }],
      [{ path: "deleted", status: "deleted" }],
      [{ path: "mode", status: "modified" }],
    ],
  );
  const plan = await recovered.prepareRestore(
    "workspace",
    cwd,
    baselines.map((baseline, index) =>
      history(baseline, results[index], "node", index),
    ),
  );
  await new GitSnapshots(data).applyRestore(JSON.parse(JSON.stringify(plan)));
  await assert.rejects(lstat(join(cwd, paths[0])), { code: "ENOENT" });
  assert.deepEqual(
    await readFile(join(cwd, "deleted")),
    Buffer.from([0, 255, 42]),
  );
  assert.equal((await lstat(join(cwd, "deleted"))).mode & 0o777, 0o640);
  assert.equal((await lstat(join(cwd, "mode"))).mode & 0o777, 0o600);
  assert.equal(
    await readFile(join(cwd, "unrelated"), "utf8"),
    "not in recovered history",
  );
});

test("scope preserves the existing exclusions and freezes ignore eligibility across parallel ignore edits", async (t) => {
  const { cwd } = await fixture(t);
  const snapshots = new GitSnapshots(join(cwd, ".panel"));
  await writeFile(join(cwd, ".gitignore"), "*.secret\nignored/\n");
  for (const path of ["node_modules", "nested/.git", ".panel", "ignored"]) {
    await mkdir(join(cwd, path), { recursive: true });
    await writeFile(join(cwd, path, "data"), "excluded");
  }
  await writeFile(join(cwd, "credentials.secret"), "excluded");
  await writeFile(join(cwd, "visible"), "before");
  const excluded = await snapshots.prepare("workspace", cwd, [
    "credentials.secret",
    "ignored/data",
    "node_modules/data",
    "nested/.git/data",
    ".panel/data",
  ]);
  const visible = await snapshots.prepare("workspace", cwd, ["visible"]);
  assert.deepEqual(excluded.scope, []);
  await writeFile(join(cwd, ".gitignore"), "visible\n");
  await writeFile(join(cwd, "visible"), "after");
  await writeFile(join(cwd, "credentials.secret"), "changed excluded");
  assert.equal(await snapshots.capture(excluded, "excluded"), undefined);
  assert.deepEqual((await snapshots.capture(visible, "visible"))?.files, [
    { path: "visible", status: "modified" },
  ]);
});

test("scope rejects escaping paths, directories and symlink ancestors without following external files", async (t) => {
  const { directory, cwd, snapshots } = await fixture(t);
  await writeFile(join(directory, "outside"), "external");
  await symlink(directory, join(cwd, "alias"));
  await mkdir(join(cwd, "directory"));
  for (const path of [
    "../outside",
    join(directory, "outside"),
    ".",
    "bad\0name",
    "bad\\name",
  ]) {
    await assert.rejects(
      snapshots.prepare("workspace", cwd, [path]),
      /Git 快照文件路径/,
    );
  }
  await assert.rejects(
    snapshots.prepare("workspace", cwd, ["directory"]),
    /不能包含目录/,
  );
  await assert.rejects(
    snapshots.prepare("workspace", cwd, ["alias/outside"]),
    /符号链接/,
  );
  const baseline = await snapshots.prepare("workspace", cwd, ["directory/new"]);
  await rm(join(cwd, "directory"), { recursive: true });
  await symlink(directory, join(cwd, "directory"));
  await assert.rejects(
    snapshots.capture(baseline, "changed parent"),
    /符号链接/,
  );
  assert.equal(await readFile(join(directory, "outside"), "utf8"), "external");
});

test("scoped capture keeps an existing whole-directory HEAD stable and treats wildcard names literally", async (t) => {
  const { cwd, snapshots } = await fixture(t);
  const path = ":(glob)*.txt";
  await writeFile(join(cwd, path), "original literal");
  await writeFile(join(cwd, "other.txt"), "original other");
  const whole = await snapshots.prepare("workspace", cwd);
  const scoped = await snapshots.prepare("workspace", cwd, [
    path,
    join(cwd, path),
  ]);
  assert.deepEqual(scoped.scope, [path]);
  await writeFile(join(cwd, path), "literal changed");
  await writeFile(join(cwd, "other.txt"), "other changed");
  const result = await snapshots.capture(scoped, "literal");
  assert.deepEqual(result?.files, [{ path, status: "modified" }]);
  assert.equal(
    await git([`--git-dir=${whole.repository}`, "rev-parse", "HEAD"]),
    whole.commit,
  );
  await snapshots.applyRestore(
    await snapshots.prepareRestore("workspace", cwd, [
      history(scoped, result, "node"),
    ]),
  );
  assert.equal(await readFile(join(cwd, path), "utf8"), "original literal");
  assert.equal(await readFile(join(cwd, "other.txt"), "utf8"), "other changed");
});
