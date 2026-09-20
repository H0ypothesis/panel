import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Message,
} from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { canBranchFrom } from "../shared/node-branching.ts";
import { buildContext } from "./context.ts";
import { ContextCompactor, contextSourceHash } from "./compaction.ts";
import { prepareAttachments } from "./attachments.ts";
import { PiRuntime, type Runtime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type StoredNode } from "./store.ts";

const config = { model: "test/continuation", thinking: "off" as const };
const model = {
  id: config.model,
  name: "Continuation",
  provider: "test",
  providerName: "Test",
  available: true,
  demo: true,
  thinkingLevels: ["off" as const],
  contextWindow: 128000,
};
function historyFixture(status: "failed" | "cancelled" = "failed") {
  const workspace = createWorkspace("Root", "Branch context");
  const tools = fauxAssistantMessage("Completed step. ");
  tools.stopReason = "toolUse";
  tools.content.push({
    type: "toolCall",
    id: "done",
    name: "read",
    arguments: { path: "notes.txt" },
  });
  const partial = fauxAssistantMessage("Partial analysis survives.");
  partial.stopReason = status === "failed" ? "error" : "aborted";
  partial.content.push({
    type: "thinking",
    thinking: "PRIVATE_THINKING",
    thinkingSignature: "UNFINISHED_SIGNATURE",
  });
  partial.content.push({
    type: "toolCall",
    id: "unfinished",
    name: "write",
    arguments: { path: "unfinished" },
  });
  const node: StoredNode = {
    ...workspace.nodes[0],
    id: "interrupted",
    parentId: workspace.nodes[0].id,
    status,
    prompt: "Original request",
    response: "Completed step. Partial analysis survives.",
    config,
    finishedAt: 1234,
    messages: [
      { role: "user", content: "Original request", timestamp: 1 },
      tools,
      {
        role: "toolResult",
        toolCallId: "done",
        toolName: "read",
        content: [{ type: "text", text: "Completed tool evidence" }],
        isError: false,
        timestamp: 2,
      },
      partial,
    ],
  };
  workspace.nodes.push(node);
  return { workspace, node };
}

for (const status of ["failed", "cancelled"] as const) {
  test(`${status} history survives native Pi conversion without replaying incomplete tool calls`, async () => {
    const { workspace, node } = historyFixture(status);
    workspace.nodes.push({
      ...structuredClone(node),
      id: "sibling",
      response: "SIBLING_SECRET",
    });
    // Persisted UI text may lag behind the last raw assistant snapshot.
    if (status === "cancelled") node.response = "Completed step. ";
    const original = structuredClone(node);
    const context = buildContext(workspace, node.id);
    assert.deepEqual(context, buildContext(workspace, node.id));
    assert.deepEqual(node, original);
    assert.equal(
      context.sources.at(-1)?.messageCount,
      context.messages.length - 1,
    );
    const faux = fauxProvider({
      provider: "test",
      models: [{ id: "continuation", contextWindow: 128000, maxTokens: 512 }],
      tokensPerSecond: 1000000,
      tokenSize: { min: 2000, max: 3000 },
    });
    const registry = createModels();
    registry.setProvider(faux.provider);
    const runtime = new PiRuntime(registry);
    faux.setResponses([
      (input) => {
        const converted = transformMessages(
          input.messages,
          registry.getModel("test", "continuation")!,
        );
        const text = JSON.stringify(converted);
        assert.match(text, /Original request/);
        assert.match(text, /Partial analysis survives/);
        assert.match(text, /Completed tool evidence/);
        assert.doesNotMatch(
          text,
          /PRIVATE_THINKING|UNFINISHED_SIGNATURE|unfinished|SIBLING_SECRET/,
        );
        assert.equal(
          converted.filter((message) => message.role === "toolResult").length,
          1,
        );
        return fauxAssistantMessage("Continued successfully");
      },
    ]);
    let executed = 0;
    const result = await runtime.run(
      config,
      context.messages,
      "Continue remaining work",
      new AbortController().signal,
      () => {},
      {
        beforeToolCall: async () => {
          executed++;
          return true;
        },
        executeTool: async (_call, execute) => {
          executed++;
          return execute();
        },
        onToolUpdate: () => {},
      },
      {
        autoCompact: false,
        sources: [
          ...context.sources,
          { nodeId: "next", revision: 0, messageCount: 0 },
        ],
      },
    );
    assert.equal(result.response, "Continued successfully");
    assert.equal(executed, 0);
  });
}

test("missing tool results are closed deterministically and can be compacted", async () => {
  const { workspace, node } = historyFixture("cancelled");
  node.messages = node.messages!.slice(0, 2);
  node.messages[1] = structuredClone(node.messages[1]);
  assert.equal(node.messages[1].role, "assistant");
  if (node.messages[1].role === "assistant")
    node.messages[1].content.push({
      type: "toolCall",
      id: "pending",
      name: "write",
      arguments: { path: "output" },
    });
  node.toolCalls = [
    {
      id: "done",
      name: "read",
      arguments: {},
      status: "completed",
      output: "Saved full output",
      startedAt: 1,
    },
  ];
  const context = buildContext(workspace, node.id);
  const toolResults = context.messages.filter(
    (message) => message.role === "toolResult",
  );
  assert.equal(toolResults.length, 2);
  assert.equal(toolResults[0].isError, false);
  assert.equal(toolResults[1].isError, true);
  assert.match(JSON.stringify(toolResults), /Saved full output/);
  assert.deepEqual(context, buildContext(workspace, node.id));
  const compactor = new ContextCompactor({
    model: config.model,
    thinking: "off",
    contextWindow: 16000,
    maxOutputTokens: 512,
    systemPrompt: "test",
    tools: [],
    sources: context.sources,
    autoCompact: true,
    summarize: async () => ({
      text: "Retained work and interrupted tool outcome",
    }),
  });
  await compactor.prepare(context.messages, new AbortController().signal, true);
});

test("restart and missing raw history retain prompt, references, attachments, visible progress and tool audits", async () => {
  const { workspace, node } = historyFixture();
  delete node.messages;
  node.response = "Streamed partial content with no message_end";
  node.contextReferences = [
    {
      nodeId: "selected",
      revision: 1,
      prompt: "Referenced question",
      response: "Referenced evidence",
    },
  ];
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5d8AAAAASUVORK5CYII=";
  node.attachmentData = await prepareAttachments([
    {
      name: "notes.txt",
      mediaType: "text/plain",
      data: Buffer.from("Uploaded document evidence").toString("base64"),
    },
    { name: "pixel.png", mediaType: "image/png", data: png },
  ]);
  node.toolCalls = [
    {
      id: "audit",
      name: "bash",
      arguments: { command: "echo partial" },
      status: "cancelled",
      output: "Saved partial tool output",
      startedAt: 1,
    },
  ];
  const directory = await mkdtemp(
    join(tmpdir(), "panel-continuation-restart-"),
  );
  try {
    const store = new Store(directory);
    await store.init(false);
    store.data.workspaces.push(workspace);
    await store.save();
    const restarted = new Store(directory);
    await restarted.init(false);
    const context = buildContext(restarted.workspace(workspace.id), node.id);
    const text = JSON.stringify(context.messages);
    for (const evidence of [
      "Original request",
      "Referenced evidence",
      "Uploaded document evidence",
      "Streamed partial content",
      "Saved partial tool output",
      "cancelled",
    ])
      assert.ok(text.includes(evidence));
    assert.doesNotMatch(text, /PRIVATE_THINKING/);
    const user = context.messages.find(
      (message) => message.role === "user" && Array.isArray(message.content),
    );
    assert.ok(user && Array.isArray(user.content));
    assert.deepEqual(user.content.at(-1), {
      type: "image",
      mimeType: "image/png",
      data: png,
    });
    assert.equal(
      context.messages.filter((message) => message.role === "toolResult")
        .length,
      0,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("completed prefixes keep checkpoint hashes while interrupted tails change", () => {
  const { workspace, node } = historyFixture();
  const before = {
    messages: [
      {
        role: "user" as const,
        content: `探索主题：${workspace.nodes[0].prompt}\n背景：${workspace.nodes[0].response}`,
        timestamp: workspace.nodes[0].createdAt,
      },
      ...node.messages!,
    ],
    sources: [
      { nodeId: workspace.nodes[0].id, revision: 0, messageCount: 1 },
      { nodeId: node.id, revision: 0, messageCount: node.messages!.length },
    ],
  };
  const after = buildContext(workspace, node.id);
  assert.equal(
    contextSourceHash(before.messages, before.sources, 4),
    contextSourceHash(after.messages, after.sources, 4),
  );
  assert.notEqual(
    contextSourceHash(before.messages, before.sources, 5),
    contextSourceHash(after.messages, after.sources, 5),
  );
});

test("branch eligibility excludes active, stale and every pending retry-restore state", () => {
  for (const status of ["root", "completed", "failed", "cancelled"] as const)
    assert.equal(canBranchFrom({ status }), true);
  for (const status of ["running", "queued"] as const)
    assert.equal(canBranchFrom({ status }), false);
  assert.equal(canBranchFrom({ status: "failed", contextStale: true }), false);
  for (const status of ["restoring", "restored", "failed"] as const)
    assert.equal(
      canBranchFrom({
        status: "failed",
        retryRestore: { requestId: "retry", status },
      }),
      false,
    );
});

test("cancelled ancestors must finish saving before a new branch can run, then descendants inherit progress", async () => {
  const directory = await mkdtemp(join(tmpdir(), "panel-continuation-settle-"));
  const store = new Store(directory);
  await store.init(false);
  const workspace = createWorkspace("Root", "Context");
  store.data.workspaces.push(workspace);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  const histories: Message[][] = [];
  const runtime: Runtime = {
    models: () => [model],
    async run(_config, history, prompt, signal, onText, _env, options) {
      histories.push(structuredClone(history));
      if (prompt === "interrupt") {
        started = true;
        onText("Partial persisted during cancellation");
        await gate;
        await options?.onMessages?.([
          { role: "user", content: prompt, timestamp: 1 },
          fauxAssistantMessage("Final saved progress"),
        ]);
        signal.throwIfAborted();
      }
      return {
        response: "done",
        messages: [
          { role: "user", content: prompt, timestamp: 2 },
          fauxAssistantMessage("done"),
        ],
      };
    },
  };
  const scheduler = new Scheduler(store, runtime);
  const submit = (parentId: string, prompt: string) =>
    scheduler.submit(workspace.id, {
      parentId,
      prompt,
      config,
      requestId: randomUUID(),
    });
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await delay(10);
    }
    assert.fail("Timed out");
  };
  try {
    const failed = await submit(workspace.nodes[0].id, "interrupt");
    await until(() => started);
    await scheduler.cancel(workspace.id, failed.id);
    await assert.rejects(submit(failed.id, "too soon"), /收尾/);
    release();
    await until(() => Boolean(failed.messages?.length));
    await delay(30);
    const child = await submit(failed.id, "continue");
    await until(() => child.status === "completed");
    await delay(30);
    const grandchild = await submit(child.id, "next");
    await until(() => grandchild.status === "completed");
    assert.match(JSON.stringify(histories.at(-1)), /Final saved progress/);
    assert.match(
      JSON.stringify(histories.at(-1)),
      /Partial persisted during cancellation/,
    );
    assert.equal(failed.status, "cancelled");
    failed.contextStale = true;
    await assert.rejects(submit(child.id, "stale path"), /失效/);
  } finally {
    release();
    scheduler.shutdown();
    await delay(30);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  }
});

test("completed ancestors can branch while their final save is still finishing", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "panel-completed-continuation-"),
  );
  const store = new Store(directory);
  await store.init(false);
  const workspace = createWorkspace("Root", "Context");
  store.data.workspaces.push(workspace);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reachedFinalSave!: () => void;
  const finalSave = new Promise<void>((resolve) => {
    reachedFinalSave = resolve;
  });
  let held = false;
  const save = store.save.bind(store);
  store.save = async (options) => {
    if (
      !held &&
      workspace.nodes.some(
        (node) => node.prompt === "parent" && node.status === "completed",
      )
    ) {
      held = true;
      reachedFinalSave();
      await gate;
    }
    return save(options);
  };
  const histories: Message[][] = [];
  const runtime: Runtime = {
    models: () => [model],
    async run(_config, history, prompt) {
      histories.push(structuredClone(history));
      return {
        response: `Final ${prompt} answer`,
        messages: [
          { role: "user", content: prompt, timestamp: 1 },
          fauxAssistantMessage(`Final ${prompt} answer`),
        ],
      };
    },
  };
  const scheduler = new Scheduler(store, runtime);
  try {
    const parent = await scheduler.submit(workspace.id, {
      parentId: workspace.nodes[0].id,
      prompt: "parent",
      config,
      requestId: randomUUID(),
    });
    await finalSave;
    assert.equal(parent.status, "completed");
    const child = await scheduler.submit(workspace.id, {
      parentId: parent.id,
      prompt: "child",
      config,
      requestId: randomUUID(),
    });
    for (let i = 0; i < 200 && child.status !== "completed"; i++)
      await delay(10);
    assert.equal(child.status, "completed", child.error);
    assert.match(JSON.stringify(histories.at(-1)), /Final parent answer/);
  } finally {
    release();
    store.save = save;
    scheduler.shutdown();
    await delay(30);
    await save();
    await rm(directory, { recursive: true, force: true });
  }
});
