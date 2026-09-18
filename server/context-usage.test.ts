import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContextUsageMap,
  estimatePathContextTokens,
} from "../shared/context-usage.ts";
import {
  DEFAULT_CONFIG,
  type ModelOption,
  type TurnNode,
} from "../shared/types.ts";

const model = (id: string, contextWindow: number): ModelOption => ({
  id,
  contextWindow,
  name: id,
  provider: "demo",
  providerName: "Demo",
  available: true,
  demo: true,
  thinkingLevels: ["medium"],
});
function node(
  id: string,
  parentId: string | null,
  prompt: string,
  response: string,
): TurnNode {
  return {
    id,
    parentId,
    prompt,
    response,
    status: parentId ? "completed" : "root",
    config: { ...DEFAULT_CONFIG },
    color: "sage",
    position: { x: 0, y: 0 },
    contextIds: [],
    createdAt: 0,
  };
}

test("context rings count only the card's ancestor path, including streamed text", () => {
  const root = node("root", null, "root", "background");
  const a = node("a", "root", "question", "answer");
  const b = node("b", "a", "next", "partial");
  b.status = "running";
  const sibling = node(
    "sibling",
    "root",
    "irrelevant".repeat(100),
    "other branch".repeat(100),
  );
  const models = [model(DEFAULT_CONFIG.model, 1000)];
  const before = buildContextUsageMap(
    [root, a, b, sibling],
    models,
    DEFAULT_CONFIG.model,
  );
  assert.equal(before.get("b")!.tokens, 47); // 39 visible chars * 1.2, rounded up.
  assert.equal(before.get("a")!.tokens, 34);
  b.response += "abcdefghij";
  a.usage = { input: 1_000_000, output: 10000, total: 1_010_000 };
  const after = buildContextUsageMap(
    [b, sibling, a, root],
    models,
    DEFAULT_CONFIG.model,
  );
  assert.equal(after.get("b")!.tokens, 59);
  assert.equal(
    after.get("a")!.tokens,
    before.get("a")!.tokens,
    "billing totals must not count as context",
  );
});

test("visible tool arguments and output count without audit or source duplication", () => {
  const root = node("root", null, "", "");
  const a = node("a", "root", "", "");
  a.toolCalls = [
    {
      id: "tool",
      name: "read",
      arguments: { path: "a" },
      status: "completed",
      output: "hello",
      error: "same failure again",
      sources: [{ title: "source".repeat(100), url: "https://example.com" }],
      safetyReview: {
        model: "judge",
        decision: "approve",
        reason: "audit".repeat(100),
        startedAt: 0,
      },
      startedAt: 0,
    },
  ];
  assert.equal(estimatePathContextTokens([root, a]), 26); // 4 + 12 + 5 characters.
  a.toolCalls[0].output = undefined;
  a.toolCalls[0].error = "error";
  assert.equal(estimatePathContextTokens([root, a]), 26);
});

test("each card uses its own model capacity; root follows composer, unknown remains unknown", () => {
  const root = node("root", null, "x".repeat(100), "");
  const a = node("a", "root", "", "");
  a.contextStale = true;
  const b = node("b", "a", "", "");
  b.config.model = "missing/model";
  const usages = buildContextUsageMap(
    [root, a, b],
    [model(DEFAULT_CONFIG.model, 100), model("composer/model", 1000)],
    "composer/model",
  );
  assert.equal(usages.get("root")!.percentage, 12);
  assert.equal(
    usages.get("a")!.percentage,
    120,
    "over-budget percentage is not clamped",
  );
  assert.equal(usages.get("b")!.limit, null);
  assert.equal(usages.get("b")!.percentage, null);
  assert.equal(usages.get("b")!.stale, true);
  const invalid = buildContextUsageMap([root], [model("bad", 0)], "bad");
  assert.equal(invalid.get("root")!.percentage, null);
});
