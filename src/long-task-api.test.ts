import assert from "node:assert/strict";
import test from "node:test";
import { api } from "./api.ts";

const paths = ["/workspaces/w/nodes", "/workspaces/w/nodes/n/regenerate"];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("manual, CUA and subagent long tasks require a backend supporting long execution", async (t) => {
  for (const path of paths) {
    for (const body of [
      { config: { model: "test", thinking: "off", longTask: true } },
      { toolRequests: ["computer_use"], config: { longTask: false } },
      { toolRequests: ["subagents"], config: { longTask: false } },
    ]) {
      const calls: string[] = [];
      const fetch = t.mock.method(globalThis, "fetch", async (url: string) => {
        calls.push(url);
        return json({ toolRequests: true, longTasks: false });
      });
      await assert.rejects(api(path, body), /后端尚不支持长程任务/);
      assert.ok(calls.length > 0);
      assert.ok(calls.every((url) => url === "/api/capabilities"));
      fetch.mock.restore();
    }
  }
});

test("supported long-task submissions retain the exact config on create and edit", async (t) => {
  const sent: unknown[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options?: RequestInit) => {
      if (url === "/api/capabilities") return json({ longTasks: true });
      sent.push(JSON.parse(options!.body as string));
      return json({ nodeId: "created" });
    },
  );
  const body = {
    prompt: "完成这项长程任务",
    config: { model: "test", thinking: "off", longTask: true },
  };
  for (const path of paths) await api(path, body);
  assert.deepEqual(sent, [body, body]);
});

test("ordinary requests with a missing or false long-task flag need no new capability", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    json({ ok: true }),
  );
  await api(paths[0], { config: { model: "test", thinking: "off" } });
  await api(paths[1], {
    config: { model: "test", thinking: "off", longTask: false },
  });
  assert.equal(fetch.mock.callCount(), 2);
  assert.ok(
    fetch.mock.calls.every((call) => call.arguments[0] !== "/api/capabilities"),
  );
});

test("an unavailable capability endpoint keeps long-task submissions unsent", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => json({}, 503));
  await assert.rejects(
    api(paths[0], { config: { longTask: true } }),
    /无法确认当前后端支持长程任务/,
  );
  assert.equal(fetch.mock.callCount(), 1);
});
