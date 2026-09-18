import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
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
import { GitSnapshots, type GitRestorePlan } from "./git-snapshots.ts";

const exec = promisify(execFile);

async function fixture(t: TestContext) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-git-restore-")),
  );
  t.after(() => rm(directory, { force: true, recursive: true }));
  const cwd = join(directory, "project");
  const data = join(directory, "data");
  await mkdir(cwd);
  const snapshots = new GitSnapshots(data);
  const entries: GitHistoryEntry[] = [];
  const update = async (change: () => Promise<unknown>) => {
    const baseline = await snapshots.prepare("workspace", cwd);
    await change();
    const result = await snapshots.capture(baseline, "test operation");
    assert.ok(result);
    const entry: GitHistoryEntry = {
      id: `history-${entries.length}`,
      nodeId: "node",
      nodeRevision: 0,
      nodePrompt: "test",
      toolCallId: `tool-${entries.length}`,
      toolName: "bash",
      workingDirectory: cwd,
      createdAt: entries.length,
      summary: "test",
      status: "completed",
      ...result,
    };
    entries.push(entry);
    return entry;
  };
  return { directory, cwd, data, snapshots, entries, update };
}

test("restores multiple operations to each file's first baseline, preserving other files and user Git", async (t) => {
  const { cwd, snapshots, entries, update } = await fixture(t);
  await exec("git", ["init", "--template=", cwd]);
  await writeFile(join(cwd, "edit.txt"), "committed");
  await exec("git", ["-C", cwd, "add", "edit.txt"]);
  await exec("git", [
    "-C",
    cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@test.local",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "-m",
    "test",
  ]);
  await writeFile(join(cwd, "edit.txt"), "dirty before card");
  await writeFile(join(cwd, "deleted.bin"), Buffer.from([0, 128, 255, 42]));
  await chmod(join(cwd, "deleted.bin"), 0o640);
  const head = await readFile(join(cwd, ".git", "HEAD"));
  const index = await readFile(join(cwd, ".git", "index"));
  const config = await readFile(join(cwd, ".git", "config"));
  await update(async () => {
    await writeFile(join(cwd, "edit.txt"), "first change");
    await writeFile(join(cwd, "新增 空格\n文件.txt"), "first created");
    await rm(join(cwd, "deleted.bin"));
  });
  await update(async () => {
    await writeFile(join(cwd, "edit.txt"), "second change");
    await writeFile(join(cwd, "新增 空格\n文件.txt"), "second created");
  });
  await writeFile(join(cwd, "later-other-card.txt"), "keep this");
  const plan = await snapshots.prepareRestore("workspace", cwd, entries);
  assert.equal(plan.files.length, 3);
  await snapshots.applyRestore(JSON.parse(JSON.stringify(plan)));
  await snapshots.applyRestore(plan);
  assert.equal(
    await readFile(join(cwd, "edit.txt"), "utf8"),
    "dirty before card",
  );
  assert.deepEqual(
    await readFile(join(cwd, "deleted.bin")),
    Buffer.from([0, 128, 255, 42]),
  );
  assert.equal((await lstat(join(cwd, "deleted.bin"))).mode & 0o777, 0o640);
  await assert.rejects(lstat(join(cwd, "新增 空格\n文件.txt")), {
    code: "ENOENT",
  });
  assert.equal(
    await readFile(join(cwd, "later-other-card.txt"), "utf8"),
    "keep this",
  );
  assert.deepEqual(await readFile(join(cwd, ".git", "HEAD")), head);
  assert.deepEqual(await readFile(join(cwd, ".git", "index")), index);
  assert.deepEqual(await readFile(join(cwd, ".git", "config")), config);
});

test("rejects a later content conflict before any file is modified at prepare and apply", async (t) => {
  const { cwd, snapshots, entries, update } = await fixture(t);
  await writeFile(join(cwd, "a.txt"), "original a");
  await writeFile(join(cwd, "z.txt"), "original z");
  await update(async () => {
    await writeFile(join(cwd, "a.txt"), "card a");
    await writeFile(join(cwd, "z.txt"), "card z");
  });
  const plan = await snapshots.prepareRestore("workspace", cwd, entries);
  await writeFile(join(cwd, "z.txt"), "newer edit");
  await assert.rejects(
    snapshots.prepareRestore("workspace", cwd, entries),
    /后续操作.*z\.txt/,
  );
  await assert.rejects(snapshots.applyRestore(plan), /后续操作.*z\.txt/);
  assert.equal(await readFile(join(cwd, "a.txt"), "utf8"), "card a");
  assert.equal(await readFile(join(cwd, "z.txt"), "utf8"), "newer edit");
});

test("refuses interleaved modifications to the same path even when final content matches the last card operation", async (t) => {
  const { cwd, snapshots, entries, update } = await fixture(t);
  await writeFile(join(cwd, "file.txt"), "original");
  await update(() => writeFile(join(cwd, "file.txt"), "first card edit"));
  await writeFile(join(cwd, "file.txt"), "intervening human change");
  await update(() => writeFile(join(cwd, "file.txt"), "second card edit"));
  await assert.rejects(
    snapshots.prepareRestore("workspace", cwd, entries),
    /操作之间.*file\.txt/,
  );
  assert.equal(
    await readFile(join(cwd, "file.txt"), "utf8"),
    "second card edit",
  );
});

test("restore plans survive restart and resume when only some files already match their target", async (t) => {
  const { cwd, data, snapshots, entries, update } = await fixture(t);
  await writeFile(join(cwd, "a"), "original a");
  await writeFile(join(cwd, "b"), "original b");
  await update(async () => {
    await writeFile(join(cwd, "a"), "new a");
    await writeFile(join(cwd, "b"), "new b");
  });
  const plan: GitRestorePlan = JSON.parse(
    JSON.stringify(await snapshots.prepareRestore("workspace", cwd, entries)),
  );
  await writeFile(join(cwd, "a"), "original a");
  await assert.rejects(
    snapshots.prepareRestore("workspace", cwd, entries),
    /后续操作.*a/,
  );
  await new GitSnapshots(data).applyRestore(plan);
  assert.equal(await readFile(join(cwd, "a"), "utf8"), "original a");
  assert.equal(await readFile(join(cwd, "b"), "utf8"), "original b");
});

test("preserves full permissions and detects subsequent permission-only changes", async (t) => {
  const { cwd, snapshots, entries, update } = await fixture(t);
  await writeFile(join(cwd, "script"), "#!/bin/sh\n");
  await chmod(join(cwd, "script"), 0o750);
  await update(async () => {
    await writeFile(join(cwd, "script"), "#!/bin/sh\necho modified\n");
    await chmod(join(cwd, "script"), 0o600);
  });
  await chmod(join(cwd, "script"), 0o640);
  await assert.rejects(
    snapshots.prepareRestore("workspace", cwd, entries),
    /后续操作.*script/,
  );
  await chmod(join(cwd, "script"), 0o600);
  await snapshots.applyRestore(
    await snapshots.prepareRestore("workspace", cwd, entries),
  );
  assert.equal((await lstat(join(cwd, "script"))).mode & 0o777, 0o750);
  assert.equal(await readFile(join(cwd, "script"), "utf8"), "#!/bin/sh\n");
});

test("captures and restores non-executable permission-only operations", async (t) => {
  const { cwd, snapshots, entries, update } = await fixture(t);
  await writeFile(join(cwd, "private.txt"), "unchanged content");
  await chmod(join(cwd, "private.txt"), 0o600);
  const entry = await update(() => chmod(join(cwd, "private.txt"), 0o640));
  assert.deepEqual(entry.files, [{ path: "private.txt", status: "modified" }]);
  await snapshots.applyRestore(
    await snapshots.prepareRestore("workspace", cwd, entries),
  );
  assert.equal((await lstat(join(cwd, "private.txt"))).mode & 0o777, 0o600);
});

test("restores links themselves and regular/link type changes without following external targets", async (t) => {
  const { directory, cwd, snapshots, entries, update } = await fixture(t);
  const outside = join(directory, "outside");
  await writeFile(outside, "untouched external content");
  await symlink(outside, join(cwd, "link"));
  await writeFile(join(cwd, "regular"), "regular original");
  await update(async () => {
    await rm(join(cwd, "link"));
    await writeFile(join(cwd, "link"), "now regular");
    await rm(join(cwd, "regular"));
    await symlink(outside, join(cwd, "regular"));
    await symlink("missing", join(cwd, "created-link"));
  });
  const plan = await snapshots.prepareRestore("workspace", cwd, entries);
  await snapshots.applyRestore(plan);
  await snapshots.applyRestore(plan);
  assert.equal(await readlink(join(cwd, "link")), outside);
  assert.equal(
    await readFile(join(cwd, "regular"), "utf8"),
    "regular original",
  );
  assert.equal(await readFile(outside, "utf8"), "untouched external content");
  await assert.rejects(lstat(join(cwd, "created-link")), { code: "ENOENT" });
});

test("rejects changed directory symlinks and escaping plan paths without touching outside files", async (t) => {
  const { directory, cwd, snapshots, entries, update } = await fixture(t);
  await mkdir(join(cwd, "nested"));
  await writeFile(join(cwd, "nested", "file"), "original");
  await update(() => writeFile(join(cwd, "nested", "file"), "changed"));
  const plan = await snapshots.prepareRestore("workspace", cwd, entries);
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "file"), "changed");
  await rm(join(cwd, "nested"), { recursive: true });
  await symlink(outside, join(cwd, "nested"));
  await assert.rejects(
    snapshots.prepareRestore("workspace", cwd, entries),
    /符号链接/,
  );
  await assert.rejects(snapshots.applyRestore(plan), /符号链接/);
  for (const path of [
    "../outside/file",
    "/outside/file",
    ".git/config",
    "nested/../../outside/file",
  ]) {
    const escaped = structuredClone(plan);
    escaped.files[0].path = path;
    await assert.rejects(snapshots.applyRestore(escaped), /路径无效/);
  }
  assert.equal(await readFile(join(outside, "file"), "utf8"), "changed");
});

test("restores a deleted nested file when its parent directories are missing", async (t) => {
  const { cwd, snapshots, entries, update } = await fixture(t);
  await mkdir(join(cwd, "a", "b"), { recursive: true });
  await writeFile(join(cwd, "a", "b", "file"), "original");
  await update(() => rm(join(cwd, "a"), { recursive: true }));
  await snapshots.applyRestore(
    await snapshots.prepareRestore("workspace", cwd, entries),
  );
  assert.equal(await readFile(join(cwd, "a", "b", "file"), "utf8"), "original");
});

test("missing, failed, mixed-revision and incomplete snapshots are refused without changes", async (t) => {
  const { cwd, snapshots, entries, update } = await fixture(t);
  await writeFile(join(cwd, "file"), "original");
  await update(() => writeFile(join(cwd, "file"), "changed"));
  for (const replacements of [
    [{ ...entries[0], status: "failed" as const }],
    [{ ...entries[0], commit: undefined }],
    [{ ...entries[0], parentCommit: "0".repeat(40) }],
    [{ ...entries[0], files: [] }],
    [entries[0], { ...entries[0], nodeRevision: 1 }],
  ])
    await assert.rejects(
      snapshots.prepareRestore("workspace", cwd, replacements),
    );
  assert.equal(await readFile(join(cwd, "file"), "utf8"), "changed");
});

test("missing target blobs are detected before any working file is changed", async (t) => {
  const { cwd, snapshots, entries, update } = await fixture(t);
  await writeFile(join(cwd, "a"), "original a");
  await writeFile(join(cwd, "z"), "original z");
  await update(async () => {
    await writeFile(join(cwd, "a"), "changed a");
    await writeFile(join(cwd, "z"), "changed z");
  });
  const plan = await snapshots.prepareRestore("workspace", cwd, entries);
  const blob = plan.files.find((file) => file.path === "z")!.target!.blob;
  await rm(join(plan.repository, "objects", blob.slice(0, 2), blob.slice(2)));
  await assert.rejects(snapshots.applyRestore(plan), /Git 快照.*缺失/);
  assert.equal(await readFile(join(cwd, "a"), "utf8"), "changed a");
  assert.equal(await readFile(join(cwd, "z"), "utf8"), "changed z");
});

test("legacy snapshots restore Git mode while retaining current non-executable permissions", async (t) => {
  const { cwd, snapshots, entries, update } = await fixture(t);
  await writeFile(join(cwd, "file"), "original");
  await chmod(join(cwd, "file"), 0o640);
  await update(() => writeFile(join(cwd, "file"), "changed"));
  const baseline = await snapshots.prepare("workspace", cwd);
  await rm(join(baseline.repository, "panel-permissions"), { recursive: true });
  await snapshots.applyRestore(
    await snapshots.prepareRestore("workspace", cwd, entries),
  );
  assert.equal(await readFile(join(cwd, "file"), "utf8"), "original");
  assert.equal((await lstat(join(cwd, "file"))).mode & 0o777, 0o640);
});

test("replay discards an interrupted plan's partial staging file without leaving snapshot artifacts", async (t) => {
  const { cwd, data, snapshots, entries, update } = await fixture(t);
  await writeFile(join(cwd, "file"), "original");
  await update(() => writeFile(join(cwd, "file"), "changed"));
  const plan = await snapshots.prepareRestore("workspace", cwd, entries);
  const staging = join(
    cwd,
    `.panel-restore-${plan.id}-${createHash("sha256").update("file").digest("hex").slice(0, 16)}`,
  );
  await writeFile(staging, "interrupted partial content");
  await writeFile(join(cwd, ".panel-restore-unrelated"), "keep");
  await new GitSnapshots(data).applyRestore(JSON.parse(JSON.stringify(plan)));
  assert.equal(await readFile(join(cwd, "file"), "utf8"), "original");
  await assert.rejects(lstat(staging), { code: "ENOENT" });
  assert.equal(
    await readFile(join(cwd, ".panel-restore-unrelated"), "utf8"),
    "keep",
  );
});
