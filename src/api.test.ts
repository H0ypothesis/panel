import assert from "node:assert/strict";
import test from "node:test";
import { api } from "./api.ts";

const createPath = "/workspaces/workspace/nodes";
const regeneratePath = "/workspaces/workspace/nodes/node/regenerate";
const referencedInput = {
  prompt: "总结这张卡片",
  referenceNodeIds: ["selected-card"],
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("older backends cannot silently submit a create or regenerate request with card references", async (t) => {
  for (const path of [createPath, regeneratePath]) {
    for (const capabilities of [
      { webSearch: true },
      { cardReferences: false },
    ]) {
      const fetch = t.mock.method(globalThis, "fetch", async () =>
        json(capabilities),
      );
      await assert.rejects(api(path, referencedInput), {
        message:
          "当前后端尚未加载卡片引用功能，请重启 Panel 服务后重试。引用内容尚未发送。",
      });
      assert.equal(fetch.mock.callCount(), 1);
      assert.deepEqual(fetch.mock.calls[0].arguments, [
        "/api/capabilities",
        { cache: "no-store" },
      ]);
      fetch.mock.restore();
    }
  }
});

test("supported backends receive the original card references after a fresh capability check for every submission", async (t) => {
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request) =>
      input === "/api/capabilities"
        ? json({ cardReferences: true })
        : json({ nodeId: "created-node" }),
  );
  for (const path of [createPath, regeneratePath]) {
    assert.deepEqual(await api(path, referencedInput), {
      nodeId: "created-node",
    });
  }
  assert.equal(fetch.mock.callCount(), 4);
  for (const [index, path] of [createPath, regeneratePath].entries()) {
    assert.equal(fetch.mock.calls[index * 2].arguments[0], "/api/capabilities");
    assert.deepEqual(fetch.mock.calls[index * 2 + 1].arguments, [
      `/api${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(referencedInput),
      },
    ]);
  }
});

test("ordinary requests and requests with no selected cards do not require a capability check", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () =>
    json({ ok: true }),
  );
  await api(createPath, { prompt: "普通问题" });
  await api(createPath, { prompt: "普通问题", referenceNodeIds: [] });
  await api(regeneratePath, { prompt: "编辑普通问题", referenceNodeIds: [] });
  await api("/state");
  assert.equal(fetch.mock.callCount(), 4);
  assert.ok(
    fetch.mock.calls.every((call) => call.arguments[0] !== "/api/capabilities"),
  );
});

test("failed capability checks never send a referenced model request", async (t) => {
  for (const failure of ["network", "http", "json"]) {
    const fetch = t.mock.method(globalThis, "fetch", async () => {
      if (failure === "network") throw new TypeError("Failed to fetch");
      if (failure === "http") return json({ error: "Unavailable" }, 503);
      return new Response("not json", { status: 200 });
    });
    await assert.rejects(api(createPath, referencedInput), {
      message:
        "无法确认当前后端支持卡片引用，请检查连接后重试。引用内容尚未发送。",
    });
    assert.equal(fetch.mock.callCount(), 1);
    assert.equal(fetch.mock.calls[0].arguments[0], "/api/capabilities");
    fetch.mock.restore();
  }
});

test("a backend restart is recognized on the next attempt without reloading the frontend", async (t) => {
  let updated = false;
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request) =>
      input === "/api/capabilities"
        ? json(updated ? { cardReferences: true } : {})
        : json({ nodeId: "created-node" }),
  );
  await assert.rejects(api(createPath, referencedInput), /请重启 Panel 服务/);
  updated = true;
  assert.deepEqual(await api(createPath, referencedInput), {
    nodeId: "created-node",
  });
  assert.equal(fetch.mock.callCount(), 3);
});
