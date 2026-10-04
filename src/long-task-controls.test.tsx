import assert from "node:assert/strict";
import test from "node:test";
import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelOption, RunConfig, ToolCall } from "../shared/types";
import { LongTaskBadge, LongTaskToggle } from "./LongTaskControls";
import {
  automaticLongTask,
  configForModel,
  newBranchConfig,
} from "./run-config";
import { branchDraftHeight } from "./branch-draft";

const config: RunConfig = { model: "test/a", thinking: "high" };
const model: ModelOption = {
  id: "test/b",
  name: "Model B",
  provider: "test",
  providerName: "Test",
  available: true,
  demo: false,
  thinkingLevels: ["low", "medium"],
  contextWindow: 10000,
};
function inputMarkup(
  props: Partial<Parameters<typeof LongTaskToggle>[0]> = {},
) {
  return renderToStaticMarkup(
    <LongTaskToggle config={config} onConfigChange={() => {}} {...props} />,
  );
}
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return [];
    return [child, ...elements(child.props.children as ReactNode)];
  });
}
const call = (changes: Partial<ToolCall> = {}): ToolCall => ({
  id: "tool",
  name: "computer_use_call",
  arguments: {},
  status: "failed",
  startedAt: 1,
  ...changes,
});
const authorization: NonNullable<ToolCall["authorization"]> = {
  id: "authorization",
  actionHash: "hash",
  policyVersion: "version",
  issuedAt: 1,
  expiresAt: 20,
  consumedAt: 2,
};

test("long task switch is off by default, editable manually, and states the reply limit precisely", () => {
  const off = inputMarkup();
  assert.match(off, /role="switch"/);
  assert.match(off, /允许超过40次模型回复；使用电脑控制或子代理时自动开启/);
  assert.doesNotMatch(off, /checked=""|disabled=""|审批绕过/);
  assert.match(
    inputMarkup({ config: { ...config, longTask: true } }),
    /checked=""/,
  );
  assert.match(inputMarkup({ disabled: true }), /disabled=""/);
  let emitted: RunConfig | undefined;
  const tree = LongTaskToggle({
    config,
    onConfigChange: (next) => {
      emitted = next;
    },
  });
  const input = elements(tree).find((element) => element.type === "input")!;
  (input.props.onChange as (event: { target: { checked: boolean } }) => void)({
    target: { checked: true },
  });
  assert.deepEqual(emitted, { ...config, longTask: true });
});

test("computer selection shows automatic state without changing the manual preference", () => {
  const off = { ...config, longTask: false };
  const automatic = inputMarkup({
    config: off,
    toolRequests: ["computer_use"],
  });
  assert.match(automatic, /checked=""/);
  assert.match(automatic, /disabled=""/);
  assert.match(automatic, /电脑控制已自动开启/);
  assert.match(automatic, /长程任务，电脑控制自动开启/);
  assert.equal(off.longTask, false);
  assert.doesNotMatch(
    inputMarkup({ config: off, toolRequests: [] }),
    /checked=""/,
  );
  assert.match(
    inputMarkup({ config: { ...config, longTask: true }, toolRequests: [] }),
    /checked=""/,
  );
});

test("subagent selection shows automatic long mode and resets when deselected", () => {
  const off = { ...config, longTask: false };
  const automatic = inputMarkup({ config: off, toolRequests: ["subagents"] });
  assert.match(automatic, /checked=""/);
  assert.match(automatic, /disabled=""/);
  assert.match(automatic, /子代理已自动开启/);
  assert.match(automatic, /长程任务，子代理自动开启/);
  assert.match(
    inputMarkup({ config: off, toolRequests: ["subagents", "computer_use"] }),
    /电脑控制和子代理已自动开启/,
  );
  assert.equal(off.longTask, false);
  assert.doesNotMatch(
    inputMarkup({ config: off, toolRequests: [] }),
    /checked=""/,
  );
});

test("dispatched subagents and same-card wakeups display automatic long mode", () => {
  for (const name of ["subagent", "subagents_enable"]) {
    assert.equal(automaticLongTask(undefined, [call({ name })]), false);
    assert.equal(
      automaticLongTask(undefined, [call({ name, authorization })]),
      true,
    );
    assert.match(
      renderToStaticMarkup(
        <LongTaskBadge
          config={config}
          status="running"
          toolCalls={[call({ name, authorization })]}
        />,
      ),
      /长程任务 · 自动/,
    );
  }
  assert.match(
    renderToStaticMarkup(
      <LongTaskBadge
        config={config}
        status="queued"
        toolRequests={["subagents"]}
      />,
    ),
    /长程任务 · 自动/,
  );
  assert.match(
    renderToStaticMarkup(
      <LongTaskBadge config={config} status="running" subagentsEnabled />,
    ),
    /长程任务 · 自动/,
  );
  assert.equal(
    renderToStaticMarkup(
      <LongTaskBadge config={config} status="completed" subagentsEnabled />,
    ),
    "",
  );
});

test("model and thinking changes preserve explicit duration while unrelated new branches reset it", () => {
  const selected = { ...config, longTask: true };
  assert.deepEqual(configForModel(selected, model), {
    model: "test/b",
    thinking: "medium",
    longTask: true,
  });
  assert.deepEqual(newBranchConfig(selected), { ...config, longTask: false });
  assert.equal(selected.longTask, true);
  assert.ok(branchDraftHeight(0) >= 408);
});

test("sent-node automatic badge requires actual dispatch and never infers it from failed preflight or release", () => {
  assert.equal(automaticLongTask(undefined, [call()]), false);
  assert.equal(
    automaticLongTask(undefined, [call({ status: "denied" })]),
    false,
  );
  assert.equal(
    automaticLongTask(undefined, [
      call({ authorization: { ...authorization, consumedAt: undefined } }),
    ]),
    false,
  );
  assert.equal(
    automaticLongTask(undefined, [
      call({ name: "computer_use_release", authorization }),
    ]),
    false,
  );
  assert.equal(automaticLongTask(undefined, [call({ authorization })]), true);
  assert.equal(
    automaticLongTask(undefined, [
      call({ name: "computer_use_tools", authorization }),
    ]),
    true,
  );
  assert.equal(
    renderToStaticMarkup(
      <LongTaskBadge config={config} status="running" toolCalls={[call()]} />,
    ),
    "",
  );
  assert.match(
    renderToStaticMarkup(
      <LongTaskBadge
        config={config}
        status="running"
        toolCalls={[call({ authorization })]}
      />,
    ),
    /长程任务 · 自动/,
  );
  assert.match(
    renderToStaticMarkup(
      <LongTaskBadge
        config={config}
        status="queued"
        toolRequests={["computer_use"]}
      />,
    ),
    /长程任务 · 自动/,
  );
  assert.match(
    renderToStaticMarkup(
      <LongTaskBadge
        config={{ ...config, longTask: true }}
        status="completed"
        compact
      />,
    ),
    /aria-label="长程任务"/,
  );
});

test("historic computer tasks never claim the current automatic policy, but saved manual settings remain visible", () => {
  for (const status of ["failed", "cancelled", "completed"] as const) {
    assert.equal(
      renderToStaticMarkup(
        <LongTaskBadge
          config={config}
          status={status}
          toolRequests={["computer_use"]}
          toolCalls={[call({ authorization })]}
        />,
      ),
      "",
    );
    const manual = renderToStaticMarkup(
      <LongTaskBadge
        config={{ ...config, longTask: true }}
        status={status}
        toolRequests={["computer_use"]}
      />,
    );
    assert.match(manual, /aria-label="长程任务"/);
    assert.doesNotMatch(manual, /长程任务 · 自动/);
  }
});
