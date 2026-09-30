import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolCall } from "../shared/types";
import { ToolActivity } from "./CodingControls.tsx";
import { ToolScreenshots } from "./ComputerUseTools.tsx";
import { toolImageUrl, toolWaitLabel } from "./computer-use.ts";

const imageUrl =
  "/api/workspaces/workspace/nodes/node/tool-images/tool/0?revision=2";
const call = (changes: Partial<ToolCall> = {}): ToolCall => ({
  id: "tool",
  name: "computer_use_call",
  arguments: {
    tool: "click",
    target: { windowId: 42 },
    arguments: { x: 10, y: 20 },
  },
  status: "awaiting_approval",
  startedAt: 1,
  computerUse: {
    scope: "window",
    targetLabel: "Safari · 项目文档",
    app: "Safari",
    windowId: 42,
    mode: "background",
    overlay: true,
  },
  ...changes,
});

test("computer actions expose their operation and exact target without generic batch approval", () => {
  const html = renderToStaticMarkup(
    <ToolActivity calls={[call()]} onDecision={async () => {}} />,
  );
  assert.match(html, /点击界面/);
  assert.match(html, /Safari · 项目文档/);
  assert.match(html, /后台操作/);
  assert.match(html, /光标覆盖层已开启/);
  assert.match(html, /批准这次操作/);
  assert.match(html, /拒绝/);
  assert.doesNotMatch(html, /批量同意|将修改工作目录中的文件/);
});

test("computer target waits identify their scope and preserve ordinary file waits", () => {
  const waiting = call({
    status: "running",
    waitingFor: "此窗口正在由另一张卡片使用。",
  });
  const html = renderToStaticMarkup(
    <ToolActivity calls={[waiting]} onDecision={async () => {}} />,
  );
  assert.match(html, /等待窗口/);
  assert.match(html, /此窗口正在由另一张卡片使用/);
  assert.doesNotMatch(html, /等待文件/);
  assert.equal(
    toolWaitLabel({ ...waiting, computerUse: { scope: "page" } }),
    "等待页面",
  );
  assert.equal(
    toolWaitLabel({ ...waiting, computerUse: { scope: "desktop" } }),
    "等待桌面",
  );
  assert.equal(toolWaitLabel({ ...waiting, name: "read" }), "等待文件");
  assert.equal(toolWaitLabel({ ...waiting, name: "bash" }), "等待文件操作");
});

test("tool screenshots only load Panel's revision-specific image endpoint", () => {
  assert.equal(toolImageUrl(imageUrl), imageUrl);
  for (const url of [
    "https://remote.example/image.png",
    "//remote.example/image.png",
    "/api/other",
    imageUrl.replace("?revision=2", ""),
    `${imageUrl}&redirect=https://remote.example`,
    `${imageUrl}#fragment`,
    imageUrl.replace("workspace", "../.."),
    imageUrl.replace("/api/", "/api/\\"),
  ])
    assert.equal(toolImageUrl(url), null, url);
  const html = renderToStaticMarkup(
    <ToolScreenshots
      call={call({
        images: [
          {
            id: "valid",
            url: imageUrl,
            mimeType: "image/png",
            width: 1440,
            height: 900,
          },
          {
            id: "remote",
            url: "https://remote.example/tracker.png",
            mimeType: "image/png",
          },
          { id: "vector", url: imageUrl, mimeType: "image/svg+xml" },
        ],
      })}
    />,
  );
  assert.match(html, /放大Safari · 项目文档 · 操作截图/);
  assert.match(html, /1440/);
  assert.equal((html.match(/<img /g) ?? []).length, 1);
  assert.doesNotMatch(html, /remote\.example|image\/svg/);
});
