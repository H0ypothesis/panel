import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCallCard, toolCallTarget } from "./CodingControls";
import type { ToolCall } from "../shared/types";

test("network permission clearly names its destination and offers no blanket batch approval", () => {
  const call: ToolCall = {
    id: "network",
    name: "sandbox_network",
    arguments: {
      host: "registry.npmjs.org",
      port: 443,
      command: "npm install",
    },
    status: "awaiting_approval",
    startedAt: 1,
  };
  assert.equal(toolCallTarget(call), "registry.npmjs.org:443");
  const html = renderToStaticMarkup(
    <ToolCallCard
      call={call}
      onDecision={async () => {}}
      batchApprovalAvailable
    />,
  );
  assert.match(html, /联网目标授权/);
  assert.match(html, /允许本轮访问此目标/);
  assert.doesNotMatch(html, /批量同意/);
});

test("recovery presents the exact command, failure and directory with retry or single host approval", () => {
  const call: ToolCall = {
    id: "recovery",
    name: "sandbox_recovery",
    startedAt: 1,
    status: "awaiting_approval",
    workingDirectory: "/project",
    arguments: {
      command: "npm test",
      reason: "缺少 bwrap",
      stage: "preflight",
    },
  };
  const html = renderToStaticMarkup(
    <ToolCallCard
      call={call}
      onDecision={async () => {}}
      batchApprovalAvailable
    />,
  );
  for (const label of [
    "沙盒故障恢复",
    "npm test",
    "缺少 bwrap",
    "/project",
    "原命令尚未执行",
    "重试沙盒",
    "仅本次在宿主执行",
    "不受原沙盒的文件和网络限制",
  ])
    assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /批量同意/);
});

test("a host command audit cannot claim it executed within the sandbox", () => {
  const call: ToolCall = {
    id: "host",
    name: "bash",
    startedAt: 1,
    arguments: { command: "npm test" },
    status: "completed",
    approval: "sandbox",
    executionMode: "host",
  };
  const html = renderToStaticMarkup(
    <ToolCallCard
      call={call}
      onDecision={async () => {}}
      batchApprovalAvailable
    />,
  );
  assert.match(html, /本次命令经你单独批准在宿主执行/);
  assert.doesNotMatch(html, /沙盒范围内自动执行/);
});
