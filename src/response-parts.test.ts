import assert from "node:assert/strict";
import test from "node:test";
import { responseParts, responseText } from "../shared/response-parts.ts";

test("separates multiple thinking blocks and keeps answer Markdown intact", () => {
  const response =
    "<think>Plan **first**.</think>## Answer\nA<think>Check.</think> and B";
  assert.deepEqual(responseParts(response), [
    { type: "thinking", text: "Plan **first**.", complete: true },
    { type: "text", text: "## Answer\nA" },
    { type: "thinking", text: "Check.", complete: true },
    { type: "text", text: " and B" },
  ]);
  assert.equal(responseText(response), "## Answer\nA and B");
});

test("never leaks thinking or partial tag prefixes into the streamed answer", () => {
  const thought = "<think>检查条件</think>";
  for (let length = 1; length <= thought.length; length++) {
    const prefix = thought.slice(0, length);
    assert.equal(responseText(prefix, true), "", prefix);
    assert.ok(
      responseParts(prefix, true).every((part) => !part.text.includes("<")),
      prefix,
    );
  }
  assert.deepEqual(responseParts("<think>未结束", true), [
    { type: "thinking", text: "未结束", complete: false },
  ]);
  assert.equal(responseText("<think>未结束"), "");
  assert.deepEqual(responseParts("<think>", true), [
    { type: "thinking", text: "", complete: false },
  ]);
});

test("preserves think tags in fenced, inline, indented, and escaped code examples", () => {
  const examples = [
    "```xml\n<think>example</think>\n```",
    "~~~xml\n<think>example</think>\n~~~",
    "> ~~~xml\n> <think>example</think>\n> ~~~",
    "- ~~~xml\n  <think>example</think>\n  ~~~",
    "````md\n```xml\n<think>example</think>\n```\n````",
    "Use `<think>example</think>` here.",
    "Use `` `<think>example</think>` `` here.",
    "    <think>example</think>\n",
    "\\<think>example\\</think>",
    "&lt;think&gt;example&lt;/think&gt;",
  ];
  for (const example of examples) {
    assert.deepEqual(
      responseParts(example),
      [{ type: "text", text: example }],
      example,
    );
    assert.equal(responseText(example, true), example);
  }
  assert.equal(
    responseText("```xml\n<think>unfinished", true),
    "```xml\n<think>unfinished",
  );
});

test("handles case, whitespace, nesting and ordinary less-than text", () => {
  assert.deepEqual(responseParts("<THINK >a<think>b</think>c</THINK >结果"), [
    { type: "thinking", text: "abc", complete: true },
    { type: "text", text: "结果" },
  ]);
  for (const text of [
    "a < b",
    "<thinking>literal</thinking>",
    "</think>orphan",
    "final <thi",
  ])
    assert.equal(responseText(text), text);
});

test("a tag inside a thinking code example does not close the thinking block", () => {
  const thought = "Explain `</think>` and:\n```xml\n</think>\n```\nDone.";
  assert.deepEqual(responseParts(`<think>${thought}</think>Answer`), [
    { type: "thinking", text: thought, complete: true },
    { type: "text", text: "Answer" },
  ]);
});

const leakedTool =
  '<tool_call><function=edit><parameter=path>index.html</parameter><parameter=edits>[{"oldText":"<hr>\\n</parameter>\\n</head>","newText":"<!--ANCHOR-->"}]</parameter></function></tool_call>';

test("separates MiMo's malformed tool text from answers without interpreting its arguments", () => {
  assert.deepEqual(responseParts(`第一部分完成。${leakedTool}继续追加。`), [
    { type: "text", text: "第一部分完成。" },
    { type: "tool-call", text: leakedTool, complete: true },
    { type: "text", text: "继续追加。" },
  ]);
  assert.equal(
    responseText(`第一部分完成。${leakedTool}继续追加。`),
    "第一部分完成。继续追加。",
  );
});

test("split tool tags and incomplete arguments never flash in the streamed answer", () => {
  for (let length = 1; length <= leakedTool.length; length++) {
    assert.equal(
      responseText(`准备修改。${leakedTool.slice(0, length)}`, true),
      "准备修改。",
      `chunk ${length}`,
    );
  }
  assert.deepEqual(responseParts('<tool_call>{"name":"edit"', true), [
    { type: "tool-call", text: '<tool_call>{"name":"edit"', complete: false },
  ]);
  assert.equal(responseText('<tool_call>{"name":"edit"'), "");
});

test("tool examples remain literal in Markdown code and escaped text", () => {
  for (const example of [
    '`<tool_call>{"name":"edit"}</tool_call>`',
    "```xml\n" + leakedTool + "\n```",
    "> ~~~xml\n> " + leakedTool + "\n> ~~~",
    "\\<tool_call>example\\</tool_call>",
    "&lt;tool_call&gt;example&lt;/tool_call&gt;",
  ])
    assert.deepEqual(responseParts(example), [{ type: "text", text: example }]);
});

test("tool payloads containing Markdown or think tags stay inert and multiple calls stay separate", () => {
  const payload =
    "<tool_call><function=write><parameter=content><think>literal</think>```</parameter></function></tool_call>";
  const parts = responseParts(
    `<think>检查${payload}完成</think>答案${leakedTool}结束`,
  );
  assert.equal(parts.filter((part) => part.type === "tool-call").length, 2);
  assert.equal(
    parts
      .filter((part) => part.type === "thinking")
      .map((part) => part.text)
      .join(""),
    "检查完成",
  );
  assert.ok(
    parts
      .filter((part) => part.type === "thinking")
      .every((part) => part.complete),
  );
  assert.equal(
    responseText(`<think>检查${payload}完成</think>答案${leakedTool}结束`),
    "答案结束",
  );
});
