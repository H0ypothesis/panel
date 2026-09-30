import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubagentRun, TurnNode } from "../shared/types";
import { SubagentAvatars, SubagentsPanel } from "./Subagents";
import { filterToolRequests } from "./card-reference-input";
import { ToolRequestList } from "./ToolRequestList";

const runs: SubagentRun[] = Array.from({ length: 8 }, (_, i) => ({
  id: `child-${i}`,
  agent: i % 2 ? "worker" : "scout",
  task: `task ${i}`,
  status: i % 2 ? "running" : "completed",
  model: "openai/test",
  response: `result ${i}`,
  createdAt: 1,
}));
const node: TurnNode = {
  id: "parent",
  parentId: null,
  prompt: "test",
  response: "",
  config: { model: "openai/test", thinking: "off" },
  status: "running",
  position: { x: 0, y: 0 },
  color: "sage",
  contextIds: [],
  createdAt: 1,
  subagents: runs,
};

test("@ menu searches subagents in both languages and renders a dedicated chip", () => {
  for (const query of ["SUBAGENTS", "子代理", "协作"])
    assert.deepEqual(
      filterToolRequests(query).map((item) => item.id),
      ["subagents"],
    );
  assert.match(
    renderToStaticMarkup(<ToolRequestList requests={["subagents"]} />),
    /Subagents/,
  );
});

test("card avatars remain bounded while the inspector lists every child", () => {
  const card = renderToStaticMarkup(
    <SubagentAvatars runs={runs} onSelect={() => {}} />,
  );
  assert.equal((card.match(/<button/g) ?? []).length, 6);
  assert.match(card, /\+3/);
  const panel = renderToStaticMarkup(
    <SubagentsPanel
      node={node}
      selectedId="child-7"
      onSelect={() => {}}
      onDecision={async () => {}}
      batchApprovalAvailable={false}
    />,
  );
  assert.equal((panel.match(/aria-pressed=/g) ?? []).length, 8);
  assert.match(panel, /result 7/);
  assert.doesNotMatch(panel, /result 0/);
});

test("enabled empty state never claims a child has run", () => {
  const panel = renderToStaticMarkup(
    <SubagentsPanel
      node={{ ...node, subagents: [], subagentsEnabled: true }}
      onSelect={() => {}}
      onDecision={async () => {}}
      batchApprovalAvailable={false}
    />,
  );
  assert.match(panel, /等待主模型分配/);
});

test("custom native roles render their name and avatar without a hardcoded role enum", () => {
  const custom = { ...runs[0], agent: "security-reviewer" };
  assert.match(
    renderToStaticMarkup(
      <SubagentAvatars runs={[custom]} onSelect={() => {}} />,
    ),
    /security-reviewer/,
  );
  assert.match(
    renderToStaticMarkup(
      <SubagentsPanel
        node={{ ...node, subagents: [custom] }}
        onSelect={() => {}}
        onDecision={async () => {}}
        batchApprovalAvailable={false}
      />,
    ),
    /security-reviewer/,
  );
});

test("workflow orchestration is separate from agent counts and never exposes raw diagnostic data", () => {
  const workflow: SubagentRun = {
    ...runs[0],
    id: "native:workflow-root",
    agent: "workflow",
    task: "[prompt redacted]",
    response: '{"internalResult":"private-diagnostic"}',
  };
  const grouped = [workflow, ...runs.slice(0, 2)];
  const card = renderToStaticMarkup(
    <SubagentAvatars runs={grouped} onSelect={() => {}} />,
  );
  assert.match(card, /2 个子代理，1 个完成/);
  assert.doesNotMatch(card, /workflow|prompt redacted/);
  assert.equal((card.match(/<button/g) ?? []).length, 2);
  const props = {
    node: {
      ...node,
      subagents: grouped,
      subagentNotices: [
        {
          kind: "background-debug",
          value: { raw: "internal-notice" },
          createdAt: 1,
        },
      ],
    },
    onSelect() {},
    onDecision: async () => {},
    batchApprovalAvailable: false,
  };
  const panel = renderToStaticMarkup(<SubagentsPanel {...props} />);
  assert.match(panel, /任务编排/);
  assert.match(panel, /result 0/);
  assert.doesNotMatch(
    panel,
    /workflow 1|原生任务与管理|后台通知|internal-notice|private-diagnostic/,
  );
  const orchestration = renderToStaticMarkup(
    <SubagentsPanel {...props} selectedId={workflow.id} />,
  );
  assert.doesNotMatch(orchestration, /private-diagnostic|prompt redacted/);
  assert.match(orchestration, /编排已结束/);
});
