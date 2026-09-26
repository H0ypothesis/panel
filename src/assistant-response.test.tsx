import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantResponse } from "./AssistantResponse.tsx";

test("active thinking is expanded and Markdown answers render outside its frame", () => {
  const html = renderToStaticMarkup(
    <AssistantResponse response="<think>思考内容" status="running" />,
  );
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /思考中/);
  assert.doesNotMatch(html, /&lt;think&gt;/);
  const completed = renderToStaticMarkup(
    <AssistantResponse
      response="<think>思考内容</think>**回答正文**"
      status="completed"
    />,
  );
  assert.match(completed, /aria-expanded="false"/);
  assert.match(
    completed,
    /<\/section><div class="markdown"><p><strong>回答正文<\/strong>/,
  );
});

test("native thinking and tagged thinking share one frame without enabling raw HTML", () => {
  const html = renderToStaticMarkup(
    <AssistantResponse
      response={'<think>补充思考</think><script>alert("x")</script>答案'}
      thinking={{ text: "原生思考", active: false }}
      status="completed"
    />,
  );
  assert.equal((html.match(/aria-label="思考过程"/g) ?? []).length, 1);
  assert.match(html, /原生思考/);
  assert.match(html, /补充思考/);
  assert.doesNotMatch(html, /<script>/);
});

test("plain answers have no empty thinking frame and stopped thinking never spins", () => {
  assert.doesNotMatch(
    renderToStaticMarkup(
      <AssistantResponse response="普通回答" status="completed" />,
    ),
    /thinking-box/,
  );
  const stopped = renderToStaticMarkup(
    <AssistantResponse response="<think>中途停止" status="cancelled" />,
  );
  assert.match(stopped, /已中断/);
  assert.doesNotMatch(stopped, /思考中|class="spin"/);
});

test("raw tool text is collapsed, inert, and never rendered as answer Markdown or actionable tools", () => {
  const raw =
    "<tool_call><function=edit><parameter=path>index.html</parameter><parameter=edits><script>alert(1)</script></parameter></function></tool_call>";
  const html = renderToStaticMarkup(
    <AssistantResponse response={`开始。${raw}完成。`} status="running" />,
  );
  assert.match(html, /<div class="markdown"><p>开始。完成。<\/p>/);
  assert.match(html, /<details class="response-tool-text">/);
  assert.match(html, /工具调用原文/);
  assert.match(html, /&lt;tool_call&gt;/);
  assert.doesNotMatch(html, /<script>|同意|拒绝|<details[^>]* open/);
});
