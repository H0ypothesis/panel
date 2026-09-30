import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolCall, TurnNode } from "../shared/types";
import { ToolActivity } from "./CodingControls";
import { canShowComputerUseTakeover, ToolRequestList } from "./ToolRequestList";

const call = (changes: Partial<ToolCall> = {}): ToolCall => ({
  id: "tool",
  name: "computer_use_call",
  arguments: { tool: "get_window_state", arguments: { window_id: 4 } },
  status: "completed",
  startedAt: 1,
  ...changes,
});
const node = (changes: Partial<TurnNode> = {}): TurnNode => ({
  id: "node",
  revision: 2,
  parentId: "root",
  prompt: "查看当前窗口",
  response: "",
  status: "running",
  config: { model: "test/model", thinking: "off" },
  color: "blue",
  position: { x: 0, y: 0 },
  contextIds: [],
  createdAt: 1,
  ...changes,
});
const controls = (
  current: TurnNode,
  props: Partial<Parameters<typeof ToolRequestList>[0]> = {},
) =>
  renderToStaticMarkup(
    <ToolRequestList
      requests={current.toolRequests}
      node={current}
      onComputerUseTakeoverChange={() => {}}
      {...props}
    />,
  );

test("active explicit CUA cards show one computer badge and a default-off scoped takeover switch", () => {
  for (const status of ["queued", "running"] as const) {
    const current = node({
      status,
      toolRequests: ["web_search", "computer_use", "computer_use"],
    });
    const html = controls(current);
    assert.equal(canShowComputerUseTakeover(current), true);
    assert.equal((html.match(/电脑控制/g) ?? []).length, 1);
    assert.equal((html.match(/联网搜索/g) ?? []).length, 1);
    assert.match(html, /role="switch" aria-label="CUA 接管"/);
    assert.match(html, /仅本卡片本轮/);
    assert.match(
      html,
      /查看、截图、后台滚动、移动指针免逐次安全模型审核；点击和输入仍审核/,
    );
    assert.doesNotMatch(html, /checked=""|disabled=""/);
  }
});

test("model-invoked CUA exposes takeover even without an explicit mention", () => {
  for (const name of [
    "computer_use_tools",
    "computer_use_call",
    "computer_use_release",
  ]) {
    const html = controls(node({ toolCalls: [call({ name })] }));
    assert.equal((html.match(/电脑控制/g) ?? []).length, 1);
    assert.match(html, /role="switch"/);
  }
  for (const name of ["read", "fetch_content", "computer_use_unknown"]) {
    assert.equal(controls(node({ toolCalls: [call({ name })] })), "");
  }
  assert.equal(controls(node()), "");
});

test("terminal cards and historical context never expose a live takeover switch", () => {
  for (const status of ["root", "completed", "failed", "cancelled"] as const) {
    const current = node({
      status,
      computerUseTakeover: true,
      toolRequests: ["computer_use"],
      toolCalls: [call()],
    });
    assert.equal(canShowComputerUseTakeover(current), false);
    const html = controls(current);
    assert.match(html, /电脑控制/);
    assert.doesNotMatch(html, /role="switch"|CUA 接管|checked=""/);
  }
  assert.doesNotMatch(
    renderToStaticMarkup(<ToolRequestList requests={["computer_use"]} />),
    /role="switch"|CUA 接管/,
  );
});

test("takeover reflects server state and disables a pending mutation or disconnected control", () => {
  const current = node({
    computerUseTakeover: true,
    toolCalls: [call()],
  });
  const active = controls(current);
  assert.match(active, /checked=""/);
  assert.doesNotMatch(active.match(/<input[^>]+>/)?.[0] ?? "", /disabled=""/);
  const pending = controls(current, { takeoverBusy: true });
  assert.match(pending, /checked=""/);
  assert.match(pending, /disabled=""/);
  assert.match(pending, /aria-busy="true"/);
  assert.match(pending, /正在更新/);
  assert.match(controls(current, { takeoverDisabled: true }), /disabled=""/);
});

test("existing review and manual approval explain that switching affects subsequent eligible calls", () => {
  for (const status of ["reviewing", "awaiting_approval"] as const) {
    const html = controls(node({ toolCalls: [call({ status })] }));
    assert.match(html, /从后续符合范围的操作生效/);
    assert.match(html, /当前审核或待批准操作保持原流程/);
  }
  assert.doesNotMatch(
    controls(node({ toolCalls: [call()] })),
    /当前审核或待批准/,
  );
});

test("takeover approval has its own audit label instead of claiming a safety-model decision", () => {
  const html = renderToStaticMarkup(
    <ToolActivity
      calls={[call({ approval: "cua_takeover" })]}
      onDecision={async () => {}}
    />,
  );
  assert.match(html, /CUA 接管已放行/);
  assert.doesNotMatch(html, /安全模型已批准|你已批准此操作|旧版自动放行/);
});

test("task control displays the explicit live page/origin grant and offers a separate scope change", () => {
  const scope = {
    id: "scope",
    label: "example.com · 窗口 2 · 页面 tab",
    origin: "https://example.com",
    target: { kind: "page" as const, pid: 1, windowId: 2, tabId: "tab" },
  };
  const current = node({
    toolRequests: ["computer_use"],
    computerUseTakeover: true,
    computerUseScope: scope,
    computerUseTaskScope: scope,
  });
  const html = controls(current);
  assert.match(html, /本任务控制/);
  assert.match(html, /已授权：example.com/);
  assert.match(html, /发送、付款、删除等重要操作需单次批准/);
  assert.doesNotMatch(html, /改为授权当前目标/);
  assert.match(
    controls({ ...current, computerUseScope: { ...scope, id: "other" } }),
    /改为授权当前目标/,
  );
});
