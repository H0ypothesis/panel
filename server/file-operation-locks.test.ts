import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { createPanelTools } from "./coding-tools.ts";
import {
  FileOperationLocks,
  resolveFileOperationResource,
  resolveRestoreFileResource,
  validateFileOperationResource,
  type FileOperationResource,
} from "./file-operation-locks.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "panel-file-locks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "work");
  await mkdir(cwd);
  return { directory, cwd, root: await realpath(cwd) };
}

function file(path: string, mode: "read" | "write" = "write") {
  return {
    global: false,
    mode,
    workingDirectory: "/workspace",
    canonicalPath: join("/workspace", path),
  } satisfies FileOperationResource;
}

test("restores lock literal Git filenames and do not lock empty changes", async (t) => {
  const { cwd, root } = await fixture(t);
  assert.equal(await resolveRestoreFileResource(cwd, []), undefined);
  const resource = await resolveRestoreFileResource(cwd, [
    "@a.txt",
    "new/b.txt",
    "@a.txt",
  ]);
  assert.deepEqual(resource, {
    global: false,
    mode: "write",
    workingDirectory: root,
    canonicalPaths: [join(root, "@a.txt"), join(root, "new/b.txt")],
  });
  for (const path of [
    "../outside",
    "/outside",
    ".git/config",
    "node_modules/a",
    "a/../b",
  ])
    await assert.rejects(resolveRestoreFileResource(cwd, [path]), /回溯路径/);
  await symlink("@a.txt", join(cwd, "dangling"));
  assert.equal(
    (await resolveRestoreFileResource(cwd, ["dangling"]))?.global,
    true,
  );
  await writeFile(join(cwd, "linked.txt"), "shared inode");
  await link(join(cwd, "linked.txt"), join(cwd, "alias.txt"));
  assert.equal(
    (await resolveRestoreFileResource(cwd, ["linked.txt"]))?.global,
    true,
  );
});

test("multi-file restore locks wait atomically and allow unrelated paths through", async () => {
  const locks = new FileOperationLocks();
  const releaseB = await locks.acquire(file("b.txt"));
  const paths = ["a.txt", "b.txt"].map((path) => join("/workspace", path));
  let waited = false;
  const pendingRestore = locks.acquire(
    {
      global: false,
      mode: "write",
      workingDirectory: "/workspace",
      canonicalPaths: paths,
    },
    undefined,
    () => {
      waited = true;
    },
  );
  assert.equal(waited, true);
  // Mutating the caller's list must not shrink a pending reservation.
  paths.splice(0);
  let readWaited = false;
  const pendingRead = locks.acquire(file("a.txt", "read"), undefined, () => {
    readWaited = true;
  });
  assert.equal(readWaited, true);
  (await locks.acquire(file("unrelated.txt")))();
  releaseB();
  const releaseRestore = await pendingRestore;
  let globalWaited = false;
  const pendingShell = locks.acquire(
    { global: true, mode: "write", workingDirectory: "/elsewhere" },
    undefined,
    () => {
      globalWaited = true;
    },
  );
  assert.equal(globalWaited, true);
  releaseRestore();
  (await pendingRead)();
  (await pendingShell)();
});

test("resolve new paths from a canonical workspace and internal symlink ancestors", async (t) => {
  const { directory, cwd, root } = await fixture(t);
  await mkdir(join(cwd, "src"));
  await symlink("src", join(cwd, "alias"));
  await symlink(cwd, join(directory, "workspace-alias"));
  const resource = await resolveFileOperationResource(
    join(directory, "workspace-alias"),
    "write",
    { path: "alias/new/deep/file.ts" },
  );
  assert.deepEqual(resource, {
    global: false,
    mode: "write",
    workingDirectory: root,
    canonicalPath: join(root, "src/new/deep/file.ts"),
    snapshotPaths: [join(root, "src/new/deep/file.ts")],
  });
  await validateFileOperationResource(resource, cwd, "write", {
    path: "src/new/deep/file.ts",
  });
});

test("file aliases resolve to the same lock and reads use shared mode", async (t) => {
  const { cwd, root } = await fixture(t);
  await writeFile(join(cwd, "file.txt"), "original");
  await symlink("file.txt", join(cwd, "alias"));
  const canonical = await resolveFileOperationResource(cwd, "read", {
    path: "file.txt",
  });
  const alias = await resolveFileOperationResource(cwd, "read", {
    path: "alias",
  });
  assert.deepEqual(canonical, alias);
  assert.equal(alias?.mode, "read");
  assert.equal(alias?.canonicalPath, join(root, "file.txt"));
  const edit = await resolveFileOperationResource(cwd, "edit", {
    path: "alias",
  });
  assert.equal(edit?.mode, "write");
});

test("Pi file URLs and home-directory notation resolve to the actual tool paths", async (t) => {
  const { cwd, root } = await fixture(t);
  const resource = await resolveFileOperationResource(cwd, "write", {
    path: pathToFileURL(join(cwd, "new file.txt")).href,
  });
  assert.equal(resource?.canonicalPath, join(root, "new file.txt"));
  const home = await realpath(homedir());
  const fromHome = await resolveFileOperationResource(homedir(), "read", {
    path: "~",
  });
  assert.equal(fromHome?.canonicalPath, home);
  const inHome = await resolveFileOperationResource(homedir(), "read", {
    path: "~/panel-lock-path-resolution-example",
  });
  assert.equal(
    inHome?.canonicalPath,
    join(home, "panel-lock-path-resolution-example"),
  );
  await assert.rejects(
    resolveFileOperationResource(cwd, "write", {
      path: pathToFileURL(join(root, "../outside")).href,
    }),
    /超出当前工作目录/,
  );
  await assert.rejects(
    resolveFileOperationResource(cwd, "write", { path: "~/outside" }),
    /超出当前工作目录/,
  );
});

test("Pi @ and Unicode-space paths lock and snapshot the actual written file", async (t) => {
  const { cwd, root } = await fixture(t);
  const locks = new FileOperationLocks();
  const tools = createPanelTools(cwd);
  const write = tools.find((tool) => tool.name === "write")!;
  for (const path of [
    "@foo.ts",
    "@hello\u00a0file.txt",
    "hello\u2009file.txt",
  ]) {
    const expected = path.includes("foo") ? "foo.ts" : "hello file.txt";
    const resource = await resolveFileOperationResource(cwd, "write", { path });
    assert.equal(resource?.canonicalPath, join(root, expected));
    assert.deepEqual(resource?.snapshotPaths, [join(root, expected)]);
    const release = await locks.acquire(resource);
    let waited = false;
    const pending = locks.acquire(
      await resolveFileOperationResource(cwd, "edit", { path: expected }),
      undefined,
      () => {
        waited = true;
      },
    );
    assert.equal(waited, true);
    await write.execute("write-normalized", { path, content: "actual target" });
    assert.equal(await readFile(join(root, expected), "utf8"), "actual target");
    release();
    (await pending)();
  }
});

test("read variants use the same curly-quote, AM/PM-space and NFD file as Pi", async (t) => {
  const { cwd } = await fixture(t);
  const read = createPanelTools(cwd).find((tool) => tool.name === "read")!;
  const variants = [
    ["it's.txt", "it\u2019s.txt"],
    ["shot 10 AM.png.txt", "shot 10\u202fAM.png.txt"],
    ["caf\u00e9.txt", "cafe\u0301.txt"],
  ];
  for (const [input, actual] of variants) {
    await writeFile(join(cwd, actual), `content of ${actual}`);
    const resource = await resolveFileOperationResource(cwd, "read", {
      path: input,
    });
    assert.equal(resource?.canonicalPath, await realpath(join(cwd, actual)));
    const result = await read.execute("read-variant", { path: input });
    assert.deepEqual(result.content, [
      { type: "text", text: `content of ${actual}` },
    ]);
  }
});

test("read variants are generated after internal symlink canonicalization", async (t) => {
  const { cwd } = await fixture(t);
  await mkdir(join(cwd, "target'folder"));
  await mkdir(join(cwd, "target\u2019folder"));
  await symlink("target'folder", join(cwd, "alias"));
  const actual = join(cwd, "target\u2019folder/file.txt");
  await writeFile(actual, "canonical fallback");
  const resource = await resolveFileOperationResource(cwd, "read", {
    path: "alias/file.txt",
  });
  assert.equal(resource?.canonicalPath, await realpath(actual));
  const read = createPanelTools(cwd).find((tool) => tool.name === "read")!;
  const result = await read.execute("canonical-fallback", {
    path: "alias/file.txt",
  });
  assert.deepEqual(result.content, [
    { type: "text", text: "canonical fallback" },
  ]);
});

test("traversal, external symlinks and dangling symlinks cannot acquire file resources", async (t) => {
  const { directory, cwd } = await fixture(t);
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "secret"), "private");
  await symlink(outside, join(cwd, "escape"));
  await symlink(join(outside, "missing"), join(cwd, "dangling"));
  for (const path of [
    "../outside/secret",
    join(outside, "secret"),
    "escape/secret",
    "escape/new/deep/file",
    "dangling",
    "dangling/deep/file",
  ]) {
    await assert.rejects(resolveFileOperationResource(cwd, "write", { path }));
  }
});

test("file tools reject missing paths and non-directory workspaces", async (t) => {
  const { cwd } = await fixture(t);
  for (const path of [undefined, "", null, 12]) {
    await assert.rejects(
      resolveFileOperationResource(cwd, "read", { path }),
      /有效路径/,
    );
  }
  await writeFile(join(cwd, "file"), "x");
  await assert.rejects(
    resolveFileOperationResource(join(cwd, "file"), "bash", {}),
    /必须是文件夹/,
  );
});

test("shell and hard-linked files require global locks and whole-workspace snapshots", async (t) => {
  const { directory, cwd, root } = await fixture(t);
  await writeFile(join(cwd, "file.txt"), "original");
  await link(join(cwd, "file.txt"), join(directory, "outside-alias"));
  assert.deepEqual(await resolveFileOperationResource(cwd, "bash", {}), {
    global: true,
    mode: "write",
    workingDirectory: root,
  });
  for (const tool of ["read", "write", "edit"]) {
    const resource = await resolveFileOperationResource(cwd, tool, {
      path: "file.txt",
    });
    assert.equal(resource?.global, true);
    assert.equal(resource?.snapshotPaths, undefined);
    assert.equal(resource?.canonicalPath, join(root, "file.txt"));
  }
  const directoryResource = await resolveFileOperationResource(cwd, "read", {
    path: ".",
  });
  assert.equal(directoryResource?.global, false);
});

test("web tools do not require a directory or file lock", async () => {
  for (const tool of ["web_search", "web_fetch"]) {
    assert.equal(
      await resolveFileOperationResource("/does/not/exist", tool, {}),
      undefined,
    );
  }
});

test("revalidation detects a symlink retargeted while waiting", async (t) => {
  const { cwd } = await fixture(t);
  await writeFile(join(cwd, "a"), "a");
  await writeFile(join(cwd, "b"), "b");
  await symlink("a", join(cwd, "alias"));
  const resource = await resolveFileOperationResource(cwd, "edit", {
    path: "alias",
  });
  await rm(join(cwd, "alias"));
  await symlink("b", join(cwd, "alias"));
  await assert.rejects(
    validateFileOperationResource(resource, cwd, "edit", { path: "alias" }),
    /等待期间/,
  );
});

test("revalidation detects a new hard link and a retargeted workspace", async (t) => {
  const { directory, cwd } = await fixture(t);
  await writeFile(join(cwd, "a"), "a");
  const resource = await resolveFileOperationResource(cwd, "write", {
    path: "a",
  });
  await link(join(cwd, "a"), join(directory, "linked"));
  await assert.rejects(
    validateFileOperationResource(resource, cwd, "write", { path: "a" }),
    /等待期间/,
  );
  const alias = join(directory, "workspace-alias");
  await symlink(cwd, alias);
  const shell = await resolveFileOperationResource(alias, "bash", {});
  await rm(alias);
  await symlink(directory, alias);
  await assert.rejects(
    validateFileOperationResource(shell, alias, "bash", {}),
    /等待期间/,
  );
});

test("different files run concurrently and reads of the same file share a lock", async () => {
  const locks = new FileOperationLocks();
  const releaseA = await locks.acquire(file("a"));
  const releaseB = await locks.acquire(file("b"));
  const releaseReadA = await locks.acquire(file("c", "read"));
  const releaseReadB = await locks.acquire(file("c", "read"));
  releaseA();
  releaseB();
  releaseReadA();
  releaseReadB();
});

test("writes wait for all readers and later readers cannot bypass a waiting writer", async () => {
  const locks = new FileOperationLocks();
  const releaseA = await locks.acquire(file("a", "read"));
  const releaseB = await locks.acquire(file("a", "read"));
  const events: string[] = [];
  const writer = locks.acquire(file("a")).then((release) => {
    events.push("writer");
    return release;
  });
  const reader = locks.acquire(file("a", "read")).then((release) => {
    events.push("reader");
    return release;
  });
  releaseA();
  await Promise.resolve();
  assert.deepEqual(events, []);
  releaseB();
  const releaseWriter = await writer;
  assert.deepEqual(events, ["writer"]);
  releaseWriter();
  const releaseReader = await reader;
  assert.deepEqual(events, ["writer", "reader"]);
  releaseReader();
});

test("parent and child paths conflict but similarly-prefixed siblings do not", async () => {
  const locks = new FileOperationLocks();
  const releaseParent = await locks.acquire(file("src"));
  let waited = false;
  const child = locks.acquire(file("src/file"), undefined, () => {
    waited = true;
  });
  assert.equal(waited, true);
  const releaseSibling = await locks.acquire(file("src-other/file"));
  releaseParent();
  const releaseChild = await child;
  releaseSibling();
  releaseChild();
});

test(
  "case and Unicode variants of new filenames conflict on macOS and Windows",
  { skip: process.platform !== "darwin" && process.platform !== "win32" },
  async () => {
    const locks = new FileOperationLocks();
    const release = await locks.acquire(file("Src/Caf\u00e9.txt"));
    let waited = false;
    const pending = locks.acquire(file("src/CAFE\u0301.TXT"), undefined, () => {
      waited = true;
    });
    assert.equal(waited, true);
    release();
    (await pending)();
  },
);

test("unrelated files bypass blocked operations without bypassing conflicts", async () => {
  const locks = new FileOperationLocks();
  const releaseFirst = await locks.acquire(file("a"));
  const events: string[] = [];
  const second = locks.acquire(file("a")).then((release) => {
    events.push("second");
    return release;
  });
  const third = locks.acquire(file("a")).then((release) => {
    events.push("third");
    return release;
  });
  const releaseOther = await locks.acquire(file("b"));
  assert.deepEqual(events, []);
  releaseFirst();
  const releaseSecond = await second;
  assert.deepEqual(events, ["second"]);
  releaseSecond();
  const releaseThird = await third;
  assert.deepEqual(events, ["second", "third"]);
  releaseOther();
  releaseThird();
});

test("global operations exclude every workspace and prevent starvation by later operations", async () => {
  const locks = new FileOperationLocks();
  const releaseFirst = await locks.acquire(file("a", "read"));
  const events: string[] = [];
  const global = locks
    .acquire({ global: true, mode: "write", workingDirectory: "/elsewhere" })
    .then((release) => {
      events.push("global");
      return release;
    });
  const other = locks.acquire(file("b", "read")).then((release) => {
    events.push("other");
    return release;
  });
  await Promise.resolve();
  assert.deepEqual(events, []);
  releaseFirst();
  const releaseGlobal = await global;
  assert.deepEqual(events, ["global"]);
  releaseGlobal();
  const releaseOther = await other;
  assert.deepEqual(events, ["global", "other"]);
  releaseOther();
});

test("cancelling a waiting operation removes its queue position and listener", async () => {
  const locks = new FileOperationLocks();
  const releaseFirst = await locks.acquire(file("a", "read"));
  const controller = new AbortController();
  const pending = locks.acquire(file("a"), controller.signal);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  const later = locks.acquire(file("a", "read"));
  controller.abort();
  await rejected;
  const releaseLater = await later;
  releaseFirst();
  releaseLater();
});

test("aborting a holder preserves its lock until explicit release and release is idempotent", async () => {
  const locks = new FileOperationLocks();
  const controller = new AbortController();
  const releaseFirst = await locks.acquire(file("a"), controller.signal);
  let acquired = false;
  const pending = locks.acquire(file("a")).then((release) => {
    acquired = true;
    return release;
  });
  controller.abort();
  await Promise.resolve();
  assert.equal(acquired, false);
  releaseFirst();
  const releaseSecond = await pending;
  releaseFirst();
  let thirdAcquired = false;
  const third = locks.acquire(file("a")).then((release) => {
    thirdAcquired = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(thirdAcquired, false);
  releaseSecond();
  (await third)();
});

test("already-aborted and throwing wait notifications do not leave queued locks", async () => {
  const locks = new FileOperationLocks();
  const release = await locks.acquire(file("a"));
  await assert.rejects(locks.acquire(file("a"), AbortSignal.abort()), {
    name: "AbortError",
  });
  await assert.rejects(
    locks.acquire(file("a"), undefined, () => {
      throw new Error("notification failed");
    }),
    /notification failed/,
  );
  release();
  (await locks.acquire(file("a")))();
});

test("onWait is called once only when blocked and can abort its own queued request", async () => {
  const locks = new FileOperationLocks();
  let waits = 0;
  const release = await locks.acquire(file("a"), undefined, () => waits++);
  assert.equal(waits, 0);
  const controller = new AbortController();
  const pending = locks.acquire(file("a"), controller.signal, () => {
    waits++;
    controller.abort();
  });
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(waits, 1);
  release();
  (await locks.acquire(file("a")))();
});

test("resources are captured at acquisition and absent resources never block", async () => {
  const locks = new FileOperationLocks();
  const resource = file("a");
  const release = await locks.acquire(resource);
  resource.canonicalPath = "/workspace/b";
  let waited = false;
  const pending = locks.acquire(file("a"), undefined, () => {
    waited = true;
  });
  assert.equal(waited, true);
  (await locks.acquire(undefined))();
  release();
  (await pending)();
});
