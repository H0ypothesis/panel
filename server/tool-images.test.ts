import assert from "node:assert/strict";
import test from "node:test";
import type { ImageContent, Message } from "@earendil-works/pi-ai";
import {
  MAX_TOOL_IMAGE_BYTES,
  readToolImage,
  toolImageReferences,
} from "./tool-images.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5d8AAAAASUVORK5CYII=",
  "base64",
);
const image = (
  data = png.toString("base64"),
  mimeType = "image/png",
): ImageContent => ({ type: "image", data, mimeType });
const messages = (
  content: (ImageContent | { type: "text"; text: string })[] = [image()],
  toolCallId = "tool",
): Message[] => [
  {
    role: "toolResult",
    toolCallId,
    toolName: "computer_use_call",
    content,
    isError: false,
    timestamp: 1,
  },
];

test("image references bind encoded workspace, node, call and revision without inline data", () => {
  const input = messages(undefined, "tool/?x");
  const original = structuredClone(input);
  const refs = toolImageReferences("work space", "node/1", 7, input, "tool/?x");
  assert.deepEqual(refs, [
    {
      id: "tool/?x:0:7",
      url: "/api/workspaces/work%20space/nodes/node%2F1/tool-images/tool%2F%3Fx/0?revision=7",
      mimeType: "image/png",
      width: 1,
      height: 1,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(refs), /iVBOR|"data"/);
  assert.deepEqual(readToolImage(input, "tool/?x", 0), {
    mimeType: "image/png",
    data: png,
  });
  assert.notEqual(
    toolImageReferences("work space", "node/1", 8, input, "tool/?x")?.[0].url,
    refs?.[0].url,
  );
  assert.deepEqual(input, original);
});

test("image ordinals survive text and rejected image blocks without aliasing targets", () => {
  const input = messages([
    { type: "text", text: "screen" },
    image("bad"),
    image(),
    image(),
  ]);
  assert.deepEqual(
    toolImageReferences("w", "n", 0, input, "tool")?.map((ref) => ref.url),
    [
      "/api/workspaces/w/nodes/n/tool-images/tool/1?revision=0",
      "/api/workspaces/w/nodes/n/tool-images/tool/2?revision=0",
    ],
  );
  assert.equal(readToolImage(input, "tool", 0), undefined);
  assert.deepEqual(readToolImage(input, "tool", 1)?.data, png);
  for (const index of [-1, 0.5, NaN, Infinity, 3])
    assert.equal(readToolImage(input, "tool", index), undefined);
  assert.equal(readToolImage(input, "other", 1), undefined);
  assert.equal(readToolImage(undefined, "tool", 0), undefined);
  assert.equal(
    toolImageReferences(
      "w",
      "n",
      0,
      messages([{ type: "text", text: "no screenshot" }]),
      "tool",
    ),
    undefined,
  );
});

test("only raster MIME types with their matching signatures are exposed", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 4, 0, 0, 0xff, 0xd9]);
  const webp = Buffer.alloc(24);
  webp.write("RIFF", 0);
  webp.writeUInt32LE(16, 4);
  webp.write("WEBPVP8 ", 8);
  webp.writeUInt32LE(4, 16);
  assert.deepEqual(
    readToolImage(
      messages([image(jpeg.toString("base64"), "image/jpeg")]),
      "tool",
      0,
    )?.data,
    jpeg,
  );
  assert.deepEqual(
    readToolImage(
      messages([image(webp.toString("base64"), "image/webp")]),
      "tool",
      0,
    )?.data,
    webp,
  );
  for (const mime of [
    "text/html",
    "image/svg+xml",
    "image/gif",
    "image/jpg",
    "image/png; charset=utf-8",
    "image/jpeg",
    "image/webp",
  ]) {
    assert.equal(
      toolImageReferences(
        "w",
        "n",
        0,
        messages([image(undefined, mime)]),
        "tool",
      ),
      undefined,
      mime,
    );
  }
  assert.equal(
    readToolImage(
      messages([
        image(Buffer.from("<script>alert(1)</script>").toString("base64")),
      ]),
      "tool",
      0,
    ),
    undefined,
  );
  assert.equal(
    readToolImage(
      messages([image(png.subarray(0, 8).toString("base64"))]),
      "tool",
      0,
    ),
    undefined,
  );
  webp.writeUInt32LE(1, 4);
  assert.equal(
    readToolImage(
      messages([image(webp.toString("base64"), "image/webp")]),
      "tool",
      0,
    ),
    undefined,
  );
});

test("malformed, noncanonical, oversized and injected base64 is rejected", () => {
  const base64 = png.toString("base64");
  for (const data of [
    "",
    base64.replace(/=$/, ""),
    `${base64}\n`,
    `data:image/png;base64,${base64}`,
    `${base64}<script>`,
    base64.replace(/.$/, "!"),
    base64.replace(/I=$/, "J="),
    "A===",
    "====",
    "A".repeat(Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) * 4 + 4),
  ]) {
    const input = messages([image(data)]);
    assert.equal(readToolImage(input, "tool", 0), undefined);
    assert.equal(toolImageReferences("w", "n", 0, input, "tool"), undefined);
  }
});

test("cache validation is invalidated if a persisted block changes", () => {
  const block = image();
  const input = messages([block]);
  assert.equal(toolImageReferences("w", "n", 0, input, "tool")?.length, 1);
  block.mimeType = "text/html";
  assert.equal(readToolImage(input, "tool", 0), undefined);
  block.mimeType = "image/png";
  block.data = "broken";
  assert.equal(toolImageReferences("w", "n", 0, input, "tool"), undefined);
  block.data = png.toString("base64");
  assert.deepEqual(readToolImage(input, "tool", 0)?.data, png);
});

test("ambiguous results, unrelated message roles, and invalid run identities never yield images", () => {
  const input = messages();
  assert.equal(readToolImage([...input, ...input], "tool", 0), undefined);
  assert.equal(
    readToolImage(
      [{ role: "user", content: [image()], timestamp: 1 }],
      "tool",
      0,
    ),
    undefined,
  );
  for (const revision of [-1, 0.5, Infinity, NaN])
    assert.equal(
      toolImageReferences("w", "n", revision, input, "tool"),
      undefined,
    );
  for (const id of ["", ".", "..", "\ud800"])
    assert.equal(toolImageReferences(id, "n", 0, input, "tool"), undefined);
});
