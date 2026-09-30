import assert from "node:assert/strict";
import test from "node:test";
import {
  assessCuaTaskAction,
  remapTaskArguments,
  type CuaSnapshot,
} from "./cua-task-control.ts";
const target = { kind: "page" as const, pid: 12, windowId: 34, tabId: "tab" };
const snapshot = (refs: unknown[]): CuaSnapshot => ({
  scope: {
    id: "scope",
    label: "Example",
    target,
    origin: "https://example.com",
  },
  data: {
    status: "ok",
    mode: "snapshot",
    page: { url: "https://example.com/search" },
    refs,
  },
});
const search = {
  ref: "p1:1",
  role: "searchbox",
  name: "Search",
  visibility: "in_viewport",
  frame: "main",
  actions: ["click", "type"],
};
const input = (tool: string, args: Record<string, unknown>, t = target) => ({
  name: "computer_use_call",
  arguments: { tool, target: t, arguments: args },
});

test("official semantic search and pagination controls bypass review only within the observed page", () => {
  const s = snapshot([
    search,
    {
      ...search,
      ref: "p1:2",
      role: "button",
      name: "下一页",
      actions: ["click"],
    },
  ]);
  for (const c of [
    input("browser_type", { ref: "p1:1", text: "images", replace: true }),
    input("browser_click", { ref: "p1:1" }),
    input("browser_click", { ref: "p1:2" }),
  ])
    assert.equal(assessCuaTaskAction(c, s).routine, true);
  assert.equal(
    assessCuaTaskAction(
      input(
        "browser_type",
        { ref: "p1:1", text: "images" },
        { ...target, tabId: "other" },
      ),
      s,
    ).routine,
    false,
  );
});

test("coordinate clicks, generic inputs, new fields, hidden content and frames are not exempt", () => {
  const s = snapshot([search]);
  for (const args of [
    { x: 1, y: 2 },
    { ref: "old" },
    { ref: "p1:1", x: 1, y: 2 },
    { ref: "p1:1", submit: true },
  ])
    assert.equal(
      assessCuaTaskAction(input("browser_click", args), s).routine,
      false,
    );
  for (const override of [
    { role: "textbox", name: "Message" },
    { visibility: "offscreen" },
    { frame: "iframe" },
    { states: { disabled: true } },
  ])
    assert.equal(
      assessCuaTaskAction(
        input("browser_type", { ref: "p1:1", text: "hello" }),
        snapshot([{ ...search, ...override }]),
      ).routine,
      false,
    );
  for (const args of [
    { ref: "p1:1", text: "query\nsubmit" },
    { ref: "p1:1", text: "query", mode: "keystrokes" },
    { ref: "p1:1", text: "query", safe: true },
  ])
    assert.equal(
      assessCuaTaskAction(input("browser_type", args), s).routine,
      false,
    );
});

test("known consequential controls are routed to a human checkpoint", () => {
  for (const name of [
    "发送消息",
    "确认付款",
    "删除账户",
    "Publish",
    "Buy",
    "Grant permission",
  ]) {
    const result = assessCuaTaskAction(
      input("browser_click", { ref: "p1:1" }),
      snapshot([{ ...search, name, role: "button" }]),
    );
    assert.equal(result.routine, false);
    assert.equal(result.sensitive, true);
  }
  assert.equal(
    assessCuaTaskAction(
      input("browser_dialog", { action: "accept" }),
      snapshot([]),
    ).sensitive,
    true,
  );
});

test("links need an observed, unambiguous href at the exact authorized origin", () => {
  const anchor = {
    ref: "p1:2",
    node: "A",
    label: "href=/article/123",
    frame: "main",
  };
  const s = snapshot([anchor]);
  assert.equal(
    assessCuaTaskAction(input("browser_click", { ref: "p1:2" }), s).routine,
    true,
  );
  assert.equal(
    assessCuaTaskAction(
      input("browser_navigate", { url: "https://example.com/article/123" }),
      s,
    ).routine,
    true,
  );
  for (const label of [
    "href=https://evil.example/a",
    "href=https://example.com.evil.example/a",
    "href=javascript:alert(1)",
    "aria-label=href=/safe href=/delete",
    "href=/delete?id=1",
    "href=/auth?redirect=https://evil.example",
    "href=/setup.dmg",
    "href=https://user:pass@example.com/a",
  ])
    assert.equal(
      assessCuaTaskAction(
        input("browser_click", { ref: "p1:2" }),
        snapshot([{ ...anchor, label }]),
      ).routine,
      false,
      label,
    );
  assert.equal(
    assessCuaTaskAction(
      input("browser_navigate", { url: "https://example.com/unobserved" }),
      s,
    ).routine,
    false,
  );
});

test("native search controls use a bound element token, never current focus or embedded web content", () => {
  const native: CuaSnapshot = {
    scope: {
      id: "native",
      label: "Window",
      target: { kind: "window", pid: 12, windowId: 34 },
    },
    data: {
      snapshot_id: "s1234abcd",
      elements: [
        {
          element_token: "s1234abcd:1",
          element_index: 1,
          role: "AXTextField",
          label: "搜索",
          frame: { x: 0, y: 0, w: 30, h: 30 },
        },
      ],
    },
  };
  const call = {
    name: "computer_use_call",
    arguments: {
      target: native.scope.target,
      tool: "type_text",
      arguments: { element_token: "s1234abcd:1", text: "hello" },
    },
  };
  assert.equal(assessCuaTaskAction(call, native).routine, true);
  assert.equal(
    assessCuaTaskAction(
      {
        ...call,
        arguments: { ...call.arguments, arguments: { text: "hello" } },
      },
      native,
    ).routine,
    false,
  );
  (native.data.elements as Record<string, unknown>[])[0].in_web_content = true;
  assert.equal(assessCuaTaskAction(call, native).routine, false);
});

test("dispatch remaps only one unchanged element across actual new snapshots", () => {
  const before = snapshot([search]);
  assert.deepEqual(
    remapTaskArguments(
      { ref: "p1:1", text: "x" },
      before,
      snapshot([{ ...search, ref: "p2:1" }]),
    ),
    { ref: "p2:1", text: "x" },
  );
  for (const refs of [
    [],
    [{ ...search, name: "Pay", ref: "p2:1" }],
    [
      { ...search, ref: "p2:1" },
      { ...search, ref: "p2:2" },
    ],
  ])
    assert.throws(
      () => remapTaskArguments({ ref: "p1:1" }, before, snapshot(refs)),
      /变化|不唯一/,
    );
});

test("iframe links and synthetic clicks cannot enter the routine task fast path", () => {
  const anchor = {
    ref: "p1:1",
    node: "A",
    label: "href=/article",
    frame: "iframe",
  };
  assert.equal(
    assessCuaTaskAction(
      input("browser_navigate", { url: "https://example.com/article" }),
      snapshot([anchor]),
    ).routine,
    false,
  );
  assert.equal(
    assessCuaTaskAction(
      input("browser_click", { ref: "p1:1", input_route: "dom_event" }),
      snapshot([{ ...anchor, frame: "main" }]),
    ).routine,
    false,
  );
});
