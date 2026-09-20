import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { AttachmentUpload } from "../shared/attachments.ts";
import type { RunConfig } from "../shared/types.ts";
import { createApi } from "./api.ts";
import { imageContent, type StoredAttachment } from "./attachments.ts";
import { buildContext } from "./context.ts";
import type { Runtime } from "./runtime.ts";
import { NodeMutationConflict, Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store, type StoredWorkspace } from "./store.ts";

const config: RunConfig = { model: "test/attachments", thinking: "off" };
function upload(text: string, name = "notes.md"): AttachmentUpload {
  return {
    name,
    mediaType: "text/markdown",
    data: Buffer.from(text).toString("base64"),
  };
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for attachment run");
}

async function afterRunSettles<T>(run: () => Promise<T>): Promise<T> {
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
  assert.fail("Timed out waiting for scheduler cleanup");
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "panel-attachment-flow-"));
  const store = new Store(directory);
  await store.init(false);
  const workspace: StoredWorkspace = createWorkspace(
    "Attachment flow",
    "Root background",
  );
  store.data.workspaces.push(workspace);
  const calls: {
    prompt: string;
    history: Message[];
    attachments: StoredAttachment[];
  }[] = [];
  let failure: string | undefined;
  const runtime: Runtime = {
    models: () => [
      {
        id: config.model,
        name: "Attachments test",
        provider: "test",
        providerName: "Test",
        demo: true,
        available: true,
        thinkingLevels: ["off"],
        contextWindow: 128_000,
      },
      {
        id: "test/text-only",
        name: "Text-only test",
        provider: "test",
        providerName: "Test",
        demo: false,
        available: true,
        supportsImages: false,
        thinkingLevels: ["off"],
        contextWindow: 128_000,
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
      const attachments = options?.attachments ?? [];
      calls.push({
        prompt,
        history: structuredClone(history),
        attachments: structuredClone(attachments),
      });
      const images = imageContent(attachments);
      const messages: Message[] = [
        {
          role: "user",
          content: images.length
            ? [{ type: "text", text: prompt }, ...images]
            : prompt,
          timestamp: Date.now(),
        },
      ];
      await options?.onMessages?.(messages);
      if (failure) {
        const error = failure;
        failure = undefined;
        throw new Error(error);
      }
      messages.push(fauxAssistantMessage("Attachment test answer"));
      return { messages, response: "Attachment test answer" };
    },
  };
  const scheduler = new Scheduler(store, runtime);
  const api = createApi(store, runtime, scheduler);
  const submit = async (
    parentId: string,
    attachments: AttachmentUpload[] = [],
    prompt = "分析资料",
    requestId = randomUUID(),
  ) => {
    const node = await scheduler.submit(workspace.id, {
      parentId,
      prompt,
      attachments,
      config,
      requestId,
    });
    await until(() => node.status === "completed" || node.status === "failed");
    return node;
  };
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
    const chunks: Buffer[] = [];
    const headers: Record<string, unknown> = {};
    const response = {
      setHeader(name: string, value: unknown) {
        headers[name.toLowerCase()] = value;
      },
      writeHead(value: number, values?: Record<string, unknown>) {
        status = value;
        if (values) Object.assign(headers, values);
      },
      end(value?: string | Buffer) {
        if (value !== undefined) chunks.push(Buffer.from(value));
      },
    } as unknown as ServerResponse;
    await api(request, response);
    return { status, output: Buffer.concat(chunks), headers };
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
    submit,
    call,
    failNext: (message: string) => {
      failure = message;
    },
  };
}

test("attachments persist as originals while snapshots expose only metadata and descendants inherit their parent branch", async (t) => {
  const e = await fixture(t);
  const root = e.workspace.nodes[0].id;
  const a = await e.submit(root, [
    upload("PRIVATE_ALPHA_ATTACHMENT", "alpha.md"),
  ]);
  const b = await e.submit(root, [
    upload("PRIVATE_BETA_ATTACHMENT", "beta.md"),
  ]);
  const child = await e.submit(a.id, [], "继续分析甲");
  assert.match(e.calls[0].prompt, /PRIVATE_ALPHA_ATTACHMENT/);
  assert.equal(e.calls[0].attachments[0].text, "PRIVATE_ALPHA_ATTACHMENT");
  assert.match(JSON.stringify(e.calls[2].history), /PRIVATE_ALPHA_ATTACHMENT/);
  assert.doesNotMatch(
    JSON.stringify(e.calls[2].history),
    /PRIVATE_BETA_ATTACHMENT/,
  );
  assert.deepEqual(child.contextIds, [root, a.id]);
  assert.doesNotMatch(
    JSON.stringify(buildContext(e.workspace, b.id).messages),
    /PRIVATE_ALPHA_ATTACHMENT/,
  );
  const snapshot = JSON.stringify(e.store.snapshot());
  assert.match(snapshot, /alpha.md/);
  assert.doesNotMatch(
    snapshot,
    /attachmentData|attachmentInputHash|PRIVATE_ALPHA_ATTACHMENT|UFJJVkFURV9BTFBIQV9BVFRBQ0hNRU5U/,
  );
  await e.store.save();
  assert.match(
    await readFile(join(e.directory, "state.json"), "utf8"),
    /PRIVATE_ALPHA_ATTACHMENT/,
  );
  const restarted = new Store(e.directory);
  await restarted.init(false);
  assert.deepEqual(
    restarted.workspace(e.workspace.id).nodes.find((node) => node.id === a.id)
      ?.attachmentData,
    a.attachmentData,
  );
});

test("duplicate requests preserve attachment identity and reject the same request ID with different bytes", async (t) => {
  const e = await fixture(t);
  const input = {
    parentId: e.workspace.nodes[0].id,
    prompt: "分析",
    attachments: [upload("first contents")],
    config,
    requestId: randomUUID(),
  };
  const [first, same] = await Promise.all([
    e.scheduler.submit(e.workspace.id, input),
    e.scheduler.submit(e.workspace.id, structuredClone(input)),
  ]);
  assert.equal(first.id, same.id);
  await until(() => first.status === "completed");
  assert.equal(e.calls.length, 1);
  await assert.rejects(
    e.scheduler.submit(e.workspace.id, {
      ...input,
      attachments: [upload("changed contents")],
    }),
    /请求 ID/,
  );
  assert.equal(e.workspace.nodes.length, 2);
});

test("regeneration and failed-run retry retain attachments in each archived revision without leaking old answers", async (t) => {
  const e = await fixture(t);
  const first = await e.submit(e.workspace.nodes[0].id, [
    upload("PRESERVED_ATTACHMENT"),
  ]);
  const originals = structuredClone(first.attachmentData);
  e.failNext("Simulated provider failure");
  const second = await afterRunSettles(() =>
    e.scheduler.regenerate(e.workspace.id, first.id, {
      prompt: "修改后的问题",
      config,
      requestId: randomUUID(),
      expectedRevision: 0,
    }),
  );
  await until(() => second.status === "failed");
  assert.deepEqual(second.attachmentData, originals);
  assert.deepEqual(second.previousRuns?.[0].attachmentData, originals);
  assert.match(e.calls[1].prompt, /修改后的问题[\s\S]*PRESERVED_ATTACHMENT/);
  assert.doesNotMatch(
    JSON.stringify(e.calls[1].history),
    /Attachment test answer/,
  );
  const third = await afterRunSettles(() =>
    e.scheduler.retry(e.workspace.id, second.id, {
      requestId: randomUUID(),
      expectedRevision: 1,
    }),
  );
  await until(() => third.status === "completed");
  assert.equal(third.id, first.id);
  assert.equal(third.revision, 2);
  assert.deepEqual(third.attachmentData, originals);
  assert.equal(third.previousRuns?.length, 2);
  assert.ok(
    third.previousRuns?.every(
      (run) => JSON.stringify(run.attachmentData) === JSON.stringify(originals),
    ),
  );
  assert.match(e.calls[2].prompt, /PRESERVED_ATTACHMENT/);
});

test("regenerating an image node with a text-only model rejects before changing revisions, descendants, or directories", async (t) => {
  const e = await fixture(t);
  const parent = await e.submit(e.workspace.nodes[0].id, [
    {
      name: "sample.png",
      mediaType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5d8AAAAASUVORK5CYII=",
    },
  ]);
  const child = await e.submit(parent.id, [], "继续分析图片");
  const before = structuredClone(e.workspace.nodes);
  const previousCallCount = e.calls.length;
  let directoryPreparations = 0;
  t.mock.method(e.store, "prepareWorkingDirectory", async () => {
    directoryPreparations++;
    throw new Error("Should reject before preparing any working directory");
  });

  await assert.rejects(
    afterRunSettles(() =>
      e.scheduler.regenerate(e.workspace.id, parent.id, {
        prompt: "用另一个模型重新描述图片",
        config: { model: "test/text-only", thinking: "off" },
        requestId: randomUUID(),
        expectedRevision: parent.revision ?? 0,
      }),
    ),
    /不支持图片输入/,
  );

  assert.deepEqual(e.workspace.nodes, before);
  assert.equal(parent.revision ?? 0, 0);
  assert.equal(parent.status, "completed");
  assert.equal(parent.previousRuns, undefined);
  assert.equal(
    child.contextStale,
    before.find((node) => node.id === child.id)?.contextStale,
  );
  assert.equal(e.calls.length, previousCallCount);
  assert.equal(directoryPreparations, 0);
});

test("attachment-only API requests use the default question and remain idempotent, downloadable and exportable", async (t) => {
  const e = await fixture(t);
  const input = {
    parentId: e.workspace.nodes[0].id,
    prompt: "",
    attachments: [upload("仅附件内容")],
    config,
    requestId: randomUUID(),
  };
  const path = `/workspaces/${e.workspace.id}/nodes`;
  const first = await e.call("POST", path, input);
  assert.equal(first.status, 201, first.output.toString());
  const result = JSON.parse(first.output.toString());
  const node = e.workspace.nodes.find((item) => item.id === result.nodeId)!;
  await until(() => node.status === "completed");
  assert.equal(node.prompt, "请分析上传的附件。");
  const repeated = await e.call("POST", path, input);
  assert.equal(repeated.status, 201, repeated.output.toString());
  assert.equal(JSON.parse(repeated.output.toString()).nodeId, node.id);
  assert.equal(e.calls.length, 1);
  const downloaded = await e.call(
    "GET",
    `${path}/${node.id}/attachments/${node.attachments![0].id}`,
  );
  assert.equal(downloaded.status, 200, downloaded.output.toString());
  assert.equal(downloaded.output.toString(), "仅附件内容");
  const exported = await e.call("GET", `/workspaces/${e.workspace.id}/export`);
  assert.equal(exported.status, 200);
  assert.deepEqual(
    JSON.parse(exported.output.toString()).workspace.nodes[1].attachmentData,
    node.attachmentData,
  );
  const markdown = await e.call(
    "GET",
    `/workspaces/${e.workspace.id}/export?format=markdown&node=${node.id}`,
  );
  assert.equal(markdown.status, 200);
  assert.match(markdown.output.toString(), /notes.md/);
  const imported = await e.call("POST", "/workspaces/import", {
    data: JSON.parse(exported.output.toString()),
  });
  assert.equal(imported.status, 201, imported.output.toString());
  const importedWorkspace = e.store.workspace(
    JSON.parse(imported.output.toString()).workspaceId,
  );
  assert.deepEqual(
    importedWorkspace.nodes[1].attachmentData,
    node.attachmentData,
  );
  await afterRunSettles(() =>
    e.scheduler.deleteNode(e.workspace.id, node.id, {
      expectedRevision: 0,
      expectedNodeIds: [node.id],
    }),
  );
  const deleted = await e.call(
    "GET",
    `${path}/${node.id}/attachments/${node.attachments![0].id}`,
  );
  assert.equal(deleted.status, 404);
  assert.doesNotMatch(JSON.stringify(e.workspace), /仅附件内容/);
});

test("image originals reach the current run and are inherited as native image messages", async (t) => {
  const e = await fixture(t);
  const image: AttachmentUpload = {
    name: "sample.png",
    mediaType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  };
  const parent = await e.submit(e.workspace.nodes[0].id, [image], "描述图片");
  assert.equal(e.calls[0].attachments[0].data, image.data);
  assert.equal(e.calls[0].attachments[0].metadata.kind, "image");
  await e.submit(parent.id, [], "继续分析图片");
  const inheritedImages = e.calls[1].history.flatMap((message) =>
    message.role === "user" && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image")
      : [],
  );
  assert.equal(inheritedImages.length, 1);
  assert.equal(inheritedImages[0].data, image.data);
  assert.ok(!JSON.stringify(e.store.snapshot()).includes(image.data));
});
