import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContextUsageMap,
  contextUsageForNode,
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

test("context estimates count saved references only along the inheriting branch", () => {
  const root = node("root", null, "", "");
  const referenced = node(
    "source",
    "root",
    "new source",
    "changed".repeat(100),
  );
  const branch = node("branch", "root", "", "");
  branch.contextReferences = [
    { nodeId: referenced.id, revision: 0, prompt: "old", response: "snapshot" },
  ];
  const child = node("child", branch.id, "", "");
  const sibling = node("sibling", root.id, "", "");
  const usage = buildContextUsageMap(
    [root, referenced, branch, child, sibling],
    [model(DEFAULT_CONFIG.model, 1000)],
    DEFAULT_CONFIG.model,
  );
  assert.equal(usage.get(branch.id)?.tokens, 14);
  assert.equal(usage.get(child.id)?.tokens, 14);
  assert.equal(usage.get(sibling.id)?.tokens, 0);
  assert.equal(estimatePathContextTokens([root, branch, child]), 14);
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

test("rings count the latest measured input plus output over archive and cumulative billing", () => {
  const root = node("root", null, "x".repeat(200_000), "");
  const a = node("a", "root", "question", "answer");
  a.contextState = {
    status: "full",
    updatedAt: 100,
    inputTokens: 103_159,
    originalTokens: 103_159,
    contextWindow: 256_000,
  };
  a.lastRequestUsage = {
    inputTokens: 105_661,
    outputTokens: 533,
    timestamp: 110,
  };
  a.usage = { input: 9_000_000, output: 50_000, total: 9_050_000 };
  const actual = buildContextUsageMap(
    [root, a],
    [model(DEFAULT_CONFIG.model, 128_000)],
    DEFAULT_CONFIG.model,
  ).get("a")!;
  assert.equal(actual.source, "provider");
  assert.equal(actual.tokens, 106_194);
  assert.equal(actual.inputTokens, 105_661);
  assert.equal(actual.outputTokens, 533);
  assert.equal(
    actual.limit,
    256_000,
    "the run's recorded window is authoritative",
  );
  assert.equal(actual.percentage, (106_194 / 256_000) * 100);
  assert.equal(actual.compressionStatus, "full");
  assert.equal(actual.rawTokens, 240_017);
});

test("a newer pending request estimate supersedes earlier measured usage", () => {
  const a = node("a", "root", "", "");
  a.contextState = {
    status: "compacting",
    updatedAt: 200,
    inputTokens: 220_000,
    originalTokens: 220_000,
    contextWindow: 256_000,
  };
  a.lastRequestUsage = {
    inputTokens: 100_000,
    outputTokens: 20,
    timestamp: 190,
  };
  assert.equal(contextUsageForNode(a, 300_000, 128_000).source, "estimate");
  assert.equal(contextUsageForNode(a, 300_000, 128_000).tokens, 220_000);
  a.contextState = {
    ...a.contextState,
    status: "compacted",
    inputTokens: 50_000,
  };
  const compacted = contextUsageForNode(a, 300_000, 128_000);
  assert.equal(compacted.tokens, 50_000);
  assert.equal(compacted.inputTokens, 50_000);
  assert.equal(compacted.outputTokens, undefined);
  assert.equal(compacted.compressionStatus, "compacted");
  a.lastRequestUsage = {
    inputTokens: 51_000,
    outputTokens: 20,
    timestamp: 200,
  };
  assert.equal(contextUsageForNode(a, 300_000, 128_000).tokens, 51_020);
  assert.equal(contextUsageForNode(a, 300_000, 128_000).source, "provider");
});

test("historical measurements do not imply a known compression state", () => {
  const a = node("a", "root", "", "");
  a.lastRequestUsage = { inputTokens: 123, outputTokens: 9, timestamp: 100 };
  const measured = contextUsageForNode(a, 500, 1_000);
  assert.equal(measured.source, "provider");
  assert.equal(measured.tokens, 132);
  assert.equal(measured.compressionStatus, undefined);
  delete a.lastRequestUsage;
  const archive = contextUsageForNode(a, 500, 1_000);
  assert.equal(archive.source, "archive");
  assert.equal(archive.tokens, 500);
  assert.equal(archive.compressionStatus, undefined);
});

test("sibling usage remains independent and prepared summaries never change run usage", () => {
  const root = node("root", null, "root", "");
  const a = node("a", "root", "question", "answer");
  const b = node("b", "root", "question", "answer");
  a.contextState = {
    status: "compacted",
    updatedAt: 100,
    inputTokens: 10,
    originalTokens: 100,
  };
  a.lastRequestUsage = { inputTokens: 12, outputTokens: 3, timestamp: 100 };
  b.preparedContextState = {
    status: "compacted",
    updatedAt: 200,
    inputTokens: 1,
    originalTokens: 100,
  };
  const usage = buildContextUsageMap(
    [root, a, b],
    [model(DEFAULT_CONFIG.model, 1_000)],
    DEFAULT_CONFIG.model,
  );
  assert.equal(usage.get("a")!.tokens, 15);
  assert.equal(usage.get("a")!.compressionStatus, "compacted");
  assert.equal(usage.get("b")!.source, "archive");
  assert.equal(usage.get("b")!.compressionStatus, undefined);
  assert.equal(usage.get("b")!.tokens, 22);
});

test("each tool round replaces its output without adding prior rounds or response text again", () => {
  const a = node("a", "root", "question", "all previous responses".repeat(100));
  a.contextState = { status: "full", updatedAt: 100, inputTokens: 1_000 };
  a.lastRequestUsage = {
    inputTokens: 1_000,
    outputTokens: 100,
    timestamp: 100,
  };
  a.usage = { input: 1_000, output: 100, total: 1_100 };
  assert.equal(contextUsageForNode(a, 99_000, 128_000).tokens, 1_100);

  a.contextState = { status: "full", updatedAt: 200, inputTokens: 1_500 };
  a.usage = { input: 2_500, output: 300, total: 2_800 };
  assert.equal(contextUsageForNode(a, 99_000, 128_000).tokens, 1_500);
  a.lastRequestUsage = {
    inputTokens: 1_500,
    outputTokens: 200,
    timestamp: 210,
  };
  const next = contextUsageForNode(a, 99_000, 128_000);
  assert.equal(next.tokens, 1_700);
  assert.equal(next.outputTokens, 200);
});

test("streamed generation updates the latest request estimate before provider measurement", () => {
  const a = node("a", "root", "question", "partial");
  a.status = "running";
  a.contextState = { status: "full", updatedAt: 100, inputTokens: 1_000 };
  a.lastRequestUsage = {
    inputTokens: 1_000,
    outputTokens: 40,
    timestamp: 110,
    estimated: true,
  };
  const partial = contextUsageForNode(a, 90_000, 128_000);
  assert.equal(partial.tokens, 1_040);
  assert.equal(partial.source, "estimate");
  assert.equal(partial.inputTokens, 1_000);
  assert.equal(partial.outputTokens, 40);
  a.lastRequestUsage.outputTokens = 70;
  assert.equal(contextUsageForNode(a, 90_000, 128_000).tokens, 1_070);

  a.lastRequestUsage = { inputTokens: 980, outputTokens: 65, timestamp: 120 };
  const measured = contextUsageForNode(a, 90_000, 128_000);
  assert.equal(measured.tokens, 1_045);
  assert.equal(measured.source, "provider");
});

test("invalid or missing historical output cannot produce NaN or claim complete measurement", () => {
  const a = node("a", "root", "question", "answer");
  for (const outputTokens of [-1, NaN, Infinity, undefined]) {
    a.lastRequestUsage = {
      inputTokens: 1_000,
      outputTokens: outputTokens as number,
      timestamp: 100,
    };
    const usage = contextUsageForNode(a, 9_000, 128_000);
    assert.equal(usage.tokens, 1_000);
    assert.equal(usage.source, "estimate");
    assert.equal(usage.outputTokens, undefined);
  }
  a.lastRequestUsage = { inputTokens: 1_000, outputTokens: 0, timestamp: 100 };
  assert.equal(contextUsageForNode(a, 9_000, 128_000).source, "provider");
});

test("invalid input estimates fall back to explicitly labelled archive estimates", () => {
  const a = node("a", "root", "", "");
  a.lastRequestUsage = { inputTokens: NaN, outputTokens: 0, timestamp: 100 };
  a.contextState = { status: "failed", updatedAt: 100, inputTokens: -1 };
  const usage = contextUsageForNode(a, 40, 1_000);
  assert.equal(usage.tokens, 40);
  assert.equal(usage.source, "archive");
  assert.equal(usage.compressionStatus, "failed");
});
