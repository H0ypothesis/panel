import assert from "node:assert/strict";
import test from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  type Message,
} from "@earendil-works/pi-ai";
import { attachmentPrompt, prepareAttachments } from "./attachments.ts";
import { PiRuntime } from "./runtime.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5d8AAAAASUVORK5CYII=";
const config = { model: "openai/attachment-test", thinking: "off" as const };
const signal = () => new AbortController().signal;

function fixture(supportsImages = true) {
  const faux = fauxProvider({
    provider: "openai",
    models: [
      {
        id: "attachment-test",
        input: supportsImages ? ["text", "image"] : ["text"],
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    tokensPerSecond: 1000000,
    tokenSize: { min: 2000, max: 3000 },
  });
  const registry = createModels();
  registry.setProvider(faux.provider);
  return { faux, runtime: new PiRuntime(registry) };
}

function files() {
  return prepareAttachments([
    { name: "pixel.png", mediaType: "image/png", data: png },
    {
      name: "notes.txt",
      mediaType: "text/plain",
      data: Buffer.from("Attached reference text").toString("base64"),
    },
  ]);
}

test("PiRuntime sends uploaded images as native user blocks and preserves raw messages", async () => {
  const { faux, runtime } = fixture();
  const attachments = await files();
  const prompt = attachmentPrompt("Describe these files", attachments);
  const snapshots: Message[][] = [];
  faux.setResponses([
    (context) => {
      const user = context.messages.find((message) => message.role === "user");
      assert.ok(user && Array.isArray(user.content));
      assert.deepEqual(user.content, [
        { type: "text", text: prompt },
        { type: "image", mimeType: "image/png", data: png },
      ]);
      assert.match(prompt, /Attached reference text/);
      assert.match(prompt, /pixel.png/);
      assert.equal(prompt.includes(png), false);
      return fauxAssistantMessage("The files were received.");
    },
  ]);
  const result = await runtime.run(
    config,
    [],
    prompt,
    signal(),
    () => {},
    undefined,
    {
      autoCompact: false,
      sources: [{ nodeId: "current", revision: 0, messageCount: 0 }],
      attachments,
      async onMessages(messages) {
        snapshots.push(structuredClone(messages));
      },
    },
  );
  assert.equal(faux.state.callCount, 1);
  assert.equal(result.response, "The files were received.");
  assert.deepEqual(snapshots.at(-1), result.messages);
  assert.equal(result.messages[0].role, "user");
  assert.ok(Array.isArray(result.messages[0].content));
  assert.deepEqual(result.messages[0].content.at(-1), {
    type: "image",
    mimeType: "image/png",
    data: png,
  });
});

test("PiRuntime keeps ancestor image blocks in branch history without attaching them to the new message", async () => {
  const { faux, runtime } = fixture();
  const history: Message[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "Earlier image" },
        { type: "image", mimeType: "image/png", data: png },
      ],
      timestamp: 1,
    },
    fauxAssistantMessage("Earlier answer"),
  ];
  const original = structuredClone(history);
  faux.setResponses([
    (context) => {
      const users = context.messages.filter(
        (message) => message.role === "user",
      );
      assert.equal(users.length, 2);
      assert.deepEqual(users[0].content, history[0].content);
      assert.deepEqual(users[1].content, [{ type: "text", text: "Follow up" }]);
      return fauxAssistantMessage("Follow-up answer");
    },
  ]);
  const result = await runtime.run(
    config,
    history,
    "Follow up",
    signal(),
    () => {},
    undefined,
    {
      autoCompact: false,
      sources: [
        { nodeId: "ancestor", revision: 0, messageCount: 2 },
        { nodeId: "current", revision: 0, messageCount: 0 },
      ],
    },
  );
  assert.deepEqual(history, original);
  assert.equal(result.messages.length, 2);
  assert.equal(JSON.stringify(result.messages).includes(png), false);
});

test("PiRuntime rejects current and ancestor images for text-only models before provider calls", async () => {
  const { faux, runtime } = fixture(false);
  faux.setResponses([fauxAssistantMessage("Should not execute")]);
  const attachments = await files();
  await assert.rejects(
    runtime.run(config, [], "Inspect image", signal(), () => {}, undefined, {
      autoCompact: false,
      sources: [{ nodeId: "current", revision: 0, messageCount: 0 }],
      attachments,
    }),
    /不支持图片输入/,
  );
  await assert.rejects(
    runtime.run(
      config,
      [
        {
          role: "user",
          content: [{ type: "image", mimeType: "image/png", data: png }],
          timestamp: 1,
        },
      ],
      "Continue",
      signal(),
      () => {},
    ),
    /不支持图片输入/,
  );
  assert.equal(faux.state.callCount, 0);
});
