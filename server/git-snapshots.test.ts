import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { GitSnapshots } from "./git-snapshots.ts";

const execute = promisify(execFile);

async function git(args: string[]) {
  const { stdout } = await execute("git", args, {
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
    await mkdtemp(join(tmpdir(), "panel-git-snapshots-")),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "work");
  const data = join(directory, "data");
  await mkdir(cwd);
  return { directory, cwd, data, snapshots: new GitSnapshots(data) };
}

test("real Git snapshots preserve additions, edits, deletions and operation parents", async (t) => {
  const { cwd, snapshots } = await fixture(t);
  await writeFile(join(cwd, "changed.txt"), "before\n");
  await writeFile(join(cwd, "deleted.txt"), "remove me\n");
  const baseline = await snapshots.prepare("workspace", cwd);
  assert.equal(await snapshots.capture(baseline, "no changes"), undefined);
  await writeFile(join(cwd, "changed.txt"), "after\n");
  await rm(join(cwd, "deleted.txt"));
  await writeFile(join(cwd, "新增 空格\nfile.txt"), "created\n");
  const result = await snapshots.capture(baseline, "edit: complete operation");
  assert.ok(result);
  assert.equal(result.parentCommit, baseline.commit);
  assert.deepEqual(result.files, [
    { path: "changed.txt", status: "modified" },
    { path: "deleted.txt", status: "deleted" },
    { path: "新增 空格\nfile.txt", status: "added" },
  ]);
  assert.equal(
    await git([
      `--git-dir=${baseline.repository}`,
      "show",
      `${baseline.commit}:changed.txt`,
    ]),
    "before",
  );
  assert.equal(
    await git([
      `--git-dir=${baseline.repository}`,
      "show",
      `${result.commit}:changed.txt`,
    ]),
    "after",
  );
  assert.equal(
    await git([
      `--git-dir=${baseline.repository}`,
      "show",
      "-s",
      "--format=%P",
      result.commit,
    ]),
    baseline.commit,
  );
  assert.equal(
    await git([
      `--git-dir=${baseline.repository}`,
      "show",
      "-s",
      "--format=%s",
      result.commit,
    ]),
    "edit: complete operation",
  );
  assert.equal(
    (await snapshots.prepare("workspace", cwd)).commit,
    result.commit,
  );
  await git([`--git-dir=${baseline.repository}`, "fsck", "--no-dangling"]);
});

test("already dirty files have an exact baseline without modifying user HEAD or index or running filters/hooks", async (t) => {
  const { directory, cwd, snapshots } = await fixture(t);
  await git(["init", "--template=", cwd]);
  await writeFile(join(cwd, "file.txt"), "committed\n");
  await git(["-C", cwd, "add", "file.txt"]);
  await git(["-C", cwd, "commit", "-m", "original"]);
  await writeFile(join(cwd, "file.txt"), "staged\n");
  await git(["-C", cwd, "add", "file.txt"]);
  await writeFile(join(cwd, "file.txt"), "dirty before tool\n");
  const marker = join(directory, "must-not-run");
  await mkdir(join(cwd, ".git", "hooks"));
  await writeFile(
    join(cwd, ".git", "hooks", "pre-commit"),
    `#!/bin/sh\ntouch '${marker}'\n`,
  );
  await chmod(join(cwd, ".git", "hooks", "pre-commit"), 0o755);
  await git([
    "-C",
    cwd,
    "config",
    "filter.unsafe.clean",
    `touch '${marker}'; cat`,
  ]);
  await git(["-C", cwd, "config", "filter.unsafe.required", "true"]);
  await writeFile(join(cwd, ".gitattributes"), "*.txt filter=unsafe\n");
  const originalIndex = await readFile(join(cwd, ".git", "index"));
  const originalHead = await git(["-C", cwd, "rev-parse", "HEAD"]);
  const originalConfig = await readFile(join(cwd, ".git", "config"));
  const baseline = await snapshots.prepare("workspace", cwd);
  await writeFile(join(cwd, "file.txt"), "dirty after tool\n");
  const result = await snapshots.capture(baseline, "write");
  assert.ok(result);
  assert.deepEqual(result.files, [{ path: "file.txt", status: "modified" }]);
  assert.equal(
    await git([
      `--git-dir=${baseline.repository}`,
      "show",
      `${baseline.commit}:file.txt`,
    ]),
    "dirty before tool",
  );
  assert.deepEqual(await readFile(join(cwd, ".git", "index")), originalIndex);
  assert.deepEqual(await readFile(join(cwd, ".git", "config")), originalConfig);
  assert.equal(await git(["-C", cwd, "rev-parse", "HEAD"]), originalHead);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("ignores dependencies, nested Git internals and service data, preserving symlinks without following them", async (t) => {
  const { directory, cwd } = await fixture(t);
  const data = join(cwd, ".panel");
  const snapshots = new GitSnapshots(data);
  await writeFile(join(cwd, ".gitignore"), "ignored/\n*.secret\n");
  for (const path of ["ignored", "node_modules", "nested/.git", ".panel"]) {
    await mkdir(join(cwd, path), { recursive: true });
    await writeFile(join(cwd, path, "excluded.txt"), "excluded content");
  }
  await writeFile(join(cwd, "credentials.secret"), "excluded");
  await writeFile(join(cwd, "nested", "visible.txt"), "included");
  await writeFile(
    join(directory, "outside.txt"),
    "outside confidential contents",
  );
  await symlink(join(directory, "outside.txt"), join(cwd, "external-link"));
  await symlink(directory, join(cwd, "external-directory"));
  await symlink("missing-target", join(cwd, "dangling-link"));
  const baseline = await snapshots.prepare("workspace", cwd);
  const names = (
    await git([
      `--git-dir=${baseline.repository}`,
      "ls-tree",
      "-r",
      "--name-only",
      baseline.commit,
    ])
  ).split("\n");
  assert.deepEqual(names, [
    ".gitignore",
    "dangling-link",
    "external-directory",
    "external-link",
    "nested/visible.txt",
  ]);
  const linkEntry = await git([
    `--git-dir=${baseline.repository}`,
    "ls-tree",
    baseline.commit,
    "external-link",
  ]);
  assert.match(linkEntry, /^120000 blob /);
  assert.equal(
    await git([
      `--git-dir=${baseline.repository}`,
      "show",
      `${baseline.commit}:external-link`,
    ]),
    join(directory, "outside.txt"),
  );
  await writeFile(join(directory, "outside.txt"), "outside changed");
  await writeFile(join(cwd, "ignored", "excluded.txt"), "ignored changed");
  assert.equal(await snapshots.capture(baseline, "outside changes"), undefined);
  await rm(join(cwd, "dangling-link"));
  await symlink("different-target", join(cwd, "dangling-link"));
  assert.deepEqual((await snapshots.capture(baseline, "link edit"))?.files, [
    { path: "dangling-link", status: "modified" },
  ]);
});

test("default working directories under the data directory are captured and serialized baselines recover after restart", async (t) => {
  const { data, snapshots } = await fixture(t);
  const cwd = join(data, "workspaces", "workspace");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "local.ts"), "before");
  const baseline = await snapshots.prepare("workspace", cwd);
  await writeFile(
    join(cwd, "local.ts"),
    "partial change before failed tool or restart",
  );
  const restarted = new GitSnapshots(data);
  const result = await restarted.capture(
    JSON.parse(JSON.stringify(baseline)),
    "recover incomplete tool",
  );
  assert.deepEqual(result?.files, [{ path: "local.ts", status: "modified" }]);
  assert.equal(result?.parentCommit, baseline.commit);
});

test("workspaces and changed working directories use separate repositories", async (t) => {
  const { directory, cwd, snapshots } = await fixture(t);
  const other = join(directory, "other");
  await mkdir(other);
  await writeFile(join(cwd, "file.txt"), "first");
  await writeFile(join(other, "file.txt"), "second");
  const first = await snapshots.prepare("workspace", cwd);
  const second = await snapshots.prepare("workspace", other);
  const third = await snapshots.prepare("other-workspace", cwd);
  assert.notEqual(first.repository, second.repository);
  assert.notEqual(first.repository, third.repository);
  assert.equal(await snapshots.capture(first, "unchanged"), undefined);
});

test("Git environment injection is not inherited by snapshot commands", async (t) => {
  const { directory, cwd, snapshots } = await fixture(t);
  const injectedDirectory = join(directory, "injected-git");
  const injectedIndex = join(directory, "injected-index");
  const values = {
    GIT_DIR: injectedDirectory,
    GIT_WORK_TREE: directory,
    GIT_INDEX_FILE: injectedIndex,
    GIT_OBJECT_DIRECTORY: join(directory, "injected-objects"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.repositoryFormatVersion",
    GIT_CONFIG_VALUE_0: "99999",
  };
  const saved = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, values);
  try {
    await writeFile(join(cwd, "file.txt"), "before");
    const baseline = await snapshots.prepare("workspace", cwd);
    await writeFile(join(cwd, "file.txt"), "after");
    assert.ok(await snapshots.capture(baseline, "write"));
    await assert.rejects(readFile(injectedIndex), { code: "ENOENT" });
    await assert.rejects(realpath(injectedDirectory), { code: "ENOENT" });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("large files fail explicitly instead of silently dropping the file", async (t) => {
  const { cwd, snapshots } = await fixture(t);
  await writeFile(join(cwd, "too-large.bin"), "");
  await truncate(join(cwd, "too-large.bin"), 16 * 1024 * 1024 + 1);
  await assert.rejects(
    snapshots.prepare("workspace", cwd),
    /超过 16 MiB.*too-large\.bin/,
  );
});
