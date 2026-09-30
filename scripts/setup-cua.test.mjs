import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  release,
  runtimeTarget,
  setupCua,
  validateArchiveEntries,
  verifyArchive,
} from "./setup-cua.mjs";

test("release pins the official stable SemVer and exact GitHub asset digest", () => {
  assert.equal(release.version, "0.30.4");
  const asset = release.assets["darwin-universal"];
  assert.equal(
    asset.sha256,
    "9c75a186f89352fb522dc67791575f8c9e8081a38795af2706e103d41fa72be4",
  );
  assert.equal(new URL(asset.url).hostname, "github.com");
  assert.equal(runtimeTarget("darwin", "x64"), "darwin-universal");
  assert.equal(runtimeTarget("darwin", "arm64"), "darwin-universal");
  assert.throws(() => runtimeTarget("win32", "x64"), /does not support/);
});

test("archive verification refuses truncation and tampering before extraction", () => {
  const bytes = Buffer.from("official release bytes");
  const asset = {
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  verifyArchive(bytes, asset);
  assert.throws(() => verifyArchive(bytes.subarray(1), asset), /size/);
  assert.throws(
    () => verifyArchive(Buffer.alloc(bytes.length), asset),
    /SHA256/,
  );
  assert.throws(
    () => validateArchiveEntries("bundle/../../escaped"),
    /Unsafe path/,
  );
  assert.throws(() => validateArchiveEntries("/absolute"), /Unsafe path/);
  validateArchiveEntries(
    "bundle/CuaDriver.app/Contents/MacOS/cua-driver\nbundle/LICENSE\n",
  );
});

test("bad download is cleaned up without installing or launching a driver", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-cua-setup-test-"));
  try {
    await assert.rejects(
      setupCua({
        projectRoot: root,
        platform: "darwin",
        arch: "arm64",
        fetchArchive: async () => new Response("tampered"),
      }),
      /size/,
    );
    assert.deepEqual(
      await readdir(join(root, ".panel/cua-driver", release.version)),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
