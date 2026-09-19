import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const piPackage = join(root, "pi/packages/ai");
const modelsDevUrl = "https://models.dev/api.json";
const routerUrl = "https://openrouter.ai/api/v1/models";
const gatewayUrl = "https://ai-gateway.vercel.sh/v1/models";
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const [nodeCommand, ...setupArgs] = manifest.scripts["setup:pi"].split(" ");
assert.equal(nodeCommand, "node");

const kimiModel = {
  id: "kimi-for-coding",
  name: "Kimi For Coding",
  tool_call: true,
  reasoning: true,
  reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 1048576, output: 32768 },
  cost: { input: 0.95, output: 4, cache_read: 0.19 },
};

function catalogs() {
  // The pinned generator strictly checks the Individual plan even when only
  // hydrating the two providers under test. Supply its required source models.
  const qwenIds = [
    "deepseek-v4-flash-0731",
    "deepseek-v4-pro",
    "deepseek-v4-pro-0813",
    "glm-5.2",
    "qwen3.6-flash",
    "qwen3.7-max",
    "qwen3.7-plus",
    "qwen3.8-flash",
    "qwen3.8-max",
  ];
  return {
    [modelsDevUrl]: {
      json: {
        "kimi-code-plan-cn": { models: { "kimi-for-coding": kimiModel } },
        "kimi-code-plan-global": {
          models: {
            "global-only": { ...kimiModel, id: "global-only" },
          },
        },
        anthropic: {
          models: {
            "fixture-model": {
              id: "fixture-model",
              name: "Fixture model",
              tool_call: true,
            },
          },
        },
        "alibaba-token-plan": {
          models: Object.fromEntries(
            qwenIds.map((id) => [id, { id, name: id, tool_call: true }]),
          ),
        },
      },
    },
    [routerUrl]: { json: { data: [] } },
    [gatewayUrl]: { json: { data: [] } },
  };
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "panel-setup-pi-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const isolatedPackage = join(directory, "pi/packages/ai");
  const providers = join(isolatedPackage, "src/providers");
  const data = join(providers, "data");
  mkdirSync(providers, { recursive: true });
  cpSync(join(piPackage, "scripts"), join(isolatedPackage, "scripts"), {
    recursive: true,
  });
  for (const relative of [
    "package.json",
    "src/api/cloudflare.ts",
    "src/providers/kimi-coding.models.ts",
    "src/providers/anthropic.models.ts",
  ]) {
    const destination = join(isolatedPackage, relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(piPackage, relative), destination);
  }
  // Read the real generator/shards but hydrate a small isolated catalog from
  // scratch, without relying on ignored JSON data from the developer's machine.
  const aggregator = readFileSync(
    join(piPackage, "src/models.generated.ts"),
    "utf8",
  )
    .split("\n")
    .filter((line) =>
      /^import .*\/providers\/(anthropic|kimi-coding)\.models\.ts/.test(line),
    )
    .join("\n");
  writeFileSync(join(isolatedPackage, "src/models.generated.ts"), aggregator);
  mkdirSync(join(directory, "scripts"));
  copyFileSync(
    join(root, "scripts/pi-models-dev-compat.mjs"),
    join(directory, "scripts/pi-models-dev-compat.mjs"),
  );
  const preload = join(directory, "mock-fetch.mjs");
  writeFileSync(
    preload,
    `import { readFileSync } from "node:fs";
const responses = JSON.parse(readFileSync(new URL("./responses.json", import.meta.url), "utf8"));
globalThis.fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  const response = responses[url];
  if (!response) throw new Error("Unexpected fetch: " + url);
  if (response.error) throw new Error(response.error);
  return new Response(response.body ?? JSON.stringify(response.json), {
    status: response.status ?? 200,
    headers: { "content-type": "application/json" },
  });
};
`,
  );
  return {
    data,
    run(responses = catalogs(), args = setupArgs) {
      writeFileSync(
        join(directory, "responses.json"),
        JSON.stringify(responses),
      );
      const result = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(preload).href, ...args],
        { cwd: directory, encoding: "utf8", timeout: 10_000, env: {} },
      );
      assert.ifError(result.error);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.equal(
        readFileSync(join(isolatedPackage, "src/models.generated.ts"), "utf8"),
        aggregator,
        "setup must not rewrite the provider imports",
      );
      return { status: result.status, output };
    },
    kimi() {
      return JSON.parse(readFileSync(join(data, "kimi-coding.json"), "utf8"))[
        "anthropic-messages"
      ];
    },
    snapshot() {
      return Object.fromEntries(
        readdirSync(data).map((name) => [
          name,
          readFileSync(join(data, name), "utf8"),
        ]),
      );
    },
  };
}

test("unadapted Pi reproduces the missing-provider error after the catalog rename", (t) => {
  const isolated = fixture(t);
  const result = isolated.run(catalogs(), [
    "pi/packages/ai/scripts/generate-models.ts",
    "--strict",
    "--data-only",
  ]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Cannot hydrate missing providers: kimi-coding/);
  assert.equal(existsSync(isolated.data), false);
});

test("setup hydrates from scratch using the CN catalog and preserves model metadata", (t) => {
  const isolated = fixture(t);
  assert.equal(existsSync(isolated.data), false);
  const result = isolated.run();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Mapping models.dev kimi-code-plan-cn/);
  const models = isolated.kimi();
  assert.deepEqual(Object.keys(models), ["kimi-for-coding"]);
  const model = models["kimi-for-coding"];
  assert.equal(model.provider, "kimi-coding");
  assert.equal(model.baseUrl, "https://api.kimi.com/coding");
  assert.equal(model.contextWindow, kimiModel.limit.context);
  assert.equal(model.maxTokens, kimiModel.limit.output);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.equal(model.cost.input, kimiModel.cost.input);
  assert.equal(model.compat.forceAdaptiveThinking, true);
  assert.equal(model.compat.allowEmptySignature, true);
  assert.equal(model.thinkingLevelMap.max, "max");
  assert.ok(existsSync(join(isolated.data, ".manifest.json")));
  const repeat = isolated.run();
  assert.equal(repeat.status, 0, repeat.output);
  assert.deepEqual(isolated.kimi(), models);
});

test("an existing legacy catalog takes precedence over the renamed catalogs", (t) => {
  const responses = catalogs();
  responses[modelsDevUrl].json["kimi-for-coding"] = {
    models: { legacy: { ...kimiModel, id: "legacy" } },
  };
  const isolated = fixture(t);
  const result = isolated.run(responses);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(Object.keys(isolated.kimi()), ["legacy"]);
  assert.doesNotMatch(result.output, /Mapping models.dev/);
});

for (const scenario of [
  "missing CN",
  "empty CN",
  "no tool support",
  "empty legacy",
]) {
  test(`setup still rejects ${scenario} instead of inventing or mixing models`, (t) => {
    const responses = catalogs();
    const source = responses[modelsDevUrl].json;
    if (scenario === "missing CN") delete source["kimi-code-plan-cn"];
    if (scenario === "empty CN") source["kimi-code-plan-cn"].models = {};
    if (scenario === "no tool support") {
      source["kimi-code-plan-cn"].models = {
        "kimi-for-coding": { ...kimiModel, tool_call: false },
      };
    }
    if (scenario === "empty legacy") source["kimi-for-coding"] = { models: {} };
    const isolated = fixture(t);
    const result = isolated.run(responses);
    assert.equal(result.status, 1, result.output);
    assert.match(
      result.output,
      /Cannot hydrate missing providers: kimi-coding/,
    );
    assert.equal(existsSync(isolated.data), false);
  });
}

test("missing unrelated providers fail before replacing previously generated data", (t) => {
  const isolated = fixture(t);
  const initial = isolated.run();
  assert.equal(initial.status, 0, initial.output);
  const before = isolated.snapshot();
  const responses = catalogs();
  delete responses[modelsDevUrl].json.anthropic;
  const result = isolated.run(responses);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /Cannot hydrate missing providers: anthropic/);
  assert.deepEqual(isolated.snapshot(), before);
});

for (const [url, failure, expected] of [
  [
    modelsDevUrl,
    { status: 503, body: "unavailable" },
    /models.dev API returned 503/,
  ],
  [modelsDevUrl, { error: "network unavailable" }, /network unavailable/],
  [modelsDevUrl, { body: "invalid json" }, /SyntaxError/],
  [
    routerUrl,
    { status: 503, body: "unavailable" },
    /OpenRouter API returned 503/,
  ],
  [
    gatewayUrl,
    { status: 503, body: "unavailable" },
    /Vercel AI Gateway API returned 503/,
  ],
]) {
  test(`strict setup rejects ${url}: ${JSON.stringify(failure)}`, (t) => {
    const responses = catalogs();
    responses[url] = failure;
    const isolated = fixture(t);
    const result = isolated.run(responses);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, expected);
    assert.equal(existsSync(isolated.data), false);
  });
}
