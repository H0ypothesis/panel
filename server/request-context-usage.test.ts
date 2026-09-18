import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  lastRequestUsage,
  requestUsage,
  snapshotRequestUsage,
} from "./request-context-usage.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type StoredNode } from "./store.ts";

function response(input = 61, cacheRead = 105216, cacheWrite = 384) {
  const message = fauxAssistantMessage("The response body stays private.");
  message.provider = "test";
  message.model = "context";
  message.timestamp = 200;
  message.usage = {
    ...message.usage,
    input,
    cacheRead,
    cacheWrite,
    output: 533,
    totalTokens: input + cacheRead + cacheWrite + 533,
  };
  return message;
}

test("request context counts cache tokens and only the final provider request", () => {
  const earlier = response(200000, 0, 0);
  const latest = response();
  const messages = [earlier, latest];
  const before = structuredClone(messages);
  assert.deepEqual(lastRequestUsage(messages, "test/context"), {
    inputTokens: 105661,
    outputTokens: 533,
    timestamp: 200,
  });
  assert.deepEqual(messages, before);
});

test("missing or invalid latest counts never masquerade as a measured current input", () => {
  for (const latest of [
    response(0, 0, 0),
    response(-1),
    response(Number.NaN),
    response(1, Number.POSITIVE_INFINITY),
    { ...response(), provider: "another-provider" },
    { ...response(), timestamp: Number.NaN },
  ]) {
    assert.equal(
      lastRequestUsage([response(), latest], "test/context"),
      undefined,
    );
  }
  assert.equal(lastRequestUsage(undefined, "test/context"), undefined);
  const demo = { ...response(), provider: "demo" };
  assert.equal(lastRequestUsage([demo], "demo/context"), undefined);
});

test("streaming includes this reply's reasoning and tool arguments, then replaces estimates with final usage", () => {
  const message = response();
  message.content = [{ type: "text", text: "Partial reply" }];
  const initial = requestUsage(message, "test/context", 1000, true)!;
  assert.equal(initial.estimated, true);
  message.content.push({ type: "thinking", thinking: "推理内容".repeat(20) });
  message.content.push(
    fauxToolCall("write", { path: "file.txt", content: "x".repeat(1000) }),
  );
  const longer = requestUsage(message, "test/context", 1000, true)!;
  assert.ok(longer.outputTokens > initial.outputTokens);
  assert.equal(longer.inputTokens, 105661);
  assert.equal(longer.estimated, true);
  const final = requestUsage(message, "test/context", 1000)!;
  assert.equal(final.outputTokens, 533);
  assert.equal(final.estimated, undefined);
});

test("missing provider counts retain explicitly estimated output, including demo responses", () => {
  const message = response(0, 0, 0);
  const usage = requestUsage(message, "test/context", 1000)!;
  assert.equal(usage.inputTokens, 1000);
  assert.ok(usage.outputTokens > 0);
  assert.equal(usage.estimated, true);
  const demo = { ...message, provider: "demo" };
  assert.equal(requestUsage(demo, "demo/context", 1000)?.estimated, true);
});

test("new streaming output supersedes old raw usage and final raw counters replace its estimate", () => {
  const node: StoredNode = {
    ...createWorkspace("Root", "Background").nodes[0],
    config: { model: "test/context", thinking: "off" },
    status: "running",
    contextState: { status: "full", updatedAt: 250, inputTokens: 110000 },
    lastRequestUsage: {
      inputTokens: 110000,
      outputTokens: 50,
      timestamp: 300,
      estimated: true,
    },
  };
  assert.equal(snapshotRequestUsage(node, [response()])?.outputTokens, 50);
  const final = { ...response(), timestamp: 300 };
  assert.deepEqual(snapshotRequestUsage(node, [response(), final]), {
    inputTokens: 105661,
    outputTokens: 533,
    timestamp: 300,
  });
  node.lastRequestUsage = {
    inputTokens: 20000,
    outputTokens: 0,
    timestamp: 301,
    estimated: true,
  };
  assert.equal(snapshotRequestUsage(node, [final])?.inputTokens, 20000);
  assert.equal(snapshotRequestUsage(node, [final])?.outputTokens, 0);
});

test("snapshots expose measured usage for existing runs without changing or exposing transcripts", () => {
  const store = new Store(
    join(tmpdir(), "panel-request-context-snapshot-test"),
  );
  const workspace = createWorkspace("Root", "Background");
  const node: StoredNode = {
    ...workspace.nodes[0],
    id: "current",
    parentId: workspace.nodes[0].id,
    config: { model: "test/context", thinking: "off" },
    status: "completed",
    contextState: {
      status: "full",
      updatedAt: 190,
      inputTokens: 103159,
      contextWindow: 256000,
    },
    messages: [response()],
    usage: { input: 863074, output: 28291, total: 891365 },
  };
  store.data.workspaces.push({
    ...workspace,
    nodes: [...workspace.nodes, node],
  });
  const before = structuredClone(store.data);
  const snapshot = store.snapshot().workspaces[0].nodes[1];
  assert.equal(snapshot.lastRequestUsage?.inputTokens, 105661);
  assert.equal(snapshot.usage?.total, 891365);
  assert.equal("messages" in snapshot, false);
  assert.deepEqual(store.data, before);
  node.messages = [];
  assert.equal(
    store.snapshot().workspaces[0].nodes[1].lastRequestUsage,
    undefined,
  );
});
