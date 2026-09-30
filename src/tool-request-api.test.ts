import assert from "node:assert/strict";
import test from "node:test";
import { api } from "./api.ts";

const paths = ["/workspaces/w/nodes", "/workspaces/w/nodes/n/regenerate"];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("explicit tools are checked before create or regeneration and never silently dropped", async (t) => {
  for (const path of paths) {
    for (const capability of [{}, { toolRequests: false }]) {
      const fetch = t.mock.method(globalThis, "fetch", async () =>
        json(capability),
      );
      await assert.rejects(
        api(path, { prompt: "查看当前页面", toolRequests: ["computer_use"] }),
        /后端尚未加载指定工具/,
      );
      assert.equal(fetch.mock.callCount(), 1);
      assert.equal(fetch.mock.calls[0].arguments[0], "/api/capabilities");
      fetch.mock.restore();
    }
  }
});

test("supported submissions preserve tool choices separately from card references", async (t) => {
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (path: string | URL | Request) =>
      path === "/api/capabilities"
        ? json({ toolRequests: true, cardReferences: true, longTasks: true })
        : json({ nodeId: "created" }),
  );
  const body = {
    prompt: "综合资料后查看页面",
    referenceNodeIds: ["card"],
    toolRequests: ["web_search", "computer_use"],
  };
  for (const path of paths)
    assert.deepEqual(await api(path, body), { nodeId: "created" });
  const mutations = fetch.mock.calls.filter(
    (call) => call.arguments[0] !== "/api/capabilities",
  );
  assert.equal(mutations.length, 2);
  assert.deepEqual(
    mutations.map((call) =>
      JSON.parse((call.arguments[1] as RequestInit).body as string),
    ),
    [body, body],
  );
});

test("missing tool choices stay ordinary requests and an explicit empty selection is sent to clear edits", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    json({ ok: true }),
  );
  await api(paths[0], { prompt: "普通问题" });
  await api(paths[1], { prompt: "修改问题", toolRequests: [] });
  assert.equal(fetch.mock.callCount(), 2);
  assert.deepEqual(
    JSON.parse((fetch.mock.calls[1].arguments[1] as RequestInit).body as string)
      .toolRequests,
    [],
  );
});

test("an unavailable capability endpoint blocks explicit tools before model submission", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    json({ error: "Unavailable" }, 503),
  );
  await assert.rejects(
    api(paths[0], { prompt: "查询资料", toolRequests: ["web_search"] }),
    /无法确认当前后端支持指定工具/,
  );
  assert.equal(fetch.mock.callCount(), 1);
});
