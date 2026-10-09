import assert from "node:assert/strict";
import test from "node:test";
import { selectDeliveredFiles } from "./delivered-files.ts";
import { createWorkspace } from "./seed.ts";
import type { StoredNode } from "./store.ts";
import type { Message } from "@earendil-works/pi-ai";

const paths = [
  "report.html",
  "images/figure.png",
  "fetch.py",
  "manifest.json",
  "debug.py",
];
const files = paths.map((path) => ({ path, absolute: `/work/${path}` }));
const node = (response: string): StoredNode => ({
  ...createWorkspace("test", "").nodes[0],
  status: "completed",
  response,
});
const select = (response: string) =>
  selectDeliveredFiles(files, node(response)).map((file) => file.path);
const assistant = (text: string, stopReason = "stop", tool = false) =>
  ({
    role: "assistant",
    stopReason,
    content: [
      { type: "text", text },
      ...(tool
        ? [
            {
              type: "toolCall",
              id: "write",
              name: "write",
              arguments: { path: "fetch.py" },
            },
          ]
        : []),
    ],
  }) as Message;

test("only the final answer can select deliverables; progress, thinking and tools cannot", () => {
  const n = node("文件：`fetch.py`\n打开 `report.html`");
  n.messages = [
    assistant("文件：`fetch.py`", "toolUse", true),
    assistant(
      "<think>交付 `manifest.json`</think>打开 `report.html`。配套资源 `images/figure.png`。",
    ),
  ];
  assert.deepEqual(
    selectDeliveredFiles(files, n).map((file) => file.path),
    ["report.html"],
  );
  n.messages.push(assistant("文件：`fetch.py`", "toolUse", true));
  assert.deepEqual(selectDeliveredFiles(files, n), []);
  n.messages = [assistant("文件：`report.html`", "error")];
  assert.deepEqual(selectDeliveredFiles(files, n), []);
});

test("explicit delivery sections select exactly the declared outputs and end at the next peer heading", () => {
  assert.deepEqual(
    select(
      "打开 `fetch.py`\n\n### 交付文件\n- `report.html`\n\n### 说明\n打开 `manifest.json`",
    ),
    ["report.html"],
  );
  assert.deepEqual(
    select("### 交付文件\n- [图](images/figure.png)\n- `debug.py`"),
    ["images/figure.png", "debug.py"],
  );
  assert.deepEqual(
    select("### 交付文件\n- `not-created.pdf`\n\n### 说明\n打开 `report.html`"),
    [],
  );
});

test("legacy delivery cues support reports, scripts, images, links and fenced paths", () => {
  assert.deepEqual(select("完整报告：`report.html`"), ["report.html"]);
  assert.deepEqual(select("脚本：`fetch.py`"), ["fetch.py"]);
  assert.deepEqual(select("下载图片：[主图](images/figure.png)"), [
    "images/figure.png",
  ]);
  assert.deepEqual(
    select("**网页版（HTML，浏览器打开）**\n```\n/work/report.html\n```"),
    ["report.html"],
  );
  assert.deepEqual(select("文件路径：\n\n```\n/work/report.html\n```"), [
    "report.html",
  ]);
  assert.deepEqual(select("`report.html`"), ["report.html"]);
  assert.deepEqual(select("文件：report.html（浏览器打开）"), ["report.html"]);
  assert.deepEqual(
    select("### 交付文件\n- [网页][report]\n\n[report]: report.html"),
    ["report.html"],
  );
});

test("incidental mentions, dependencies, remote links, quotes and code examples are not deliveries", () => {
  for (const response of [
    "处理脚本 `fetch.py` 已运行。",
    "图片 `images/figure.png` 较大。",
    "下载的临时文件 `manifest.json` 已删除。",
    "网页依赖 `images/figure.png`。",
    "[下载报告](https://example.com/report.html)",
    "打开 [report.html](https://example.com/report.html)",
    "### 交付文件\n- [report.html][remote]\n\n[remote]: https://example.com/report.html",
    "> 文件：`report.html`",
    "```python\nopen('fetch.py')\n```",
    "<tool_call>文件：report.html</tool_call>",
    "这里没有交付文件。",
  ])
    assert.deepEqual(select(response), [], response);
  assert.deepEqual(
    select("- 文件：`report.html`\n- 处理脚本 `fetch.py` 已运行。"),
    ["report.html"],
  );
});

test("qualified paths and boundaries avoid guesses between duplicate or unrelated filenames", () => {
  const candidates = [
    { path: "a/report.html", absolute: "/work/a/report.html" },
    { path: "b/report.html", absolute: "/work/b/report.html" },
  ];
  assert.deepEqual(
    selectDeliveredFiles(candidates, node("文件：`report.html`")),
    [],
  );
  assert.deepEqual(
    selectDeliveredFiles(candidates, node("文件：`b/report.html`")),
    [candidates[1]],
  );
  assert.deepEqual(
    selectDeliveredFiles(candidates, node("打开 `other/report.html`")),
    [],
  );
  assert.deepEqual(select("打开 `report.html.bak`"), []);
  assert.deepEqual(select("打开 `./report.html`"), ["report.html"]);
  assert.deepEqual(select("打开 [报告](file:///work/report.html)"), [
    "report.html",
  ]);
});

test("streaming, failed and cancelled runs do not present process files as completed outputs", () => {
  for (const status of ["running", "failed", "cancelled"] as const)
    assert.deepEqual(
      selectDeliveredFiles(files, {
        ...node("### 交付文件\n- `report.html`"),
        status,
      }),
      [],
    );
});

test("records lacking a final transcript require an explicit delivery section after tools ran", () => {
  const n = node("过程中生成文件：`fetch.py`。最后已完成网页。");
  n.toolCalls = [
    {
      id: "write",
      name: "write",
      status: "completed",
      arguments: { path: "fetch.py" },
      startedAt: 1,
    },
  ];
  assert.deepEqual(selectDeliveredFiles(files, n), []);
  n.response = "### 交付文件\n- `report.html`";
  assert.deepEqual(
    selectDeliveredFiles(files, n).map((file) => file.path),
    ["report.html"],
  );
});
