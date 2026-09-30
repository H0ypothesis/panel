import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { piWebEnvironment } from "./pi-web-access.ts";
import {
  closeNativeWebSessions,
  createNativeWebSession,
} from "./native-web-session.ts";

test("native web session environment excludes unrelated provider keys, cookies and inherited config", () => {
  const original = { ...process.env };
  try {
    process.env.EXA_API_KEY = "exa-test-key";
    process.env.GEMINI_API_KEY = "private-model-key";
    process.env.PI_ALLOW_BROWSER_COOKIES = "1";
    process.env.NODE_OPTIONS = "--inspect";
    process.env.HTTPS_PROXY = "http://proxy.invalid";
    const environment = piWebEnvironment("/tmp/panel-test-config");
    assert.equal(environment.EXA_API_KEY, "exa-test-key");
    for (const key of [
      "GEMINI_API_KEY",
      "PI_ALLOW_BROWSER_COOKIES",
      "NODE_OPTIONS",
      "HTTPS_PROXY",
    ])
      assert.equal(environment[key], undefined);
    assert.equal(environment.HOME, "/tmp/panel-test-config");
    assert.equal(environment.PI_CODING_AGENT_DIR, "/tmp/panel-test-config");
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  }
});

test("nonpublic URLs fail before starting the native worker", async () => {
  const session = createNativeWebSession();
  try {
    await assert.rejects(
      session.run({
        name: "fetch_content",
        args: { url: "http://127.0.0.1/private" },
      }),
      /公共互联网/,
    );
  } finally {
    await session.close();
  }
});

test("server shutdown closes native workers and removes their session caches", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "panel-native-shutdown-test-"),
  );
  const original = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  const session = createNativeWebSession();
  try {
    await assert.rejects(
      session.run({
        name: "get_search_content",
        args: { responseId: "missing" },
      }),
      /Not found/,
    );
    assert.ok(
      (await readdir(directory)).some((name) =>
        name.startsWith("panel-native-web-"),
      ),
    );
    await closeNativeWebSessions();
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(
      session.run({
        name: "get_search_content",
        args: { responseId: "missing" },
      }),
      /已结束/,
    );
  } finally {
    await session.close();
    if (original === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = original;
    await rm(directory, { recursive: true, force: true });
  }
});
