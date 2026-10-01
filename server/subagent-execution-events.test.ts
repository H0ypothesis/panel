import assert from "node:assert/strict";
import test from "node:test";
import { SubagentExecutionEvents } from "./subagent-execution-events.ts";

test("approval wait never emits execution start, grant starts all observers once", () => {
  const gate = new SubagentExecutionEvents();
  const first: any[] = [],
    second: any[] = [];
  const a = (event: any) => first.push(event),
    b = (event: any) => second.push(event);
  const event = {
    type: "tool_execution_start",
    toolCallId: "one",
    toolName: "write",
  };
  gate.receive(event, a);
  gate.receive(event, b);
  assert.equal(first.length + second.length, 0);
  gate.granted("one");
  gate.granted("one");
  assert.deepEqual(first, [event]);
  assert.deepEqual(second, [event]);
  gate.receive({ type: "tool_execution_end", toolCallId: "one" }, a);
  assert.equal(first.length, 2);
});

test("denial and unsubscribe discard deferred starts without affecting other calls", () => {
  const gate = new SubagentExecutionEvents(),
    events: any[] = [];
  const listener = (event: any) => events.push(event);
  gate.receive(
    { type: "tool_execution_start", toolCallId: "denied" },
    listener,
  );
  gate.receive({ type: "tool_execution_end", toolCallId: "denied" }, listener);
  gate.granted("denied");
  assert.deepEqual(
    events.map((event) => event.type),
    ["tool_execution_end"],
  );
  gate.receive(
    { type: "tool_execution_start", toolCallId: "unsubscribed" },
    listener,
  );
  gate.unsubscribe(listener);
  gate.granted("unsubscribed");
  assert.equal(events.length, 1);
});
