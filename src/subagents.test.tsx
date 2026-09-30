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
