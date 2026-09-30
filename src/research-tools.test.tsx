import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolActivity } from "./CodingControls";

test("research approvals show the real network/cache action and native arguments", () => {
  for (const [name, args, label, target] of [
    [
      "web_search",
      { queries: ["streaming docs", "limits"] },
      "搜索网页",
      "streaming docs；limits",
    ],
    [
      "fetch_content",
      { urls: ["https://example.com/docs"] },
      "获取网页原文",
      "https://example.com/docs",
    ],
    [
      "source_check",
      { claim: "Streaming supported" },
      "收集来源证据",
      "Streaming supported",
    ],
    [
      "get_search_content",
      { responseId: "source-123" },
      "读取研究缓存",
      "source-123",
    ],
  ] as const) {
    const html = renderToStaticMarkup(
      <ToolActivity
        calls={[
          {
            id: name,
            name,
            arguments: args,
            status: "awaiting_approval",
            startedAt: 1,
          },
        ]}
        onDecision={async () => {}}
      />,
    );
    assert.ok(html.includes(label));
    assert.ok(html.includes(target));
    assert.doesNotMatch(html, /批准后将修改工作目录中的文件/);
    if (name === "get_search_content") assert.match(html, /不发起新的网络请求/);
  }
});
