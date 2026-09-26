import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { buildContext, contextCheckpoints } from "./context.ts";
import { checkpointMatches, contextSourceHash } from "./compaction.ts";
import type { ContextCheckpoint } from "../shared/types.ts";
import { createWorkspace, exampleWorkspace } from "./seed.ts";
import type { StoredNode, StoredWorkspace } from "./store.ts";
import { importWorkspace, MAX_IMPORT_BYTES } from "./workspace-import.ts";

function fixture() {
  const workspace: StoredWorkspace = createWorkspace(
    "共享探索",
    "他人的研究背景",
  );
  const root = workspace.nodes[0];
  const child: StoredNode = {
    ...structuredClone(root),
    id: "source-answer",
    parentId: root.id,
    prompt: "问题甲",
    response: "完整回答甲 **Markdown**",
    status: "completed",
    position: { x: -240, y: 17.5 },
    config: { model: "unconfigured/research-model", thinking: "max" },
    revision: 2,
    contextIds: [root.id],
    contextSources: [
      { nodeId: root.id, revision: 0, messageCount: 1 },
      { nodeId: "source-answer", revision: 2, messageCount: 2 },
    ],
    usage: { input: 33, output: 45, total: 78, cost: 0.005 },
    messages: [
      { role: "user", content: "问题甲", timestamp: 100 },
      fauxAssistantMessage("完整回答甲 **Markdown**", { timestamp: 101 }),
    ],
  };
  const grandchild: StoredNode = {
    ...structuredClone(child),
    id: "source-descendant",
    parentId: child.id,
    prompt: "问题乙",
    response: "完整回答乙",
    contextIds: [root.id, child.id],
    contextSources: [
      { nodeId: root.id, revision: 0, messageCount: 1 },
      { nodeId: child.id, revision: 2, messageCount: 2 },
    ],
    messages: [
      { role: "user", content: "问题乙", timestamp: 102 },
      fauxAssistantMessage("完整回答乙", { timestamp: 103 }),
    ],
  };
  workspace.nodes.push(child, grandchild);
  return { version: 1, exportedAt: "2026-09-19T00:00:00.000Z", workspace };
}

test("imports batch approval as historical metadata without restoring execution authority", () => {
  const source = fixture();
  source.workspace.nodes[1].toolCalls = [
    {
      id: "batch-search",
      name: "web_search",
      arguments: { query: "example" },
      status: "completed",
      approval: "approved_tool",
      startedAt: 10,
      finishedAt: 12,
      authorization: {
        id: "old-grant",
        actionHash: "old-hash",
        policyVersion: "old-policy",
        issuedAt: 10,
        expiresAt: 20,
        consumedAt: 11,
      },
    },
  ];
  Object.assign(source.workspace.nodes[1], { approvedTools: ["web_search"] });
  const imported = importWorkspace(source);
  assert.equal(imported.nodes[1].toolCalls![0].approval, "approved_tool");
  assert.equal(imported.nodes[1].toolCalls![0].authorization, undefined);
  assert.equal("approvedTools" in imported.nodes[1], false);
});

test("imports content, layout and complete messages with independent workspace/node IDs", () => {
  const original = fixture();
  const before = structuredClone(original);
  const imported = importWorkspace(original);
  assert.deepEqual(
    original,
    before,
    "parsing must not mutate caller-owned input",
  );
  assert.notEqual(imported.id, original.workspace.id);
  assert.equal(imported.title, original.workspace.title);
  assert.equal(imported.description, original.workspace.description);
  assert.equal(imported.createdAt, original.workspace.createdAt);
  assert.equal(imported.approvalMode, "ask");
  assert.equal(imported.example, false);
  const [root, child, grandchild] = imported.nodes;
  for (let index = 0; index < imported.nodes.length; index++) {
    const node = imported.nodes[index];
    const source = original.workspace.nodes[index];
    assert.notEqual(node.id, source.id);
    assert.deepEqual(node.position, source.position);
    assert.equal(node.prompt, source.prompt);
    assert.equal(node.response, source.response);
    assert.deepEqual(node.config, source.config);
    assert.deepEqual(node.usage, source.usage);
    assert.deepEqual(node.messages, source.messages);
  }
  assert.equal(child.parentId, root.id);
  assert.equal(grandchild.parentId, child.id);
  assert.deepEqual(grandchild.contextIds, [root.id, child.id]);
  assert.deepEqual(child.contextSources, [
    { nodeId: root.id, revision: 0, messageCount: 1 },
    { nodeId: child.id, revision: 2, messageCount: 2 },
  ]);
  const context = buildContext(imported, grandchild.id);
  assert.deepEqual(context.ids, [root.id, child.id, grandchild.id]);
  assert.match(JSON.stringify(context.messages), /完整回答甲/);
  assert.match(JSON.stringify(context.messages), /完整回答乙/);
  assert.equal(child.config.model, "unconfigured/research-model");
  assert.equal(child.config.thinking, "max");
});

test("repeated imports and re-export/import cycles remain independent", () => {
  const first = importWorkspace(fixture());
  const second = importWorkspace(fixture());
  const third = importWorkspace({ version: 1, workspace: first });
  assert.equal(new Set([first.id, second.id, third.id]).size, 3);
  assert.equal(
    new Set(
      [...first.nodes, ...second.nodes, ...third.nodes].map((node) => node.id),
    ).size,
    9,
  );
  assert.deepEqual(first.nodes[1].messages, third.nodes[1].messages);
});

test("puts the unique root first even when a valid exported tree was reordered", () => {
  const source = fixture();
  source.workspace.nodes.reverse();
  const result = importWorkspace(source);
  assert.equal(result.nodes[0].status, "root");
  assert.equal(result.nodes[0].parentId, null);
  assert.equal(result.nodes[1].parentId, result.nodes[2].id);
});

test("legacy exports rebuild safe readable history, and branches inherit only their parents", () => {
  const workspace = exampleWorkspace();
  const imported = importWorkspace({ version: 1, workspace });
  const leaf = imported.nodes.find(
    (node) => node.prompt === "把「方案比较」作为第一个场景",
  )!;
  const history = JSON.stringify(buildContext(imported, leaf.id).messages);
  assert.match(history, /以下是从 JSON 导入的历史轮次/);
  assert.match(history, /思考本来就不是一条直线/);
  assert.doesNotMatch(history, /独立上下文，独立执行/);
  assert.equal(imported.example, false);
});

test("preserves multimodal, thinking signatures, tool results and usage as history", () => {
  const source = fixture();
  const assistant = structuredClone(
    fauxAssistantMessage(
      [
        {
          type: "thinking",
          thinking: "推导过程",
          thinkingSignature: "signed-history",
          redacted: false,
        },
        { type: "text", text: "分析回答", textSignature: "response-signature" },
        {
          type: "toolCall",
          id: "tool-1",
          name: "web_search",
          arguments: { query: "研究", count: 3 },
          namespace: "functions",
          thoughtSignature: "tool-signature",
        },
      ],
      { stopReason: "toolUse", timestamp: 120 },
    ),
  );
  assistant.usage.cacheWrite1h = 5;
  assistant.usage.reasoning = 10;
  assistant.responseModel = "actual-model";
  assistant.providerThinkingLevel = "xhigh";
  assistant.rawStopReason = "TOOL_CALL";
  assistant.endTurn = false;
  assistant.diagnostics = [
    {
      type: "recovery",
      timestamp: 119,
      error: { name: "ProviderError", message: "已重试", code: 429 },
      details: { retry: 1 },
    },
  ];
  const messages: Message[] = [
    {
      role: "user",
      timestamp: 110,
      content: [
        { type: "text", text: "看图片" },
        { type: "image", data: "YWJj", mimeType: "image/png" },
      ],
    },
    assistant,
    {
      role: "toolResult",
      timestamp: 121,
      toolCallId: "tool-1",
      toolName: "web_search",
      content: [
        { type: "text", text: "结果" },
        { type: "image", data: "YWJj", mimeType: "image/jpeg" },
      ],
      details: { links: ["https://example.test"], nested: { count: 2 } },
      usage: structuredClone(assistant.usage),
      isError: false,
    },
    fauxAssistantMessage("综合结果", { timestamp: 123 }),
  ];
  source.workspace.nodes[1].messages = messages;
  const imported = importWorkspace(source);
  assert.deepEqual(imported.nodes[1].messages, messages);
  assert.notEqual(imported.nodes[1].messages, messages);
  assert.notEqual(imported.nodes[1].messages?.[2], messages[2]);
});

test("strips execution capabilities and pending actions, including archived runs", () => {
  const source = fixture();
  const workspace = source.workspace;
  workspace.workingDirectory = "/someone-elses/project";
  workspace.temporaryDirectory = "/someone-elses/tmp";
  workspace.approvalMode = "auto";
  workspace.safetyModel = "other/safety";
  workspace.gitHistory = [
    {
      id: "old-history",
      nodeId: workspace.nodes[1].id,
      nodeRevision: 2,
      nodePrompt: "问题甲",
      toolCallId: "file-1",
      toolName: "write",
      workingDirectory: "/someone-elses/project",
      createdAt: 10,
      summary: "changed files",
      status: "completed",
      files: [],
      commit: "old-commit",
      parentCommit: "old-parent",
    },
  ];
  Object.assign(workspace, {
    pendingNodeRetry: {
      workingDirectory: "/someone-elses/project",
      plan: { restore: true },
    },
    pendingGitSnapshots: [{ baseline: { path: "/someone-elses/project" } }],
    pendingWorkspaceDeletion: { deleteTemporaryDirectory: true },
    unexpected: { executable: true },
  });
  const node = workspace.nodes[1];
  node.status = "running";
  node.execution = {
    workingDirectory: "/someone-elses/project",
    approvalMode: "auto",
    safetyModel: "other/safety",
  };
  node.requestId = "source-request";
  node.requestKind = "retry";
  node.retryRestore = { requestId: "restore-id", status: "restoring" };
  node.preparationRequest = {
    requestId: "old-prepare",
    config: node.config,
    revision: 2,
  };
  node.requestedContextCheckpointId = "old-checkpoint";
  node.contextState = { status: "compacting", updatedAt: 100 };
  node.preparedContextState = { status: "compacting", updatedAt: 100 };
  Object.assign(node, {
    compactions: [
      {
        id: "old-checkpoint",
        summary: "派生摘要",
        sources: [{ nodeId: "source-answer" }],
      },
    ],
    preparedCompaction: { id: "old-prepared", summary: "未完成摘要" },
  });
  node.toolCalls = [
    "reviewing",
    "awaiting_approval",
    "running",
    "completed",
  ].map((status, index) => ({
    id: `file-${index}`,
    name: "write",
    arguments: {
      path: "/someone-elses/project/readme.md",
      content: "历史内容",
    },
    status: status as
      | "reviewing"
      | "awaiting_approval"
      | "running"
      | "completed",
    approval: "approved",
    fileSnapshot: "unchanged",
    waitingFor: "file lock",
    output: "历史输出",
    startedAt: 110,
    authorization: {
      id: "old-auth",
      actionHash: "hash",
      policyVersion: "v1",
      issuedAt: 100,
      expiresAt: 9999999,
    },
    safetyReview: {
      model: "other/safety",
      decision: "reviewing",
      reason: "审核中",
      startedAt: 100,
    },
  }));
  node.previousRuns = [
    { ...structuredClone(node), archivedAt: 123, status: "queued" },
  ];
  const imported = importWorkspace(source);
  assert.equal(imported.approvalMode, "ask");
  for (const key of [
    "workingDirectory",
    "temporaryDirectory",
    "safetyModel",
    "gitHistory",
    "pendingNodeRetry",
    "pendingGitSnapshots",
    "pendingWorkspaceDeletion",
    "unexpected",
  ]) {
    assert.equal(Object.hasOwn(imported, key), false, key);
  }
  const importedNode = imported.nodes[1];
  for (const run of [importedNode, ...importedNode.previousRuns!]) {
    assert.equal(run.status, "failed");
    assert.ok(run.finishedAt);
    assert.match(run.error!, /导入/);
    for (const key of [
      "execution",
      "requestId",
      "requestKind",
      "retryRestore",
      "preparationRequest",
      "requestedContextCheckpointId",
      "contextState",
      "preparedContextState",
      "compactions",
      "preparedCompaction",
    ])
      assert.equal(Object.hasOwn(run, key), false, key);
    assert.deepEqual(
      run.toolCalls!.map((call) => call.status),
      ["cancelled", "cancelled", "cancelled", "completed"],
    );
    for (const call of run.toolCalls!) {
      assert.equal(call.output, "历史输出");
      assert.equal(call.safetyReview?.decision, "cancelled");
      assert.equal(
        call.approval,
        "approved",
        "display-only audit history remains readable",
      );
      for (const key of ["authorization", "fileSnapshot", "waitingFor"])
        assert.equal(Object.hasOwn(call, key), false, key);
    }
    assert.equal(run.id, importedNode.id);
    assert.equal(run.parentId, imported.nodes[0].id);
    assert.deepEqual(run.contextIds, [imported.nodes[0].id]);
  }
});

test("drops provider deferred handles and system tool declarations without losing message text", () => {
  const source = fixture();
  source.workspace.nodes[1].messages = [
    {
      role: "system",
      content: "历史系统提示",
      timestamp: 100,
      sections: { notes: "历史部分", old: null },
      toolsAdded: [
        {
          name: "remote_tool",
          description: "Remote",
          parameters: { type: "object" } as never,
        },
      ],
      toolsRemoved: [{ name: "local_tool" }],
    },
    fauxAssistantMessage("等待远端输出", {
      timestamp: 120,
      stopReason: "deferred",
      deferred: {
        id: "remote-job",
        api: "remote",
        provider: "remote",
        modelId: "remote",
      },
    }),
  ];
  const imported = importWorkspace(source);
  const [system, assistant] = imported.nodes[1].messages!;
  assert.equal(system.role, "system");
  assert.equal(system.content, "历史系统提示");
  assert.equal(Object.hasOwn(system, "toolsAdded"), false);
  assert.equal(Object.hasOwn(system, "toolsRemoved"), false);
  assert.equal(Object.hasOwn(assistant, "deferred"), false);
});

test("retains contextStale to prevent descendants silently reusing obsolete answers", () => {
  const source = fixture();
  source.workspace.nodes[2].contextStale = true;
  const imported = importWorkspace(source);
  assert.equal(imported.nodes[2].contextStale, true);
  assert.throws(() => buildContext(imported, imported.nodes[2].id), /失效/);
});

test("copies JSON tool data without preserving prototype behavior or unknown executable fields", () => {
  const source = fixture();
  const node = source.workspace.nodes[1];
  node.toolCalls = [
    {
      id: "historical-tool",
      name: "read",
      status: "completed",
      startedAt: 100,
      arguments: JSON.parse(
        '{"path":"README.md","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
      ),
    },
  ];
  Object.assign(node, { unknownExecution: { command: "run something" } });
  const imported = importWorkspace(source);
  const argumentsCopy = imported.nodes[1].toolCalls![0].arguments;
  assert.equal(Object.getPrototypeOf(argumentsCopy), Object.prototype);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.hasOwn(argumentsCopy, "__proto__"), true);
  assert.equal(Object.hasOwn(imported.nodes[1], "unknownExecution"), false);
});

test("rejects malformed tool histories and excessively nested opaque message data", () => {
  const source = fixture();
  const call = {
    id: "tool-1",
    name: "read",
    arguments: { path: "README.md" },
    status: "completed" as const,
    startedAt: 100,
  };
  source.workspace.nodes[1].toolCalls = [call, structuredClone(call)];
  assert.throws(() => importWorkspace(source), /重复 ID/);
  source.workspace.nodes[1].toolCalls = [
    { ...call, approval: "grant-everything" as never },
  ];
  assert.throws(() => importWorkspace(source), /历史审批/);
  source.workspace.nodes[1].toolCalls = [{ ...call, arguments: [] as never }];
  assert.throws(() => importWorkspace(source), /参数/);
  source.workspace.nodes[1].toolCalls = [call];
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  source.workspace.nodes[1].messages = [
    {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read",
      timestamp: 100,
      content: [],
      isError: false,
      details: cycle,
    },
  ];
  assert.throws(() => importWorkspace(source), /嵌套层级/);
});

test("rejects unsupported envelopes, invalid primitive fields and malformed messages", () => {
  for (const value of [
    null,
    [],
    "json",
    {},
    { version: 2 },
    fixture().workspace,
    { version: 1, workspace: {} },
  ])
    assert.throws(() => importWorkspace(value), /导入失败/);
  const cases: ((source: ReturnType<typeof fixture>) => void)[] = [
    (source) => {
      source.workspace.title = " ";
    },
    (source) => {
      source.workspace.nodes[1].position.x = Number.NaN;
    },
    (source) => {
      source.workspace.nodes[1].position.x = 1_000_001;
    },
    (source) => {
      source.workspace.nodes[1].config.thinking = "unknown" as never;
    },
    (source) => {
      source.workspace.nodes[1].status = "unknown" as never;
    },
    (source) => {
      source.workspace.nodes[1].response = { text: "wrong" } as never;
    },
    (source) => {
      source.workspace.nodes[1].createdAt = -1;
    },
    (source) => {
      source.workspace.nodes[1].revision = 1.5;
    },
    (source) => {
      source.workspace.nodes[1].contextStale = "false" as never;
    },
    (source) => {
      source.workspace.nodes[1].usage!.input = Number.POSITIVE_INFINITY;
    },
    (source) => {
      source.workspace.nodes[1].messages = [
        { role: "assistant", content: "not an array" } as never,
      ];
    },
    (source) => {
      source.workspace.nodes[1].messages = [
        { role: "admin", timestamp: 100, content: "bad" } as never,
      ];
    },
    (source) => {
      source.workspace.nodes[1].messages![0].timestamp = "now" as never;
    },
    (source) => {
      source.workspace.nodes[1].messages = [
        {
          role: "toolResult",
          toolCallId: "id",
          toolName: "tool",
          content: [],
          isError: "false",
          timestamp: 100,
        } as never,
      ];
    },
  ];
  for (const change of cases) {
    const source = fixture();
    change(source);
    assert.throws(() => importWorkspace(source), /导入失败/);
  }
});

test("rejects duplicate roots or IDs, orphan parents, cycles and inconsistent context references", () => {
  const cases: ((source: ReturnType<typeof fixture>) => void)[] = [
    (source) => {
      source.workspace.nodes = [];
    },
    (source) => {
      source.workspace.nodes[1].id = source.workspace.nodes[0].id;
    },
    (source) => {
      source.workspace.nodes[1].parentId = null;
    },
    (source) => {
      source.workspace.nodes[0].status = "completed";
    },
    (source) => {
      source.workspace.nodes[1].status = "root";
    },
    (source) => {
      source.workspace.nodes[1].parentId = "missing-parent";
    },
    (source) => {
      source.workspace.nodes[1].parentId = source.workspace.nodes[2].id;
    },
    (source) => {
      source.workspace.nodes[1].contextIds = [];
    },
    (source) => {
      source.workspace.nodes[1].contextIds = [source.workspace.nodes[2].id];
    },
    (source) => {
      source.workspace.nodes[1].contextSources![0].nodeId = "missing-source";
    },
    (source) => {
      source.workspace.nodes[1].contextSources![0].nodeId =
        source.workspace.nodes[2].id;
    },
  ];
  for (const change of cases) {
    const source = fixture();
    change(source);
    assert.throws(() => importWorkspace(source), /导入失败/);
  }
});

test("limits excessive node counts without attempting recursive traversal", () => {
  const source = fixture();
  source.workspace.nodes = Array.from({ length: 10_001 }, (_, index) => ({
    ...source.workspace.nodes[0],
    id: `node-${index}`,
  }));
  assert.throws(() => importWorkspace(source), /10000/);
  assert.equal(MAX_IMPORT_BYTES, 100 * 1024 * 1024);
});

test("imports verified compression origins and branch choices with new checkpoint provenance", () => {
  const exported = fixture();
  const parent = exported.workspace.nodes[1];
  const selected = exported.workspace.nodes[2];
  const context = buildContext(exported.workspace, parent.id);
  const first: ContextCheckpoint = {
    id: "first-summary",
    version: 1,
    sourceHash: contextSourceHash(
      context.messages,
      context.sources,
      context.messages.length,
    ),
    messageCount: context.messages.length,
    sources: context.sources,
    summary: "第一份总结",
    model: parent.config.model,
    thinking: parent.config.thinking,
    createdAt: 111,
    tokensBefore: 500,
    tokensAfter: 50,
  };
  const second = { ...first, id: "second-summary", summary: "第二份总结" };
  parent.preparedCompaction = second;
  parent.preparationRequests = [first, second].map((checkpoint, index) => ({
    requestId: `summary-${index}`,
    revision: parent.revision!,
    config: parent.config,
    status: "completed",
    checkpoint,
  }));
  selected.requestedContextCheckpointId = first.id;
  selected.effectiveContextCheckpointId = first.id;
  selected.compactions = [first];
  selected.contextState = {
    status: "compacted",
    updatedAt: 112,
    checkpointId: first.id,
  };
  const imported = importWorkspace(exported);
  const importedParent = imported.nodes[1];
  const importedSelected = imported.nodes[2];
  assert.equal(importedParent.preparedCompactions?.length, 2);
  const restored = importedParent.preparedCompactions![0];
  assert.notEqual(restored.id, first.id);
  assert.notEqual(restored.sourceHash, first.sourceHash);
  assert.equal(importedSelected.requestedContextCheckpointId, restored.id);
  assert.equal(importedSelected.effectiveContextCheckpointId, restored.id);
  assert.equal(importedSelected.compactions?.[0].id, restored.id);
  assert.equal(importedSelected.contextState?.checkpointId, restored.id);
  const restoredContext = buildContext(imported, importedParent.id);
  assert.equal(
    checkpointMatches(
      restored,
      restoredContext.messages,
      restoredContext.sources,
    ),
    true,
  );
  assert.ok(
    contextCheckpoints(imported, restoredContext.ids).some(
      (checkpoint) => checkpoint.id === restored.id,
    ),
  );
  assert.equal(importedParent.preparationRequests, undefined);
  assert.deepEqual(importedParent.messages, parent.messages);
  selected.contextMode = "raw";
  selected.effectiveContextMode = "raw";
  selected.contextAutoCompact = true;
  const rawImported = importWorkspace(exported).nodes[2];
  assert.equal(rawImported.contextMode, "raw");
  assert.equal(rawImported.effectiveContextMode, "raw");
  assert.equal(rawImported.contextAutoCompact, false);
  assert.equal(rawImported.requestedContextCheckpointId, undefined);
  assert.equal(rawImported.effectiveContextCheckpointId, undefined);
});

test("import discards summaries whose claimed source hash does not match raw messages", () => {
  const exported = fixture();
  const parent = exported.workspace.nodes[1];
  const context = buildContext(exported.workspace, parent.id);
  parent.preparedCompaction = {
    id: "tampered-summary",
    version: 1,
    sourceHash: "not-the-original-hash",
    messageCount: context.messages.length,
    sources: context.sources,
    summary: "伪造来源",
    model: parent.config.model,
    thinking: parent.config.thinking,
    createdAt: 111,
    tokensBefore: 500,
    tokensAfter: 50,
  };
  exported.workspace.nodes[2].effectiveContextCheckpointId =
    parent.preparedCompaction.id;
  const imported = importWorkspace(exported);
  assert.equal(imported.nodes[1].preparedCompaction, undefined);
  assert.equal(imported.nodes[1].preparedCompactions, undefined);
  assert.equal(imported.nodes[2].effectiveContextCheckpointId, undefined);
});
