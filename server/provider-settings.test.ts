import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { createApi } from "./api.ts";
import { ModelProviderSettings, modelProviders } from "./provider-settings.ts";
import { PiRuntime, safeError } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "panel-provider-settings-"));
  const envNames = [...new Set(modelProviders.flatMap((item) => item.keys))];
  const before = envNames.map((name) => [name, process.env[name]] as const);
  for (const name of envNames) delete process.env[name];
  t.after(async () => {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(directory, { force: true, recursive: true });
  });
  const settings = new ModelProviderSettings(directory);
  await settings.init();
  return { directory, settings };
}

test("provider settings preserve catalogs and capabilities, retain custom IDs, and persist private credentials", async (t) => {
  const { directory, settings } = await setup(t);
  const baseline = settings.currentRegistry().getModels();
  assert.equal(settings.list().length, 6);
  assert.ok(settings.list().every((provider) => !provider.apiKeyConfigured));
  for (const definition of modelProviders) {
    const key = `local-secret-${definition.id}`;
    const baseUrl = `https://${definition.id}.invalid/custom/v1`;
    await settings.save(definition.id, {
      baseUrl,
      model: "custom-first",
      apiKey: key,
    });
    const firstRegistry = settings.currentRegistry();
    const settingsJSON = JSON.stringify(settings.list());
    assert.equal(settingsJSON.includes(key), false);
    assert.equal(
      settings.list().find((item) => item.id === definition.id)?.model,
      "custom-first",
    );
    for (const original of baseline.filter(
      (model) => model.provider === definition.id,
    )) {
      assert.deepEqual(firstRegistry.getModel(definition.id, original.id), {
        ...original,
        baseUrl,
      });
    }
    const auth = await firstRegistry.getAuth(definition.id);
    if (definition.id === "paperbypass")
      assert.equal(auth?.auth.headers?.Authorization, `Bearer ${key}`);
    else assert.equal(auth?.auth.apiKey, key);
    await settings.save(definition.id, {
      baseUrl,
      model: "custom-second",
      apiKey: "",
    });
    assert.ok(
      settings.currentRegistry().getModel(definition.id, "custom-first"),
    );
    assert.ok(
      settings.currentRegistry().getModel(definition.id, "custom-second"),
    );
    await settings.save(definition.id, {
      baseUrl,
      model: "custom-second",
      apiKey: `${key}-new`,
    });
    const previousAuth = await firstRegistry.getAuth(definition.id);
    assert.deepEqual(
      previousAuth?.auth,
      auth?.auth,
      "a running request retains old credentials",
    );
    assert.equal(
      safeError(new Error(`failed ${key}-new or ${key}`)),
      "failed [redacted] or [redacted]",
    );
  }
  const path = join(directory, "model-providers.json");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const reloaded = new ModelProviderSettings(directory);
  await reloaded.init();
  assert.deepEqual(reloaded.list(), settings.list());
  for (const definition of modelProviders) {
    assert.ok(
      reloaded.currentRegistry().getModel(definition.id, "custom-first"),
    );
    assert.equal(reloaded.configured(definition.id), true);
  }
});

test("environment keys remain fallback without copying them into settings and local keys take precedence", async (t) => {
  const { directory, settings } = await setup(t);
  process.env.ANTHROPIC_AUTH_TOKEN = "environment-auth-token";
  await settings.save("anthropic", {
    baseUrl: "https://proxy.invalid",
    model: "custom-one",
  });
  assert.equal(settings.configured("anthropic"), true);
  assert.equal(
    (await settings.currentRegistry().getAuth("anthropic"))?.auth.headers
      ?.Authorization,
    "Bearer environment-auth-token",
  );
  assert.equal(
    (await readFile(join(directory, "model-providers.json"), "utf8")).includes(
      "environment-auth-token",
    ),
    false,
  );
  await settings.save("anthropic", {
    baseUrl: "https://proxy.invalid",
    model: "custom-one",
    apiKey: "local-api-key",
  });
  assert.equal(
    (await settings.currentRegistry().getAuth("anthropic"))?.auth.apiKey,
    "local-api-key",
  );
  assert.equal(
    (await settings.currentRegistry().getAuth("anthropic"))?.auth.headers
      ?.Authorization,
    undefined,
  );
});

test("settings validate inputs without changing state and redact corrupt persisted content", async (t) => {
  const { directory, settings } = await setup(t);
  const initial = settings.list();
  const valid = {
    baseUrl: "https://example.invalid/v1",
    model: "model",
    apiKey: "dummy-key",
  };
  for (const input of [
    { ...valid, baseUrl: "file:///tmp/config" },
    { ...valid, baseUrl: "https://user:secret@example.invalid" },
    { ...valid, baseUrl: "https://example.invalid?key=secret" },
    { ...valid, baseUrl: "https://example.invalid#fragment" },
    { ...valid, baseUrl: "https://example.invalid\n" },
    { ...valid, model: "model\nInjected" },
    { ...valid, model: "has space" },
    { ...valid, model: "m".repeat(241) },
    { ...valid, apiKey: "secret\nextra" },
    { ...valid, apiKey: "k".repeat(8193) },
    { ...valid, apiKey: "" },
    { ...valid, protocol: ["auto"] },
    { ...valid, protocol: "invalid" },
  ])
    await assert.rejects(settings.save("openai", input));
  await assert.rejects(settings.save("unknown", valid));
  await assert.rejects(
    settings.save("anthropic", { ...valid, protocol: "openai-completions" }),
  );
  assert.deepEqual(settings.list(), initial);
  await writeFile(
    join(directory, "model-providers.json"),
    '{"apiKey":"unregistered-secret", invalid',
  );
  await assert.rejects(
    new ModelProviderSettings(directory).init(),
    (error: unknown) => {
      assert.equal(String(error).includes("unregistered-secret"), false);
      return true;
    },
  );
});

test("concurrent provider updates persist both providers and a failed save leaves the active registry unchanged", async (t) => {
  const { directory, settings } = await setup(t);
  await Promise.all([
    settings.save("openai", {
      baseUrl: "https://one.invalid/v1",
      model: "one",
      apiKey: "key-one",
    }),
    settings.save("google", {
      baseUrl: "https://two.invalid/v1beta",
      model: "two",
      apiKey: "key-two",
    }),
  ]);
  const reload = new ModelProviderSettings(directory);
  await reload.init();
  assert.equal(reload.configured("openai"), true);
  assert.equal(reload.configured("google"), true);
  const previous = settings.currentRegistry();
  await rm(directory, { recursive: true });
  await writeFile(directory, "block directory writes");
  await assert.rejects(
    settings.save("openai", {
      baseUrl: "https://changed.invalid",
      model: "changed",
      apiKey: "changed-key",
    }),
    /无法保存/,
  );
  assert.equal(settings.currentRegistry(), previous);
});

function completionResponse(model: string, text = "Saved connection works") {
  return new Response(
    [
      {
        id: "mock-completion",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: text },
            finish_reason: null,
          },
        ],
      },
      {
        id: "mock-completion",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

test("custom OpenAI model actually streams through the saved URL and key immediately and after restart", async (t) => {
  const { directory } = await setup(t);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const calls: { url: string; key: string | null; model: string }[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = (await request.json()) as { model: string };
    calls.push({
      url: request.url,
      key: request.headers.get("authorization"),
      model: body.model,
    });
    return completionResponse(body.model);
  };
  const runtime = new PiRuntime();
  await runtime.initProviderSettings(directory);
  const initialModels = runtime.models();
  await runtime.saveProviderSettings("openai", {
    baseUrl: "https://local-mock.invalid/v1/",
    model: "my-custom-model",
    apiKey: "local-test-api-key",
  });
  const option = runtime
    .models()
    .find((model) => model.id === "openai/my-custom-model");
  assert.ok(option?.available);
  assert.equal(option.supportsImages, false);
  assert.deepEqual(option.thinkingLevels, ["off"]);
  assert.equal(runtime.models().length, initialModels.length + 1);
  const result = await runtime.run(
    { model: option.id, thinking: "off" },
    [],
    "hello",
    AbortSignal.timeout(10000),
    () => {},
  );
  assert.equal(result.response, "Saved connection works");
  const reloaded = new PiRuntime();
  await reloaded.initProviderSettings(directory);
  await reloaded.run(
    { model: option.id, thinking: "off" },
    [],
    "hello again",
    AbortSignal.timeout(10000),
    () => {},
  );
  assert.deepEqual(
    calls,
    Array.from({ length: 2 }, () => ({
      url: "https://local-mock.invalid/v1/chat/completions",
      key: "Bearer local-test-api-key",
      model: "my-custom-model",
    })),
  );
});

test("model settings API masks secrets, enforces same origin, and excludes credentials from state and exports", async (t) => {
  const { directory } = await setup(t);
  const store = new Store(directory);
  await store.init();
  const runtime = new PiRuntime();
  await runtime.initProviderSettings(directory);
  const scheduler = new Scheduler(store, runtime);
  t.after(() => scheduler.shutdown());
  const api = createApi(store, runtime, scheduler);
  async function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const request = Readable.from(
      body === undefined
        ? []
        : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))],
    ) as IncomingMessage;
    Object.assign(request, {
      method,
      url: `/api${path}`,
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
    return { status, output, body: JSON.parse(output) };
  }
  const body = {
    baseUrl: "https://api-mock.invalid/v1",
    model: "custom/api-model",
    apiKey: "secret-api-route-key",
  };
  const invalidJSON = await call(
    "PUT",
    "/model-providers/openai",
    '{"apiKey":"unsaved-malformed-key", "baseUrl": invalid}',
  );
  assert.equal(invalidJSON.status, 400);
  assert.equal(invalidJSON.output.includes("unsaved-malformed-key"), false);
  assert.equal(
    (
      await call("PUT", "/model-providers/openai", body, {
        origin: "https://foreign.invalid",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("PUT", "/model-providers/openai", body, {
        "sec-fetch-site": "cross-site",
      })
    ).status,
    403,
  );
  assert.equal(
    runtime.providerSettings().find((provider) => provider.id === "openai")
      ?.apiKeyConfigured,
    false,
  );
  const saved = await call("PUT", "/model-providers/openai", body);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.provider.apiKeyConfigured, true);
  assert.equal(saved.body.provider.apiKey, undefined);
  assert.equal(
    saved.body.models.find(
      (model: { id: string }) => model.id === "openai/custom/api-model",
    ).available,
    true,
  );
  for (const result of [
    saved,
    await call("GET", "/model-providers"),
    await call("GET", "/models"),
    await call("GET", "/state"),
    await call("GET", `/workspaces/${store.data.workspaces[0].id}/export`),
  ]) {
    assert.equal(result.status, 200);
    assert.equal(result.output.includes(body.apiKey), false);
  }
  assert.equal(
    (await call("PUT", "/model-providers/openai", { ...body, apiKey: "" }))
      .status,
    200,
  );
});

test("explicit Chat Completions routes a built-in OpenAI ID to compatible gateways and persists protocol", async (t) => {
  const { directory } = await setup(t);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const runtime = new PiRuntime();
  await runtime.initProviderSettings(directory);
  const builtin = runtime
    .models()
    .find((model) => model.provider === "openai")!;
  const model = builtin.id.slice("openai/".length);
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(
      request.url,
      "https://compatible-gateway.invalid/v1/chat/completions",
    );
    assert.equal(
      request.headers.get("authorization"),
      "Bearer gateway-test-key",
    );
    assert.equal(((await request.json()) as { model: string }).model, model);
    calls++;
    return completionResponse(model);
  };
  await runtime.saveProviderSettings("openai", {
    baseUrl: "https://compatible-gateway.invalid/v1",
    model,
    apiKey: "gateway-test-key",
    protocol: "openai-completions",
  });
  assert.equal(
    runtime.models().find((option) => option.id === builtin.id)?.contextWindow,
    builtin.contextWindow,
  );
  await runtime.run(
    { model: builtin.id, thinking: "off" },
    [],
    "hello",
    AbortSignal.timeout(10000),
    () => {},
  );
  const reloaded = new PiRuntime();
  await reloaded.initProviderSettings(directory);
  assert.equal(
    reloaded.providerSettings().find((provider) => provider.id === "openai")
      ?.protocol,
    "openai-completions",
  );
  await reloaded.run(
    { model: builtin.id, thinking: "off" },
    [],
    "hello",
    AbortSignal.timeout(10000),
    () => {},
  );
  assert.equal(calls, 2);
});
