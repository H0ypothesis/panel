import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { discoverModels } from "./model-discovery.ts";
import { ModelProviderSettings } from "./provider-settings.ts";
import { PiRuntime } from "./runtime.ts";
import { createApi } from "./api.ts";
import { Store } from "./store.ts";
import { Scheduler } from "./scheduler.ts";

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "panel-model-discovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new ModelProviderSettings(directory);
  await settings.init();
  return { directory, settings };
}

test("unsaved credentials discover and normalize a catalog without changing settings or registering models", async (t) => {
  const { directory, settings } = await setup(t);
  const before = settings.list();
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    assert.equal(String(url), "https://gateway.invalid/proxy/v1/models");
    assert.equal(
      new Headers(options.headers).get("authorization"),
      "Bearer draft-secret",
    );
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return Response.json({
      data: [
        { id: "z-model", name: "Z model" },
        { id: "a/model" },
        { id: "z-model", name: "Z model" },
        { id: "bad model" },
        { id: "a\nkey" },
        { id: "x".repeat(241) },
        { id: 12 },
        null,
      ],
    });
  });
  assert.deepEqual(
    await settings.discover("openai", {
      baseUrl: "https://gateway.invalid/proxy/v1/",
      apiKey: "draft-secret",
    }),
    {
      models: [
        { id: "a/model", name: "a/model" },
        { id: "z-model", name: "Z model" },
      ],
      truncated: false,
    },
  );
  assert.deepEqual(settings.list(), before);
  await assert.rejects(readFile(join(directory, "model-providers.json")), {
    code: "ENOENT",
  });
});

test("provider authentication and versioned URLs match their generation protocols", async (t) => {
  const { settings } = await setup(t);
  const calls: { url: string; headers: Headers }[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(options.headers) });
    return Response.json({ data: [], models: [] });
  });
  for (const [id, baseUrl] of [
    ["anthropic", "https://claude.invalid"],
    ["atria", "https://atria.invalid/v1"],
    ["paperbypass", "https://gateway.invalid/api"],
    ["google", "https://google.invalid/v1beta"],
    ["xiaomi-token-plan-cn", "https://mimo.invalid/v1"],
  ])
    await settings.discover(id, { baseUrl, apiKey: "test-secret" });
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      "https://claude.invalid/v1/models",
      "https://atria.invalid/v1/models",
      "https://gateway.invalid/api/v1/models",
      "https://google.invalid/v1beta/models",
      "https://mimo.invalid/v1/models",
    ],
  );
  assert.equal(calls[0].headers.get("x-api-key"), "test-secret");
  assert.equal(calls[0].headers.get("anthropic-version"), "2023-06-01");
  assert.equal(calls[2].headers.get("authorization"), "Bearer test-secret");
  assert.equal(calls[3].headers.get("x-goog-api-key"), "test-secret");
  assert.equal(calls[4].headers.get("authorization"), "Bearer test-secret");
});

test("Paperbypass discovers slug-based model IDs and display names without changing saved settings", async (t) => {
  const { settings, directory } = await setup(t);
  await settings.save("paperbypass", {
    baseUrl: "https://gateway.invalid/api",
    apiKey: "saved-secret",
    model: "z-ai/glm-5.3-flash",
  });
  const before = await readFile(
    join(directory, "model-providers.json"),
    "utf8",
  );
  const catalogBefore = settings.list();
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, options: RequestInit) => {
    urls.push(String(url));
    assert.equal(
      new Headers(options.headers).get("authorization"),
      "Bearer saved-secret",
    );
    return Response.json({
      success: true,
      data: [
        {
          slug: "z-ai/glm-5.3-flash",
          displayName: "GLM 5.3 Flash",
          contextWindow: 128000,
          supportedInterfaces: ["/messages", "/chat/completions"],
        },
        { slug: "Atria-Dawn-Preview", displayName: "Atria-Dawn-Preview" },
        { slug: "z-ai/glm-5.3-flash", displayName: "GLM 5.3 Flash" },
        { id: "standard-id", display_name: "Standard ID" },
        { slug: "public-slug", id: 123, displayName: "Public Slug" },
        { slug: "bad model" },
      ],
    });
  });
  const result = await settings.discover("paperbypass", {
    baseUrl: "https://gateway.invalid/api/",
  });
  assert.deepEqual(urls, ["https://gateway.invalid/api/v1/models"]);
  assert.deepEqual(result, {
    models: [
      { id: "Atria-Dawn-Preview", name: "Atria-Dawn-Preview" },
      { id: "public-slug", name: "Public Slug" },
      { id: "standard-id", name: "Standard ID" },
      {
        id: "z-ai/glm-5.3-flash",
        name: "GLM 5.3 Flash",
        contextWindow: 128000,
      },
    ],
    truncated: false,
  });
  assert.deepEqual(settings.list(), catalogBefore);
  assert.equal(
    await readFile(join(directory, "model-providers.json"), "utf8"),
    before,
  );
});

test("catalogs retain valid context metadata without inventing a capacity for null or invalid limits", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      success: true,
      data: [
        { slug: "known", contextWindow: 1_000_000 },
        { slug: "unknown", contextWindow: null },
        { slug: "missing" },
        { slug: "string", contextWindow: "1000000" },
        { slug: "negative", contextWindow: -1 },
        { slug: "fraction", contextWindow: 1024.5 },
        { slug: "huge", contextWindow: 100_000_001 },
      ],
    }),
  );
  const catalog = await discoverModels(
    "https://gateway.invalid/api",
    "paperbypass",
    {},
  );
  assert.equal(
    catalog.models.find((model) => model.id === "known")?.contextWindow,
    1_000_000,
  );
  assert.ok(
    catalog.models
      .filter((model) => model.id !== "known")
      .every((model) => model.contextWindow === undefined),
  );
});

test("unrecognized nonempty catalogs and provider failures never masquerade as an empty catalog", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ data: [{ model_id: "unrecognized" }] }),
  );
  await assert.rejects(
    discoverModels("https://gateway.invalid/v1", "openai", {}),
    /无法识别/,
  );
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ success: false, data: [], error: "echo secret-key" }),
  );
  await assert.rejects(
    discoverModels("https://gateway.invalid/api", "paperbypass", {}),
    (error: Error) => {
      assert.match(error.message, /未能返回/);
      assert.ok(!error.message.includes("secret-key"));
      return true;
    },
  );
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [] }));
  assert.deepEqual(
    await discoverModels("https://gateway.invalid/v1", "openai", {}),
    { models: [], truncated: false },
  );
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      models: [
        {
          name: "models/embedding",
          supportedGenerationMethods: ["embedContent"],
        },
      ],
    }),
  );
  assert.deepEqual(
    await discoverModels("https://google.invalid/v1beta", "google", {}),
    { models: [], truncated: false },
  );
});

test("saved credentials are reused only at the saved URL and explicit replacement keys remain unsaved", async (t) => {
  const { settings, directory } = await setup(t);
  await settings.save("openai", {
    baseUrl: "https://saved.invalid/v1",
    apiKey: "saved-secret",
    model: "custom",
  });
  const before = await readFile(
    join(directory, "model-providers.json"),
    "utf8",
  );
  const calls: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: URL, options: RequestInit) => {
      calls.push(new Headers(options.headers).get("authorization")!);
      return Response.json({ data: [] });
    },
  );
  await settings.discover("openai", { baseUrl: "https://saved.invalid/v1/" });
  await assert.rejects(
    settings.discover("openai", { baseUrl: "https://different.invalid/v1" }),
    /API URL 已改变/,
  );
  await settings.discover("openai", {
    baseUrl: "https://different.invalid/v1",
    apiKey: "new-secret",
  });
  assert.deepEqual(calls, ["Bearer saved-secret", "Bearer new-secret"]);
  assert.equal(
    await readFile(join(directory, "model-providers.json"), "utf8"),
    before,
  );
});

test("catalogs paginate without following remote URLs and Gemini excludes non-generation models", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    calls++;
    if (calls === 1)
      return Response.json({
        models: [
          {
            name: "models/gemini-test",
            displayName: "Gemini Test",
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/embedding",
            supportedGenerationMethods: ["embedContent"],
          },
          { name: 12 },
        ],
        nextPageToken: "https://untrusted.invalid/path",
      });
    assert.equal(url.origin, "https://google.invalid");
    assert.equal(
      url.searchParams.get("pageToken"),
      "https://untrusted.invalid/path",
    );
    return Response.json({ models: [{ name: "models/gemini-more" }] });
  });
  const result = await discoverModels(
    "https://google.invalid/v1beta",
    "google",
    {},
  );
  assert.equal(calls, 2);
  assert.deepEqual(
    result.models.map((m) => m.id),
    ["gemini-more", "gemini-test"],
  );
});

test("Anthropic pagination rejects repeated or missing cursors", async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    urls.push(String(url));
    return Response.json({
      data: [{ id: "claude-test", display_name: "Claude Test" }],
      has_more: true,
      last_id: "claude-test",
    });
  });
  await assert.rejects(
    discoverModels("https://claude.invalid", "anthropic", {}),
    /分页/,
  );
  assert.equal(urls.length, 2);
  assert.equal(
    urls[1],
    "https://claude.invalid/v1/models?after_id=claude-test",
  );
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ data: [], has_more: true }),
  );
  await assert.rejects(
    discoverModels("https://claude.invalid", "anthropic", {}),
    /分页/,
  );
});

test("provider errors, malformed data and fetch diagnostics never echo credentials", async (t) => {
  for (const status of [401, 403, 404, 405, 429, 500]) {
    t.mock.method(
      globalThis,
      "fetch",
      async () => new Response("echo secret-key", { status }),
    );
    await assert.rejects(
      discoverModels("https://gateway.invalid/v1", "openai", {}),
      (error: Error) => {
        assert.doesNotMatch(error.message, /secret-key/);
        assert.match(error.message, /认证|接口|频繁|失败/);
        return true;
      },
    );
  }
  for (const response of [
    new Response("secret-key invalid JSON"),
    Response.json({ error: "secret-key" }),
    new Response("x".repeat(2 * 1024 * 1024 + 1)),
  ]) {
    t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(
      discoverModels("https://gateway.invalid/v1", "openai", {}),
      (error: Error) => {
        assert.doesNotMatch(error.message, /secret-key/);
        return true;
      },
    );
  }
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("secret-key network failure");
  });
  await assert.rejects(
    discoverModels("https://gateway.invalid/v1", "openai", {}),
    /无法获取模型列表/,
  );
  await assert.rejects(
    discoverModels(
      "https://gateway.invalid/v1",
      "openai",
      {},
      AbortSignal.abort(),
    ),
    /已取消/,
  );
});

test("discovery API accepts an unsaved draft, rejects cross-site requests and malformed JSON without leaking keys", async (t) => {
  const { directory } = await setup(t);
  const store = new Store(directory);
  await store.init(false);
  const runtime = new PiRuntime();
  await runtime.initProviderSettings(directory);
  const scheduler = new Scheduler(store, runtime);
  t.after(() => scheduler.shutdown());
  const api = createApi(store, runtime, scheduler);
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches++;
    return Response.json({ data: [{ id: "remote-model" }] });
  });
  async function call(body: string, headers = {}) {
    const request = Readable.from([Buffer.from(body)]) as IncomingMessage;
    Object.assign(request, {
      method: "POST",
      url: "/api/model-providers/openai/models",
      headers: {
        host: "127.0.0.1:9999",
        "content-type": "application/json",
        ...headers,
      },
    });
    let status = 0;
    let output = "";
    const response = {
      setHeader() {},
      writeHead(value: number) {
        status = value;
      },
      end(value: string) {
        output = value;
      },
    } as unknown as ServerResponse;
    await api(request, response);
    return { status, output };
  }
  const input = JSON.stringify({
    baseUrl: "https://draft.invalid/v1",
    apiKey: "draft-api-secret",
  });
  const result = await call(input);
  assert.equal(result.status, 200);
  assert.match(result.output, /remote-model/);
  assert.doesNotMatch(result.output, /draft-api-secret/);
  assert.equal(
    (await call(input, { origin: "https://foreign.invalid" })).status,
    403,
  );
  const malformed = await call('{"apiKey":"draft-api-secret", bad');
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(malformed.output, /draft-api-secret/);
  assert.equal(fetches, 1);
  assert.equal(
    runtime.models().some((m) => m.id === "openai/remote-model"),
    false,
  );
});
