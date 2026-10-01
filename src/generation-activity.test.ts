import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCall, TurnNode } from "../shared/types.ts";
import { getGenerationActivity } from "./generation-activity.ts";

function node(overrides: Partial<TurnNode> = {}): TurnNode {
  return {
    id: "answer-node",
    parentId: "root",
    prompt: "Investigate this project",
    response: "",
    status: "running",
    config: { model: "demo/pi-demo", thinking: "medium" },
    color: "sage",
    position: { x: 0, y: 0 },
    contextIds: ["root"],
    createdAt: 10,
    startedAt: 20,
    ...overrides,
  };
}

function tool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: "call-1",
    name: "web_search",
    arguments: { query: "project" },
    status: "running",
    startedAt: 100,
    ...overrides,
  };
}

test("the initial answer stays stable across preparation, thinking and streamed tokens", () => {
  const current = node();
  const initial = getGenerationActivity(current);
  assert.equal(initial.phase, "answer");
  for (const timestamp of [25, 30, 30]) {
    current.lastRequestUsage = {
      timestamp,
      inputTokens: 100,
      outputTokens: timestamp,
    };
    current.response += "another token";
    current.contextState = { status: "full", updatedAt: 25, inputTokens: 100 };
    assert.deepEqual(getGenerationActivity(current), initial);
  }
});

test("each tool invocation changes the activity, but output and wait updates do not", () => {
  const current = node();
  const initialKey = getGenerationActivity(current).key;
  const call = tool();
  current.toolCalls = [call];
  const execution = getGenerationActivity(current);
  assert.equal(execution.phase, "tool");
  assert.equal(execution.toolName, "web_search");
  assert.notEqual(execution.key, initialKey);
  call.output = "partial result";
  call.waitingFor = "workspace lock";
  call.arguments = { query: "project", offset: 1 };
  assert.deepEqual(getGenerationActivity(current), execution);

  call.status = "completed";
  current.toolCalls.push(tool({ id: "call-2", startedAt: 200 }));
  assert.notEqual(getGenerationActivity(current).key, execution.key);
});

test("safety review, approval and execution are distinct events for the same call", () => {
  const call = tool({
    status: "reviewing",
    safetyReview: {
      model: "safety/model",
      decision: "reviewing",
      reason: "",
      startedAt: 105,
    },
  });
  const current = node({ toolCalls: [call] });
  const review = getGenerationActivity(current);
  assert.equal(review.phase, "safety");
  call.safetyReview!.reason = "Reviewing the tool arguments";
  assert.deepEqual(getGenerationActivity(current), review);

  call.safetyReview!.startedAt = 110;
  const secondReview = getGenerationActivity(current);
  assert.notEqual(secondReview.key, review.key);
  call.safetyReview!.decision = "deny";
  call.status = "awaiting_approval";
  const approval = getGenerationActivity(current);
  assert.equal(approval.phase, "approval");
  assert.notEqual(approval.key, secondReview.key);
  call.approval = "approved";
  call.status = "running";
  const execution = getGenerationActivity(current);
  assert.equal(execution.phase, "tool");
  assert.notEqual(execution.key, approval.key);
});

test("a completed tool keeps its word until the next answer request begins", () => {
  const call = tool();
  const current = node({
    toolCalls: [call],
    lastRequestUsage: { timestamp: 30, inputTokens: 100, outputTokens: 10 },
  });
  const execution = getGenerationActivity(current);
  call.status = "completed";
  call.finishedAt = 150;
  assert.equal(getGenerationActivity(current).key, execution.key);
  assert.equal(getGenerationActivity(current).phase, "answer");

  current.lastRequestUsage = {
    timestamp: 160,
    inputTokens: 200,
    outputTokens: 0,
  };
  const nextAnswer = getGenerationActivity(current);
  assert.equal(nextAnswer.phase, "answer");
  assert.notEqual(nextAnswer.key, execution.key);
  // The native provider can replace the preparation timestamp on message_start.
  current.lastRequestUsage = {
    timestamp: 170,
    inputTokens: 200,
    outputTokens: 2,
  };
  current.response += "The result is";
  assert.deepEqual(getGenerationActivity(current), nextAnswer);
  current.lastRequestUsage.outputTokens = 50;
  current.lastRequestUsage.estimated = false;
  assert.deepEqual(getGenerationActivity(current), nextAnswer);
});

test("finished timestamps that equal the previous response do not start a new answer", () => {
  const current = node({
    toolCalls: [tool({ status: "completed", finishedAt: 100 })],
    lastRequestUsage: { timestamp: 100, inputTokens: 100, outputTokens: 10 },
  });
  const waiting = getGenerationActivity(current);
  current.lastRequestUsage!.timestamp = 101;
  assert.notEqual(getGenerationActivity(current).key, waiting.key);
});

test("denial preserves the approval word, and missing legacy usage stays stable", () => {
  const call = tool({ status: "awaiting_approval" });
  const current = node({ toolCalls: [call] });
  const approvalKey = getGenerationActivity(current).key;
  call.status = "denied";
  call.approval = "denied";
  call.finishedAt = 150;
  assert.equal(getGenerationActivity(current).key, approvalKey);
  current.response = "The tool was denied";
  assert.equal(getGenerationActivity(current).key, approvalKey);
});

test("each run, regeneration and later answer has its own event identity", () => {
  const first = node();
  const keys = [
    getGenerationActivity(first).key,
    getGenerationActivity(node({ id: "other-node" })).key,
    getGenerationActivity(node({ revision: 1 })).key,
    getGenerationActivity(node({ requestId: "retry-request" })).key,
    getGenerationActivity(node({ startedAt: 300 })).key,
  ];
  for (const id of ["call-1", "call-2"]) {
    keys.push(
      getGenerationActivity(
        node({
          toolCalls: [tool({ id, status: "completed", finishedAt: 150 })],
          lastRequestUsage: {
            timestamp: 200,
            inputTokens: 100,
            outputTokens: 20,
          },
        }),
      ).key,
    );
  }
  assert.equal(new Set(keys).size, keys.length);
});

test("queued and terminal nodes ignore stale tool execution data", () => {
  const current = node({ status: "queued", toolCalls: [tool()] });
  assert.equal(getGenerationActivity(current).phase, "queued");
  for (const status of ["completed", "failed", "cancelled", "root"] as const) {
    current.status = status;
    assert.equal(getGenerationActivity(current).phase, "idle");
  }
});

test("CUA and delegation words follow the executing tool, not merely an enabled capability", () => {
  assert.equal(
    getGenerationActivity(
      node({
        toolRequests: ["computer_use", "subagents"],
        subagentsEnabled: true,
      }),
    ).phraseGroup,
    "thinking",
  );
  for (const name of [
    "computer_use_tools",
    "computer_use_call",
    "computer_use_release",
  ]) {
    const call = tool({ name });
    const current = node({ toolCalls: [call] });
    assert.equal(getGenerationActivity(current).phraseGroup, "computer-use");
    call.status = "awaiting_approval";
    assert.equal(getGenerationActivity(current).phraseGroup, "thinking");
    call.status = "reviewing";
    assert.equal(getGenerationActivity(current).phraseGroup, "thinking");
  }
  for (const name of [
    "subagent",
    "subagents_enable",
    "subagent_detach",
    "bg_wait",
  ])
    assert.equal(
      getGenerationActivity(node({ toolCalls: [tool({ name })] })).phraseGroup,
      "delegation",
    );
  assert.equal(
    getGenerationActivity(node({ toolCalls: [tool({ name: "read" })] }))
      .phraseGroup,
    "thinking",
  );
});

test("a completed CUA tool retains its word group until a new answer begins", () => {
  const call = tool({ name: "computer_use_call" });
  const current = node({
    toolCalls: [call],
    lastRequestUsage: { timestamp: 30, inputTokens: 100, outputTokens: 10 },
  });
  const execution = getGenerationActivity(current);
  call.status = "completed";
  call.finishedAt = 150;
  const preparing = getGenerationActivity(current);
  assert.equal(preparing.key, execution.key);
  assert.equal(preparing.phraseGroup, "computer-use");
  current.lastRequestUsage!.timestamp = 160;
  const answering = getGenerationActivity(current);
  assert.notEqual(answering.key, execution.key);
  assert.equal(answering.phraseGroup, "thinking");
});

test("parent and child loaders isolate tool ownership, including resumed child executions", () => {
  const delegate = tool({ name: "subagent" });
  const childCall = tool({
    id: "child-cua",
    name: "computer_use_call",
    subagentId: "child",
    startedAt: 200,
  });
  const current = node({ toolCalls: [delegate, childCall] });
  const parentActivity = getGenerationActivity(current);
  assert.equal(parentActivity.phraseGroup, "delegation");
  assert.equal(parentActivity.toolName, "subagent");
  assert.equal(
    getGenerationActivity(current, "child").phraseGroup,
    "computer-use",
  );
  childCall.status = "awaiting_approval";
  assert.deepEqual(getGenerationActivity(current), parentActivity);
  assert.equal(getGenerationActivity(current, "child").phraseGroup, "subagent");
  assert.equal(getGenerationActivity(current, "resumed-child").phase, "answer");
  assert.equal(
    getGenerationActivity(current, "resumed-child").phraseGroup,
    "subagent",
  );
  assert.equal(
    getGenerationActivity(node({ toolCalls: [childCall] })).phraseGroup,
    "thinking",
  );
  current.toolCalls!.push(
    tool({ id: "child-read", name: "read", subagentId: "resumed-child" }),
  );
  assert.equal(getGenerationActivity(current, "resumed-child").phase, "tool");
  assert.equal(
    getGenerationActivity(current, "resumed-child").phraseGroup,
    "subagent",
  );
});
