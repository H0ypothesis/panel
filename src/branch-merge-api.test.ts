import assert from "node:assert/strict";
import test from "node:test";
import { api } from "./api.ts";

test("merge submission fails closed when an old backend would discard branch inputs", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return Response.json({ cardReferences: true });
  };
  try {
    await assert.rejects(
      api("/workspaces/work/nodes", {
        parentId: "a",
        contextParents: [{ nodeId: "a" }, { nodeId: "b" }],
      }),
      /后端尚未加载多分支融合/,
    );
    assert.deepEqual(calls, ["/api/capabilities"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("merge submission preserves every selected input after capability validation", async () => {
  const originalFetch = globalThis.fetch;
  const parents = Array.from({ length: 30 }, (_, index) => ({
    nodeId: `source-${index}`,
  }));
  let submitted: unknown;
  globalThis.fetch = async (input, options) => {
    if (String(input) === "/api/capabilities")
      return Response.json({ branchMerging: true });
    submitted = JSON.parse(String(options?.body));
    return Response.json({ nodeId: "merged" });
  };
  try {
    await api("/workspaces/work/nodes", {
      parentId: parents[0].nodeId,
      contextParents: parents,
    });
    assert.deepEqual(submitted, {
      parentId: parents[0].nodeId,
      contextParents: parents,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("legacy single-branch requests do not need the merge capability", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return Response.json({ nodeId: "child" });
  };
  try {
    await api("/workspaces/work/nodes", { parentId: "a", prompt: "continue" });
    assert.deepEqual(calls, ["/api/workspaces/work/nodes"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prepared merge submission cannot silently fall back on an older fusion backend", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return Response.json({ branchMerging: true });
  };
  try {
    await assert.rejects(
      api("/workspaces/work/nodes", {
        parentId: "a",
        contextParents: [{ nodeId: "a" }, { nodeId: "b" }, { nodeId: "c" }],
        mergedContextCheckpointId: "whole-merge-summary",
      }),
      /后端尚未加载整体主动压缩/,
    );
    assert.deepEqual(calls, ["/api/capabilities"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("manual merge preparation sends all selected sources and no answer request", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const body = {
    parentId: "a",
    contextParents: [
      { nodeId: "a", contextMode: "raw" },
      { nodeId: "b", contextCheckpointId: "summary-b" },
      { nodeId: "c" },
    ],
    config: { model: "test/model", thinking: "off" },
    requestId: "prepare-only",
  };
  globalThis.fetch = async (input, options) => {
    calls.push(String(input));
    if (String(input) === "/api/capabilities")
      return Response.json({
        branchMerging: true,
        mergeContextPreparation: true,
      });
    assert.deepEqual(JSON.parse(String(options?.body)), body);
    return Response.json({
      checkpoint: { id: "whole-merge-summary" },
      state: {},
    });
  };
  try {
    await api("/workspaces/work/merge-context/compact", body);
    assert.deepEqual(calls, [
      "/api/capabilities",
      "/api/workspaces/work/merge-context/compact",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
