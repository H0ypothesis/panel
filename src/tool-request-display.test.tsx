import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolRequestList } from "./ToolRequestList.tsx";

test("sent-node tool badges retain both explicit tools without duplicate labels or active buttons", () => {
  const html = renderToStaticMarkup(
    <ToolRequestList requests={["web_search", "computer_use", "web_search"]} />,
  );
  assert.equal((html.match(/联网搜索/g) ?? []).length, 1);
  assert.equal((html.match(/电脑控制/g) ?? []).length, 1);
  assert.match(html, /aria-label="本轮指定工具"/);
  assert.doesNotMatch(html, /<button|已引用的卡片|web_search|computer_use/);
});

test("ordinary nodes have no empty tool badge container", () => {
  assert.equal(renderToStaticMarkup(<ToolRequestList />), "");
  assert.equal(renderToStaticMarkup(<ToolRequestList requests={[]} />), "");
});
