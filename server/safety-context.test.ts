import assert from "node:assert/strict";
import { test } from "node:test";
import type { SafetyReviewRequest } from "../shared/types.ts";
import { buildSafetyReviewContext, reviewSafetyTool } from "./safety-review.ts";
import {
  compactSafetyContext,
  SAFETY_HISTORY_TOKEN_BUDGET,
  safetyContextTokens,
} from "./safety-context.ts";
import { createModels, fauxProvider, type Models } from "@earendil-works/pi-ai";

type PreviousTool = NonNullable<SafetyReviewRequest["recentTools"]>[number];
const request: SafetyReviewRequest = {
  model: "fixture/test",
  workingDirectory: "/tmp/project",
  workspaceTitle: "fixture",
  workspaceDescription: "",
  userRequest: "用户授权：运行 hello.cjs，禁止删除数据。",
  ancestry: [
    {
      prompt: "上游用户要求：保留全部原文件。",
      response: "ASSISTANT_PROSE_SHOULD_NOT_APPEAR".repeat(10000),
    },
  ],
  tool: {
    id: "current",
    name: "bash",
    arguments: { command: "node hello.cjs" },
  },
};
const data = (value: SafetyReviewRequest, capacity = 128000) =>
  JSON.parse(
    buildSafetyReviewContext(value, capacity).messages[0].content as string,
  );
const approved = (
  id: string,
  argumentsValue: Record<string, unknown>,
): PreviousTool => ({
  id,
  nodeId: "card",
  revision: 1,
  workingDirectory: "/tmp/project",
  name: "bash",
  arguments: argumentsValue,
  approval: "approved",
  status: "completed",
  startedAt: Number(id.replace(/\D/g, "")) || 1,
});

test("historical nested payloads, wide arrays and deep objects are bounded without modifying the current action", () => {
  let deep: unknown = "DEEP_BODY".repeat(5000);
  for (let i = 0; i < 20; i++) deep = { next: deep };
  const source = {
    ...request,
    tool: {
      id: "edit-current",
      name: "edit",
      arguments: {
        path: "report.md",
        edits: [
          { oldText: "original", newText: "CURRENT_FULL_PAYLOAD".repeat(1000) },
        ],
      },
    },
    recentTools: [
      {
        ...approved("old", {
          tasks: Array.from({ length: 400 }, () => ({
            task: "HISTORICAL_TASK_BODY".repeat(1000),
          })),
          edits: [
            {
              oldText: "HISTORICAL_OLD_BODY".repeat(1000),
              newText: "HISTORICAL_NEW_BODY".repeat(1000),
            },
          ],
          command: "HISTORICAL_COMMAND_BODY".repeat(1000),
          wide: Array.from({ length: 10000 }, () => "small-value"),
          deep,
        }),
        name: "edit",
      },
    ],
  } satisfies SafetyReviewRequest;
  const original = structuredClone(source);
  const selected = data(source);
  assert.deepEqual(selected.tool, source.tool);
  assert.equal(selected.userRequest, source.userRequest);
  assert.deepEqual(selected.ancestry, [{ prompt: request.ancestry[0].prompt }]);
  assert.doesNotMatch(
    JSON.stringify(selected),
    /ASSISTANT_PROSE_SHOULD_NOT_APPEAR|HISTORICAL_TASK_BODY|HISTORICAL_COMMAND_BODY|HISTORICAL_OLD_BODY|HISTORICAL_NEW_BODY|DEEP_BODY/,
  );
  const args = selected.approvalHistory[0].arguments;
  assert.equal(args.tasks.omitted, true);
  assert.equal(args.tasks.items, 400);
  assert.equal(args.edits[0].newText.omitted, true);
  assert.match(args.edits[0].newText.sha256, /^[a-f0-9]{64}$/);
  assert.equal(args.wide.items, 10000);
  assert.ok(JSON.stringify(selected.approvalHistory).length < 8000);
  assert.deepEqual(source, original);
});

test("repeat decisions merge only within the same action, source, outcome and authorization scope", () => {
  const args = { path: "/tmp/project/report.md", content: "report" };
  const repeated = Array.from({ length: 1000 }, (_, i) => ({
    ...approved(`repeat-${i + 1}`, args),
    name: "write",
  }));
  const variants: PreviousTool[] = [
    { ...repeated[0], id: "automatic", approval: "safety_model" },
    { ...repeated[0], id: "denial", status: "denied", approval: "denied" },
    { ...repeated[0], id: "other-card", nodeId: "other" },
    { ...repeated[0], id: "other-revision", revision: 2 },
    { ...repeated[0], id: "other-directory", workingDirectory: "/tmp/other" },
    { ...repeated[0], id: "other-child", subagentId: "child" },
    { ...repeated[0], id: "ancestor", fromAncestor: true },
    {
      ...repeated[0],
      id: "different-content",
      arguments: { ...args, content: "different" },
    },
  ];
  const source = {
    ...request,
    tool: { id: "current", name: "write", arguments: args },
    recentTools: [...repeated, ...variants],
  };
  const selected = data(source);
  assert.equal(selected.approvalHistory.length, 9);
  assert.equal(selected.contextSelection.deduplicatedApprovals, 999);
  const combined = selected.approvalHistory.find(
    (item: any) => item.occurrences === 1000,
  );
  assert.equal(combined.id, "repeat-1000");
  assert.equal(combined.firstTimestamp, 1);
  assert.equal(combined.timestamp, 1000);
  for (const variant of variants)
    assert.ok(
      selected.approvalHistory.some((item: any) => item.id === variant.id),
    );
  assert.equal(source.recentTools.length, 1008);
  assert.equal(
    selected.approvalHistory.find((item: any) => item.id === "denial")
      .occurrences,
    1,
  );
});

test("thousands of main-agent approvals fit one shared token budget with refusals and matching targets retained", () => {
  const source: SafetyReviewRequest = {
    ...request,
    tool: {
      id: "current",
      name: "write",
      arguments: { path: "report.md", content: "current" },
    },
    recentTools: [
      {
        ...approved("old-denial", { command: "rm -rf data" }),
        subagentId: "sibling",
        status: "denied",
        approval: "denied",
      },
      {
        ...approved("matching-target", { path: "report.md", content: "older" }),
        name: "write",
      },
      ...Array.from({ length: 2000 }, (_, i) =>
        approved(`history-${i}`, {
          command: `printf '${"body".repeat(500)}-${i}'`,
        }),
      ),
    ],
  };
  const selected = data(source);
  assert.ok(
    selected.contextSelection.historyTokens <= SAFETY_HISTORY_TOKEN_BUDGET,
  );
  assert.ok(selected.contextSelection.omittedApprovals > 0);
  assert.equal(selected.contextSelection.omittedDenials, 0);
  assert.equal(selected.recentTools.length, 12);
  for (const id of ["old-denial", "matching-target"])
    assert.ok(
      selected.approvalHistory.some((item: any) => item.id === id),
      id,
    );
  assert.ok(
    selected.recentTools.some((item: any) => item.id === "history-1999"),
  );
  const actualTokens =
    safetyContextTokens(
      JSON.stringify({
        approvalHistory: selected.approvalHistory,
        recentTools: selected.recentTools,
      }),
    ) -
    safetyContextTokens(
      JSON.stringify({ approvalHistory: [], recentTools: [] }),
    );
  assert.equal(selected.contextSelection.historyTokens, actualTokens);
});

test("deduplicated recent tools are selected by their last occurrence", () => {
  const first = approved("old-repeat", { command: "echo repeated" });
  const selected = compactSafetyContext({
    ...request,
    recentTools: [
      first,
      ...Array.from({ length: 20 }, (_, i) =>
        approved(`between-${i}`, { command: `echo ${i}` }),
      ),
      { ...first, id: "new-repeat", startedAt: 21 },
    ],
  });
  assert.equal(selected.recentTools.length, 12);
  assert.equal(selected.recentTools.at(-1)?.id, "new-repeat");
  assert.ok(!selected.recentTools.some((item) => item.id === "old-repeat"));
  assert.equal(
    selected.approvalHistory.find((item) => item.id === "new-repeat")
      ?.occurrences,
    2,
  );
});

test("small reviewer windows shrink history first and keep complete authorization and current parameters", () => {
  const source: SafetyReviewRequest = {
    ...request,
    userRequest: request.userRequest.repeat(10),
    recentTools: Array.from({ length: 100 }, (_, i) =>
      approved(`small-${i}`, { command: `echo '${"x".repeat(1500)}-${i}'` }),
    ),
  };
  const noHistory = buildSafetyReviewContext(
    { ...source, recentTools: [] },
    1000000,
  );
  const capacity =
    safetyContextTokens(
      noHistory.systemPrompt! + noHistory.messages[0].content,
    ) +
    1280 +
    6000;
  const context = buildSafetyReviewContext(source, capacity);
  const selected = JSON.parse(context.messages[0].content as string);
  assert.ok(
    selected.contextSelection.historyTokenBudget < SAFETY_HISTORY_TOKEN_BUDGET,
  );
  assert.ok(
    selected.contextSelection.historyTokens <=
      selected.contextSelection.historyTokenBudget,
  );
  assert.equal(selected.userRequest, source.userRequest);
  assert.deepEqual(selected.tool, source.tool);
  assert.deepEqual(selected.ancestry, [{ prompt: source.ancestry[0].prompt }]);
  assert.ok(
    safetyContextTokens(context.systemPrompt! + context.messages[0].content) +
      1280 <=
      capacity,
  );
});

test("code evidence outranks old approvals and its complete small payload is retained only as evidence", () => {
  const source: SafetyReviewRequest = {
    ...request,
    recentTools: [
      {
        id: "script",
        name: "write",
        arguments: {
          path: "hello.cjs",
          content: "console.log('TOP_PRIORITY_SCRIPT')",
        },
        workingDirectory: "/tmp/project",
        approval: "approved",
        status: "completed",
      },
      ...Array.from({ length: 50 }, (_, i) =>
        approved(`other-${i}`, {
          command: `echo '${"body".repeat(400)}-${i}'`,
        }),
      ),
    ],
  };
  const selected = compactSafetyContext(source, 1500);
  assert.ok(selected.contextSelection.historyTokens <= 1500);
  const serialized = JSON.stringify(selected);
  assert.match(serialized, /TOP_PRIORITY_SCRIPT/);
  assert.equal(selected.contextSelection.omittedReferencedEvidence, 0);
  assert.equal(selected.contextSelection.omittedDenials, 0);
  assert.doesNotMatch(serialized, /ASSISTANT_PROSE_SHOULD_NOT_APPEAR/);
  const fullHistory = compactSafetyContext(source);
  assert.equal(
    JSON.stringify(fullHistory).match(/TOP_PRIORITY_SCRIPT/g)?.length,
    1,
  );
  const scriptDecision = fullHistory.approvalHistory.find(
    (item) => item.id === "script",
  );
  assert.equal((scriptDecision?.arguments as any).content.omitted, true);
});

test("unique refusals that cannot fit never reach the provider for an automatic approval", async () => {
  const registry = createModels();
  const fixture = fauxProvider({
    provider: "fixture",
    models: [{ id: "test", contextWindow: 1000000 }],
  });
  registry.setProvider(fixture.provider);
  let calls = 0;
  const reviewer: Pick<Models, "completeSimple"> = {
    async completeSimple() {
      calls++;
      throw new Error("should not dispatch");
    },
  };
  const source: SafetyReviewRequest = {
    ...request,
    recentTools: Array.from({ length: 1000 }, (_, i) => ({
      ...approved(`refusal-${i}`, { command: `rm -rf data-${i}` }),
      status: "denied",
      approval: "denied",
    })),
  };
  await assert.rejects(
    reviewSafetyTool(
      reviewer,
      fixture.getModel(),
      source,
      new AbortController().signal,
    ),
    /拒绝记录超过.*历史预算/,
  );
  assert.equal(calls, 0);
  assert.ok(compactSafetyContext(source).contextSelection.omittedDenials > 0);
});
