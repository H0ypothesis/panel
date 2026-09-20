import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { RunConfig } from "../shared/types.ts";
import { createApi } from "./api.ts";
import { buildContext, SYSTEM_PROMPT } from "./context.ts";
import {
  contextReferencePrompt,
  referenceNodeIds,
  resolveContextReferences,
} from "./context-references.ts";
import type { Runtime } from "./runtime.ts";
import { NodeMutationConflict, Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type StoredNode, type StoredWorkspace } from "./store.ts";

const config: RunConfig = { model: "test/references", thinking: "off" };
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for reference run");
}
async function settled<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (
        !(error instanceof NodeMutationConflict) ||
        !error.message.includes("收尾")
      )
        throw error;
      await delay(10);
    }
  }
  assert.fail("Timed out waiting for run cleanup");
}
function source(
  workspace: StoredWorkspace,
  label = "SOURCE",
  parentId = workspace.nodes[0].id,
) {
  const node: StoredNode = {
    id: randomUUID(),
    parentId,
    prompt: `${label}_QUESTION`,
    response: `${label}_ANSWER`,
    status: "completed",
    revision: 3,
    config,
    color: "sage",
    position: { x: 360, y: 0 },
    contextIds: [workspace.nodes[0].id],
    createdAt: Date.now(),
  };
  workspace.nodes.push(node);
  return node;
}
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "panel-references-"));
  const store = new Store(directory);
  await store.init(false);
  const workspace: StoredWorkspace = createWorkspace(
    "Reference flow",
    "Root background",
  );
  store.data.workspaces.push(workspace);
  const calls: { prompt: string; history: Message[]; count?: number }[] = [];
  let failNext = false;
  const runtime: Runtime = {
    models: () => [
      {
        id: config.model,
        name: "References",
        provider: "test",
        providerName: "Test",
        demo: true,
        available: true,
        thinkingLevels: ["off"],
        contextWindow: 128000,
      },
    ],
    async run(
      _config,
      history,
      prompt,
      _signal,
      _onText,
      _environment,
      options,
    ) {
      calls.push({
        prompt,
        history: structuredClone(history),
        count: options?.contextReferenceCount,
      });
      const messages: Message[] = [
        { role: "user", content: prompt, timestamp: Date.now() },
      ];
      await options?.onMessages?.(messages);
      if (failNext) {
        failNext = false;
        throw new Error("Simulated failure");
      }
      const response = "Generated answer";
      messages.push(fauxAssistantMessage(response));
      return { messages, response };
    },
  };
  const scheduler = new Scheduler(store, runtime);
  const api = createApi(store, runtime, scheduler);
  const call = async (method: string, path: string, body?: unknown) => {
    const request = Readable.from(
      body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
    ) as IncomingMessage;
    Object.assign(request, {
      method,
      url: `/api${path}`,
      headers: { host: "127.0.0.1:9999", "content-type": "application/json" },
    });
    let status = 0;
    let output = "";
    const response = {
      setHeader() {},
      writeHead(value: number) {
        status = value;
      },
      end(value = "") {
        output += value;
      },
    } as unknown as ServerResponse;
    await api(request, response);
    return { status, output };
  };
  const submit = async (
    references?: string[],
    parentId = workspace.nodes[0].id,
    prompt = "Use chosen cards",
  ) => {
    const node = await scheduler.submit(workspace.id, {
      parentId,
      prompt,
      referenceNodeIds: references,
      config,
      requestId: randomUUID(),
    });
    await until(() => node.status === "completed" || node.status === "failed");
    return node;
  };
  t.after(async () => {
    scheduler.shutdown();
    await delay(30);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    store,
    workspace,
    scheduler,
    calls,
    call,
    submit,
    failNext: () => {
      failNext = true;
    },
  };
}

test("reference requests validate and deduplicate IDs, reject invalid and cross-workspace cards", () => {
  assert.deepEqual(referenceNodeIds([" a ", "a", "b"]), ["a", "b"]);
  assert.equal(referenceNodeIds(undefined), undefined);
  assert.deepEqual(referenceNodeIds([]), []);
  for (const invalid of [
    null,
    "a",
    [3],
    [""],
    ["a".repeat(101)],
    Array.from({ length: 21 }, (_, i) => `${i}`),
  ])
    assert.throws(() => referenceNodeIds(invalid), /引用/);
  const workspace = createWorkspace("Main", "");
  const other = createWorkspace("Other", "");
  const elsewhere = source(other);
  assert.throws(
    () => resolveContextReferences(workspace, [elsewhere.id]),
    /不存在|不属于/,
  );
  assert.throws(
    () => resolveContextReferences(workspace, [workspace.nodes[0].id]),
    /已完成/,
  );
  const candidate = source(workspace);
  for (const status of ["queued", "running", "failed", "cancelled"] as const) {
    candidate.status = status;
    assert.throws(
      () => resolveContextReferences(workspace, [candidate.id]),
      /已完成/,
    );
  }
  candidate.status = "completed";
  candidate.contextStale = true;
  assert.throws(
    () => resolveContextReferences(workspace, [candidate.id]),
    /有效/,
  );
});

test("explicit snapshots contain only a card's own visible text and remain independent of later changes", () => {
  const workspace = createWorkspace("Main", "");
  const ancestor = source(workspace, "UNSELECTED_ANCESTOR");
  const chosen = source(workspace, "SELECTED", ancestor.id);
  chosen.contextReferences = [
    {
      nodeId: "nested",
      revision: 0,
      prompt: "NESTED_REFERENCE",
      response: "NESTED_ANSWER",
    },
  ];
  chosen.messages = [
    { role: "user", content: "TOOL_AND_ATTACHMENT_TRANSCRIPT", timestamp: 0 },
  ];
  const references = resolveContextReferences(workspace, [chosen.id])!;
  assert.deepEqual(references, [
    {
      nodeId: chosen.id,
      revision: 3,
      prompt: "SELECTED_QUESTION",
      response: "SELECTED_ANSWER",
    },
  ]);
  chosen.prompt = "Changed question";
  chosen.response = "Changed answer";
  chosen.revision = 4;
  const prompt = contextReferencePrompt("Current instruction", references);
  assert.match(
    prompt,
    /Current instruction[\s\S]*SELECTED_QUESTION[\s\S]*SELECTED_ANSWER/,
  );
  assert.doesNotMatch(
    prompt,
    /Changed|NESTED_|UNSELECTED_|TOOL_AND_ATTACHMENT/,
  );
  assert.match(prompt, /不构成额外操作授权/);
  assert.match(SYSTEM_PROMPT, /引用卡片仅作为参考资料/);
});

test("references and attachments reach the current prompt, then only the successful descendant branch", async (t) => {
  const e = await fixture(t);
  const chosen = source(e.workspace);
  const node = await e.scheduler.submit(e.workspace.id, {
    parentId: e.workspace.nodes[0].id,
    prompt: "Combine inputs",
    referenceNodeIds: [chosen.id, chosen.id],
    attachments: [
      {
        name: "notes.txt",
        mediaType: "text/plain",
        data: Buffer.from("CURRENT_ATTACHMENT").toString("base64"),
      },
    ],
    config,
    requestId: randomUUID(),
  });
  await until(() => node.status === "completed");
  assert.equal(node.contextReferences?.length, 1);
  assert.equal(e.calls[0].count, 1);
  assert.match(e.calls[0].prompt, /SOURCE_ANSWER/);
  assert.match(e.calls[0].prompt, /CURRENT_ATTACHMENT/);
  assert.doesNotMatch(JSON.stringify(e.calls[0].history), /SOURCE_ANSWER/);
  await e.submit(undefined, node.id, "Continue this branch");
  assert.match(JSON.stringify(e.calls[1].history), /SOURCE_ANSWER/);
  assert.doesNotMatch(e.calls[1].prompt, /SOURCE_ANSWER/);
  await e.submit(undefined);
  assert.doesNotMatch(
    JSON.stringify(e.calls[2]),
    /SOURCE_ANSWER|CURRENT_ATTACHMENT/,
  );
  const editorial = source(e.workspace, "NO_TRANSCRIPT");
  editorial.contextReferences = structuredClone(node.contextReferences);
  assert.match(
    JSON.stringify(buildContext(e.workspace, editorial.id).messages),
    /SOURCE_ANSWER/,
  );
  await e.store.save();
  const reopened = new Store(e.directory);
  await reopened.init(false);
  assert.deepEqual(
    reopened.workspace(e.workspace.id).nodes.find((item) => item.id === node.id)
      ?.contextReferences,
    node.contextReferences,
  );
});

test("idempotent submissions preserve snapshots after sources disappear and reject changed reference selections", async (t) => {
  const e = await fixture(t);
  const chosen = source(e.workspace);
  const input = {
    parentId: e.workspace.nodes[0].id,
    prompt: "Use chosen",
    config,
    requestId: randomUUID(),
    referenceNodeIds: [chosen.id, chosen.id],
  };
  const first = await e.scheduler.submit(e.workspace.id, input);
  await until(() => first.status === "completed");
  await settled(() =>
    e.scheduler.deleteNode(e.workspace.id, chosen.id, {
      expectedRevision: chosen.revision!,
      expectedNodeIds: [chosen.id],
    }),
  );
  const repeated = await e.scheduler.submit(e.workspace.id, input);
  assert.equal(first.id, repeated.id);
  assert.equal(e.calls.length, 1);
  await assert.rejects(
    e.scheduler.submit(e.workspace.id, { ...input, referenceNodeIds: [] }),
    /请求 ID/,
  );
});

test("regeneration retains removed-source snapshots, can add selections, retry preserves them, and explicit empty clears them", async (t) => {
  const e = await fixture(t);
  const chosen = source(e.workspace);
  const next = source(e.workspace, "NEXT");
  const original = await e.submit([chosen.id]);
  const saved = structuredClone(original.contextReferences);
  await settled(() =>
    e.scheduler.deleteNode(e.workspace.id, chosen.id, {
      expectedRevision: chosen.revision!,
      expectedNodeIds: [chosen.id],
    }),
  );
  const firstInput = {
    prompt: "Edited",
    config,
    requestId: randomUUID(),
    expectedRevision: 0,
  };
  const edited = await settled(() =>
    e.scheduler.regenerate(e.workspace.id, original.id, firstInput),
  );
  await until(() => edited.status === "completed");
  assert.deepEqual(edited.contextReferences, saved);
  assert.equal(
    (await e.scheduler.regenerate(e.workspace.id, original.id, firstInput))
      .revision,
    1,
  );
  e.failNext();
  const mixed = await settled(() =>
    e.scheduler.regenerate(e.workspace.id, original.id, {
      prompt: "Combine",
      config,
      requestId: randomUUID(),
      expectedRevision: 1,
      referenceNodeIds: [chosen.id, next.id],
    }),
  );
  await until(() => mixed.status === "failed");
  assert.deepEqual(mixed.contextReferences?.[0], saved?.[0]);
  assert.equal(mixed.contextReferences?.[1].nodeId, next.id);
  const retried = await settled(() =>
    e.scheduler.retry(e.workspace.id, original.id, {
      requestId: randomUUID(),
      expectedRevision: 2,
    }),
  );
  await until(() => retried.status === "completed");
  assert.deepEqual(retried.contextReferences, mixed.contextReferences);
  assert.deepEqual(retried.previousRuns?.[0].contextReferences, saved);
  assert.doesNotMatch(
    JSON.stringify(e.calls.at(-1)?.history),
    /Generated answer/,
  );
  const cleared = await settled(() =>
    e.scheduler.regenerate(e.workspace.id, original.id, {
      prompt: "Clear",
      config,
      requestId: randomUUID(),
      expectedRevision: 3,
      referenceNodeIds: [],
    }),
  );
  await until(() => cleared.status === "completed");
  assert.deepEqual(cleared.contextReferences, []);
  assert.doesNotMatch(e.calls.at(-1)!.prompt, /SOURCE_|NEXT_/);
});

test("API accepts explicit references, exports snapshots, and rejects malformed or fabricated selections before mutation", async (t) => {
  const e = await fixture(t);
  const capabilities = await e.call("GET", "/capabilities");
  assert.equal(capabilities.status, 200);
  assert.equal(JSON.parse(capabilities.output).cardReferences, true);
  const chosen = source(e.workspace);
  const path = `/workspaces/${e.workspace.id}/nodes`;
  const input = {
    parentId: e.workspace.nodes[0].id,
    prompt: "Use card",
    config,
    referenceNodeIds: [chosen.id],
    requestId: randomUUID(),
  };
  const created = await e.call("POST", path, input);
  assert.equal(created.status, 201, created.output);
  const nodeId = JSON.parse(created.output).nodeId;
  await until(
    () =>
      e.workspace.nodes.find((node) => node.id === nodeId)?.status ===
      "completed",
  );
  const exported = await e.call("GET", `/workspaces/${e.workspace.id}/export`);
  assert.equal(
    JSON.parse(exported.output).workspace.nodes.find(
      (node: StoredNode) => node.id === nodeId,
    ).contextReferences[0].response,
    "SOURCE_ANSWER",
  );
  const markdown = await e.call(
    "GET",
    `/workspaces/${e.workspace.id}/export?format=markdown&node=${nodeId}`,
  );
  assert.match(
    markdown.output,
    /引用卡片[\s\S]*SOURCE_QUESTION[\s\S]*SOURCE_ANSWER/,
  );
  const count = e.workspace.nodes.length;
  for (const referenceNodeIds of [
    null,
    "string",
    [false],
    ["missing"],
    [e.workspace.nodes[0].id],
  ]) {
    const result = await e.call("POST", path, {
      ...input,
      requestId: randomUUID(),
      referenceNodeIds,
    });
    assert.equal(result.status, 400, result.output);
  }
  assert.equal(e.workspace.nodes.length, count);
  assert.equal(e.calls.length, 1);
});
