import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  rename,
  readlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkForUpdate,
  compareVersions,
  versionParts,
  releaseCandidate,
  downloadArchive,
  extractArchive,
  replaceApp,
  supportsArchitecture,
  resolveTargetUpdate,
} from "../desktop/macos/updater.mjs";
import { publishedReleaseMetadata } from "./update-release-feed.mjs";

test("Mach-O validation supports Apple Silicon, Intel and Universal without Xcode", () => {
  const thin = Buffer.alloc(32);
  thin.writeUInt32LE(0xfeedfacf);
  thin.writeUInt32LE(0x0100000c, 4);
  assert.equal(supportsArchitecture(thin, "arm64"), true);
  assert.equal(supportsArchitecture(thin, "x64"), false);
  const fat = Buffer.alloc(48);
  fat.writeUInt32BE(0xcafebabe);
  fat.writeUInt32BE(2, 4);
  fat.writeUInt32BE(0x01000007, 8);
  fat.writeUInt32BE(0x0100000c, 28);
  assert.equal(supportsArchitecture(fat, "arm64"), true);
  assert.equal(supportsArchitecture(fat, "x64"), true);
  assert.equal(supportsArchitecture(fat.subarray(0, 12), "x64"), false);
  assert.equal(
    supportsArchitecture(Buffer.from("not executable"), "arm64"),
    false,
  );
});

const sha = (data) => createHash("sha256").update(data).digest("hex");
test(
  "native updater streams progress and retries background failures without UI errors",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const directory = await temp(t),
      root = fileURLToPath(new URL("../", import.meta.url));
    const run = promisify(execFile),
      binary = join(directory, "pipe-test");
    await run(
      "xcrun",
      [
        "swiftc",
        "-swift-version",
        "5",
        "-module-cache-path",
        join(root, "build/swift-cache"),
        join(root, "desktop/macos/Updater.swift"),
        join(root, "scripts/test-updater-pipe.swift"),
        "-o",
        binary,
      ],
      { timeout: 60_000 },
    );
    await run(binary, [process.execPath], { timeout: 10_000 });
  },
);
function release(version = "v0.6", overrides = {}) {
  return {
    tag_name: version,
    draft: false,
    prerelease: false,
    published_at: "2026-09-30T00:00:00Z",
    assets: [
      {
        name: `Panel-mac-${process.arch}.zip`,
        state: "uploaded",
        size: 3,
        digest: `sha256:${sha("zip")}`,
        browser_download_url: `https://github.com/H0ypothesis/panel/releases/download/${version}/Panel-mac-${process.arch}.zip`,
      },
    ],
    ...overrides,
  };
}
async function temp(t) {
  const path = await mkdtemp(join(tmpdir(), "panel-updater-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("numeric versions, previews and release selection never downgrade", async () => {
  assert.equal(compareVersions("v0.10", "0.9.2"), 1);
  assert.equal(compareVersions("v0.5", "0.5.0"), 0);
  assert.equal(compareVersions("0.5.1", "v0.5"), 1);
  for (const value of [
    "v0.6-beta",
    "macos-preview-2026-09-29",
    "1",
    "v0.5/evil",
    "0.9007199254740999",
  ])
    assert.equal(versionParts(value), null);
  assert.equal(
    (
      await checkForUpdate("0.5.0", [
        release("v0.6"),
        release("v0.10"),
        release("v0.11-beta"),
        release("v0.12", { draft: true }),
      ])
    ).version,
    "v0.10",
  );
  assert.equal(
    await checkForUpdate("0.6.0", [release("v0.5"), release("v0.6")]),
    null,
  );
  assert.equal(
    releaseCandidate(release("v0.6", { prerelease: true }), "0.5").version,
    "v0.6",
  );
});

test("only matching, uploaded, digest-bearing assets from this repository are eligible", () => {
  for (const patch of [
    { digest: null },
    { state: "new" },
    { size: -1 },
    { size: 1024 ** 3 },
    { name: "other.zip" },
    { browser_download_url: "https://evil.example/Panel.zip" },
  ]) {
    const item = release();
    item.assets[0] = { ...item.assets[0], ...patch };
    assert.equal(releaseCandidate(item, "0.5"), null);
  }
  assert.equal(
    releaseCandidate(
      release(),
      "0.5",
      process.arch === "arm64" ? "x64" : "arm64",
    ),
    null,
  );
});

const feed = (releases) => ({
  schemaVersion: 1,
  repository: "H0ypothesis/panel",
  releases,
});

test("403 and offline API fall back to public release metadata for both check and install", async () => {
  for (const failure of [403, 429, "offline"]) {
    const calls = [];
    const fetchMetadata = async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, undefined);
      if (url.startsWith("https://api.github.com/")) {
        if (failure === "offline") throw new TypeError("fetch failed");
        return new Response("denied", { status: failure });
      }
      assert.equal(
        url,
        "https://raw.githubusercontent.com/H0ypothesis/panel/main/updates/macos.json",
      );
      return Response.json(feed([release("v0.6"), release("v0.5.1")]));
    };
    assert.equal(
      (await checkForUpdate("0.5", undefined, fetchMetadata)).version,
      "v0.6",
    );
    // Preparing a previously chosen version must not silently install a newer release.
    assert.equal(
      (await resolveTargetUpdate("0.5", "v0.5.1", fetchMetadata)).version,
      "v0.5.1",
    );
    assert.equal(await checkForUpdate("0.6", undefined, fetchMetadata), null);
    assert.equal(calls.length, 6);
  }
});

test("healthy API needs no fallback; fallback cannot weaken archive trust or target selection", async () => {
  let calls = 0;
  assert.equal(
    (
      await checkForUpdate("0.5", undefined, async () => {
        calls++;
        return Response.json([release()]);
      })
    ).version,
    "v0.6",
  );
  assert.equal(calls, 1);
  for (const patch of [
    { digest: null },
    { browser_download_url: "https://evil.example/app.zip" },
    { size: -1 },
  ]) {
    const untrusted = release();
    Object.assign(untrusted.assets[0], patch);
    const fetchMetadata = async (url) =>
      url.includes("api.github.com")
        ? new Response(null, { status: 403 })
        : Response.json(feed([untrusted]));
    assert.equal(await checkForUpdate("0.5", undefined, fetchMetadata), null);
    await assert.rejects(
      resolveTargetUpdate("0.5", "v0.6", fetchMetadata),
      /可校验/,
    );
    assert.throws(() => publishedReleaseMetadata(untrusted), /verified/);
  }
  assert.throws(
    () => publishedReleaseMetadata(release("v0.6", { draft: true })),
    /published/,
  );
  assert.equal(
    publishedReleaseMetadata(release()).assets[0].digest,
    release().assets[0].digest,
  );
});

test("unreachable or malformed fallback remains an error and preserves rate-limit retry timing", async () => {
  for (const fallback of [
    null,
    {},
    { ...feed([]), repository: "someone/else" },
  ]) {
    const fetchMetadata = async (url) => {
      if (url.includes("api.github.com"))
        return new Response(null, {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "retry-after": "3600" },
        });
      if (!fallback) throw new TypeError("offline");
      return Response.json(fallback);
    };
    await assert.rejects(
      checkForUpdate("0.5", undefined, fetchMetadata),
      (error) => {
        assert.match(error.message, /限流/);
        assert.equal(error.retryAfter, 3600);
        return true;
      },
    );
  }
});

test("download verifies content hash and rejects foreign or insecure redirects", async (t) => {
  const directory = await temp(t),
    candidate = releaseCandidate(release(), "0.5");
  const progress = [];
  await downloadArchive(
    candidate,
    join(directory, "valid.zip"),
    (value) => progress.push(value),
    async () => new Response("zip"),
  );
  assert.equal(await readFile(join(directory, "valid.zip"), "utf8"), "zip");
  assert.equal(progress.at(-1), 100);
  await assert.rejects(
    downloadArchive(
      candidate,
      join(directory, "bad.zip"),
      undefined,
      async () => new Response("bad"),
    ),
    /SHA-256/,
  );
  await assert.rejects(
    downloadArchive(
      candidate,
      join(directory, "oversize.zip"),
      undefined,
      async () => new Response("long"),
    ),
    /大小/,
  );
  for (const location of [
    "http://github.com/archive.zip",
    "https://evil.example/archive.zip",
    "https://github.com@evil.example/archive.zip",
  ]) {
    let calls = 0;
    await assert.rejects(
      downloadArchive(
        candidate,
        join(directory, `redirect-${calls}.zip`),
        undefined,
        async () => {
          calls++;
          return new Response(null, {
            status: 302,
            headers: { Location: location },
          });
        },
      ),
      /不受信任/,
    );
    assert.equal(calls, 1);
  }
});

// Minimal independent ZIP writer builds deliberately malformed metadata as
// well as valid POSIX symlinks, without relying on the extraction library.
function zip(entries) {
  const local = [],
    central = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name),
      data = Buffer.from(item.data ?? "");
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(item.size ?? data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(0x314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(item.size ?? data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((item.mode ?? 0o100644) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    local.push(header, name, data);
    central.push(record, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test("extraction preserves executable bits and safe internal framework symlinks", async (t) => {
  const directory = await temp(t),
    archive = join(directory, "app.zip");
  await writeFile(
    archive,
    zip([
      {
        name: "Panel.app/Contents/MacOS/Panel",
        data: "executable",
        mode: 0o100755,
      },
      { name: "Panel.app/Versions/A/file", data: "resource" },
      { name: "Panel.app/Versions/Current", data: "A", mode: 0o120777 },
      { name: "__MACOSX/._Panel.app", data: "metadata" },
    ]),
  );
  const app = await extractArchive(archive, join(directory, "unpacked"));
  assert.equal(
    await readFile(join(app, "Versions/Current/file"), "utf8"),
    "resource",
  );
  assert.equal(await readlink(join(app, "Versions/Current")), "A");
});

test("extraction blocks traversal, duplicate paths, special files and symlink escapes", async (t) => {
  const directory = await temp(t);
  const cases = [
    [{ name: "../outside", data: "bad" }],
    [{ name: "/tmp/outside", data: "bad" }],
    [{ name: "Other.app/file", data: "bad" }],
    [
      { name: "Panel.app/file", data: "a" },
      { name: "Panel.app/FILE", data: "b" },
    ],
    [{ name: "Panel.app/socket", mode: 0o140777 }],
    [{ name: "Panel.app/link", data: "../../outside", mode: 0o120777 }],
    [
      { name: "Panel.app/link", data: "dir", mode: 0o120777 },
      { name: "Panel.app/link/file", data: "bad" },
    ],
    [{ name: "Panel.app/file", data: "small", size: 3 * 1024 ** 3 }],
  ];
  for (const [i, entries] of cases.entries()) {
    const archive = join(directory, `${i}.zip`);
    await writeFile(archive, zip(entries));
    await assert.rejects(extractArchive(archive, join(directory, `case-${i}`)));
  }
  await assert.rejects(readFile(join(directory, "outside")), {
    code: "ENOENT",
  });
});

test("successful replacement launches the new app and retains the backup until confirmed", async (t) => {
  const directory = await temp(t),
    app = join(directory, "Panel.app"),
    prepared = join(directory, "Next.app"),
    backup = join(directory, "Previous.app");
  await mkdir(app);
  await mkdir(prepared);
  await writeFile(join(app, "version"), "old");
  await writeFile(join(prepared, "version"), "new");
  await replaceApp({
    app,
    prepared,
    backup,
    launch: async (path) =>
      assert.equal(await readFile(join(path, "version"), "utf8"), "new"),
  });
  assert.equal(await readFile(join(backup, "version"), "utf8"), "old");
});

for (const failure of ["move", "launch"])
  test(`${failure} failure restores the original app`, async (t) => {
    const directory = await temp(t),
      app = join(directory, "Panel.app"),
      prepared = join(directory, "Next.app"),
      backup = join(directory, "Previous.app");
    await mkdir(app);
    await mkdir(prepared);
    await writeFile(join(app, "version"), "old");
    await writeFile(join(prepared, "version"), "new");
    const launches = [];
    await assert.rejects(
      replaceApp({
        app,
        prepared,
        backup,
        move: async (from, to) => {
          if (failure === "move" && from === prepared)
            throw new Error("injected move failure");
          await rename(from, to);
        },
        launch: async (path) => {
          const version = await readFile(join(path, "version"), "utf8");
          launches.push(version);
          if (failure === "launch" && version === "new")
            throw new Error("injected launch failure");
        },
      }),
      /injected/,
    );
    assert.equal(await readFile(join(app, "version"), "utf8"), "old");
    assert.equal(launches.at(-1), "old");
  });
