import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  attachmentPrompt,
  imageContent,
  prepareAttachments,
} from "./attachments.ts";
import { buildContext } from "./context.ts";
import { createWorkspace } from "./seed.ts";
import type { StoredNode, StoredWorkspace } from "./store.ts";
import { importWorkspace } from "./workspace-import.ts";

const image = {
  name: "diagram.png",
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
};

async function fixture() {
  const workspace: StoredWorkspace = createWorkspace("附件探索", "保留原件");
  const root = workspace.nodes[0];
  const attachmentData = await prepareAttachments([
    {
      name: "notes.md",
      mediaType: "text/markdown",
      data: Buffer.from("附件中的独立研究证据").toString("base64"),
    },
    image,
  ]);
  const node: StoredNode = {
    ...structuredClone(root),
    id: "attachment-source",
    parentId: root.id,
    prompt: "请分析上传资料",
    response: "从上传资料得出的回答",
    status: "completed",
    revision: 1,
    contextIds: [root.id],
    attachmentData,
    attachments: attachmentData.map((file) => file.metadata),
    attachmentInputHash: "old-request-hash",
    requestId: "old-request-id",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: attachmentPrompt("请分析上传资料", attachmentData),
          },
          ...imageContent(attachmentData),
        ],
        timestamp: root.createdAt,
      },
      fauxAssistantMessage("从上传资料得出的回答"),
    ],
  };
  node.previousRuns = [
    { ...structuredClone(node), revision: 0, archivedAt: Date.now() },
  ];
  workspace.nodes.push(node);
  return { version: 1, workspace };
}

test("JSON imports retain attachment originals, image transcripts and old revisions without restoring request identity", async () => {
  const original = await fixture();
  const before = structuredClone(original);
  const imported = importWorkspace(original);
  const node = imported.nodes[1];
  assert.notEqual(node.id, original.workspace.nodes[1].id);
  assert.deepEqual(original, before);
  assert.deepEqual(
    node.attachmentData,
    original.workspace.nodes[1].attachmentData,
  );
  assert.deepEqual(node.attachments, original.workspace.nodes[1].attachments);
  assert.deepEqual(node.previousRuns?.[0].attachmentData, node.attachmentData);
  assert.equal(node.requestId, undefined);
  assert.equal(node.attachmentInputHash, undefined);
  assert.equal(node.previousRuns?.[0].attachmentInputHash, undefined);
  const context = buildContext(imported, node.id);
  assert.match(JSON.stringify(context.messages), /附件中的独立研究证据/);
  assert.match(
    JSON.stringify(context.messages),
    new RegExp(image.data.replace(/[+]/g, "\\+")),
  );
  const again = importWorkspace({ version: 1, workspace: imported });
  assert.deepEqual(again.nodes[1].attachmentData, node.attachmentData);
});

test("JSON import reconstructs display metadata from validated originals", async () => {
  const original = await fixture();
  original.workspace.nodes[1].attachments = [
    {
      ...original.workspace.nodes[1].attachments![0],
      name: "forged-display-name.txt",
    },
  ];
  const node = importWorkspace(original).nodes[1];
  assert.equal(node.attachments![0].name, "notes.md");
  assert.equal(node.attachments!.length, 2);
});

test("JSON import rejects missing originals, corrupt bytes and inconsistent attachment metadata or extracted text", async () => {
  const original = await fixture();
  for (const corrupt of [
    (node: StoredNode) => {
      delete node.attachmentData;
    },
    (node: StoredNode) => {
      node.attachmentData![0].data = "not-base64";
    },
    (node: StoredNode) => {
      node.attachmentData![0].metadata.size++;
    },
    (node: StoredNode) => {
      node.attachmentData![0].metadata.id = "wrong-id";
    },
    (node: StoredNode) => {
      node.attachmentData![0].text = "替换后的资料";
    },
    (node: StoredNode) => {
      node.previousRuns![0].attachmentData![1].data = "AAAA";
    },
  ]) {
    const source = structuredClone(original);
    corrupt(source.workspace.nodes[1]);
    assert.throws(() => importWorkspace(source), /附件|base64|图片|文件|导入/);
  }
});

test("legacy exports without attachments still import with no invented attachment state", () => {
  const workspace = createWorkspace("旧探索", "无附件");
  const node = importWorkspace({ version: 1, workspace }).nodes[0];
  assert.equal(node.attachments, undefined);
  assert.equal(node.attachmentData, undefined);
});

test("imports without provider transcripts reconstruct attachment text and native images in readable history", async () => {
  const original = await fixture();
  delete original.workspace.nodes[1].messages;
  const imported = importWorkspace(original);
  const content = buildContext(imported, imported.nodes[1].id).messages;
  assert.match(JSON.stringify(content), /以下是从 JSON 导入的历史轮次/);
  assert.match(JSON.stringify(content), /附件中的独立研究证据/);
  const images = content.flatMap((message) =>
    message.role === "user" && Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image")
      : [],
  );
  assert.equal(images.length, 1);
  assert.equal(images[0].data, image.data);
});
