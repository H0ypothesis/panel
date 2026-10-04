import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelProviderSettings } from "./provider-settings.ts";
import {
  effortLevels,
  type ModelThinkingSettings,
} from "../shared/provider-settings.ts";

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "panel-thinking-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const settings = new ModelProviderSettings(directory);
  await settings.init();
  return { settings, directory };
}
const base = {
  baseUrl: "https://gateway.invalid/v1",
  apiKey: "local-mock-key",
  model: "custom-a",
};
const profile: ModelThinkingSettings = {
  format: "reasoning-effort",
  levels: [...effortLevels],
};

test("thinking settings persist per model and URL; clearing restores defaults and registry snapshots stay stable", async (t) => {
  const { settings, directory } = await setup(t);
  await settings.save("paperbypass", { ...base, thinking: profile });
  const before = settings.currentRegistry();
  assert.deepEqual(
    getSupportedThinkingLevels(before.getModel("paperbypass", base.model)!),
    effortLevels,
  );
  await settings.save("paperbypass", {
    ...base,
    model: "custom-b",
    thinking: { format: "anthropic-effort", levels: ["high", "low", "high"] },
  });
  await settings.save("paperbypass", base);
  let models = settings.list().find((p) => p.id === "paperbypass")!.models;
  assert.deepEqual(models.find((m) => m.id === base.model)?.thinking, profile);
  assert.deepEqual(models.find((m) => m.id === "custom-b")?.thinkingLevels, [
    "low",
    "high",
  ]);
  const loaded = new ModelProviderSettings(directory);
  await loaded.init();
  assert.deepEqual(loaded.list(), settings.list());
  await settings.save("paperbypass", { ...base, thinking: null });
  assert.deepEqual(
    getSupportedThinkingLevels(
      settings.currentRegistry().getModel("paperbypass", base.model)!,
    ),
    ["off"],
  );
  assert.deepEqual(
    getSupportedThinkingLevels(before.getModel("paperbypass", base.model)!),
    effortLevels,
  );
  await settings.save("paperbypass", {
    ...base,
    baseUrl: "https://other.invalid/v1",
  });
  models = settings.list().find((p) => p.id === "paperbypass")!.models;
  assert.equal(
    models.some((m) => m.thinking),
    false,
  );
  assert.deepEqual(
    models.find((m) => m.id === "anthropic/claude-opus-5.5")?.thinkingLevels,
    ["low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(
    models.find((m) => m.id === "z-ai/glm-5.3-flash")?.thinkingLevels,
    ["low", "high", "max"],
  );
});

test("invalid thinking settings fail atomically without changing existing capabilities", async (t) => {
  const { settings } = await setup(t);
  await settings.save("openai", { ...base, thinking: profile });
  const registry = settings.currentRegistry();
  for (const thinking of [
    false,
    [],
    {},
    { ...profile, levels: [] },
    { ...profile, levels: ["off"] },
    { ...profile, levels: ["ultra"] },
    { ...profile, format: "anthropic-effort" },
  ]) {
    await assert.rejects(settings.save("openai", { ...base, thinking }));
    assert.equal(settings.currentRegistry(), registry);
  }
  await assert.rejects(settings.save("google", { ...base, thinking: profile }));
});

for (const variant of [
  {
    provider: "paperbypass",
    model: "custom-a",
    format: "reasoning-effort",
    path: "/v1/messages",
  },
  {
    provider: "paperbypass",
    model: "custom-a",
    format: "anthropic-effort",
    path: "/v1/messages",
  },
  {
    provider: "paperbypass",
    model: "z-ai/glm-5.3-flash",
    format: "anthropic-effort",
    path: "/v1/messages",
  },
  {
    provider: "paperbypass",
    model: "anthropic/claude-opus-5.5",
    format: "reasoning-effort",
    path: "/v1/messages",
  },
  {
    provider: "anthropic",
    model: "claude-opus-5-5",
    format: "anthropic-effort",
    path: "/v1/messages",
  },
  {
    provider: "openai",
    model: "custom-a",
    format: "reasoning-effort",
    protocol: "openai-completions",
    path: "/v1/chat/completions",
  },
  {
    provider: "openai",
    model: "custom-a",
    format: "reasoning-effort",
    protocol: "openai-responses",
    path: "/v1/responses",
  },
] as const) {
  test(`${variant.provider} ${variant.model} ${variant.format} ${variant.path} sends configured efforts without conflicting defaults`, async (t) => {
    const { settings } = await setup(t);
    await settings.save(variant.provider, {
      ...base,
      baseUrl:
        variant.provider === "openai"
          ? base.baseUrl
          : "https://gateway.invalid",
      model: variant.model,
      ...("protocol" in variant ? { protocol: variant.protocol } : {}),
      thinking: { ...profile, format: variant.format },
    });
    const registry = settings.currentRegistry();
    const model = registry.getModel(variant.provider, variant.model)!;
    assert.deepEqual(getSupportedThinkingLevels(model), effortLevels);
    for (const reasoning of effortLevels) {
      let requests = 0;
      let hooks = 0;
      let captured: { path: string; body: Record<string, any> } | undefined;
      const result = await registry.completeSimple(
        model,
        { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
        {
          reasoning,
          maxTokens: 8192,
          maxRetries: 0,
          onPayload: (payload, selected) => {
            hooks++;
            assert.equal(selected.reasoning, true);
            return { ...(payload as object), local_test_marker: true };
          },
          fetch: async (input, init) => {
            requests++;
            const request = new Request(input, init);
            const body = (await request.json()) as Record<string, any>;
            captured = { path: new URL(request.url).pathname, body };
            // Deliberate transport boundary: validate the real adapter's serialized request.
            return new Response(
              JSON.stringify({
                error: {
                  message: "local wire capture",
                  type: "invalid_request_error",
                },
              }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          },
        },
      );
      assert.equal(result.stopReason, "error");
      assert.match(result.errorMessage!, /local wire capture/);
      assert.equal(requests, 1);
      assert.equal(hooks, 1);
      assert.ok(captured);
      assert.equal(captured.path, variant.path);
      const { body } = captured;
      assert.equal(body.thinking, undefined);
      assert.equal(body.local_test_marker, true);
      assert.equal(
        body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens,
        8192,
      );
      if (variant.format === "anthropic-effort") {
        assert.equal(body.output_config?.effort, reasoning);
        assert.equal(body.reasoning_effort, undefined);
      } else if (variant.path.endsWith("responses")) {
        assert.equal(body.reasoning?.effort, reasoning);
        assert.equal(body.reasoning_effort, undefined);
      } else {
        assert.equal(body.reasoning_effort, reasoning);
        assert.equal(body.output_config?.effort, undefined);
      }
    }
  });
}
