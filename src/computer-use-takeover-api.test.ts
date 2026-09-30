import assert from "node:assert/strict";
import test from "node:test";
import { api, ApiError } from "./api";

const path = "/workspaces/workspace/nodes/node/computer-use-takeover";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("takeover checks backend capability before either enable or revoke and blocks unsupported changes", async (t) => {
  for (const enabled of [true, false]) {
    for (const capabilities of [{}, { computerUseTakeover: false }]) {
      const fetch = t.mock.method(globalThis, "fetch", async () =>
        json(capabilities),
      );
      await assert.rejects(
        api(path, { enabled, expectedRevision: 2 }),
        /当前后端尚不支持 CUA 接管.*开关尚未更改/,
      );
      assert.equal(fetch.mock.callCount(), 1);
      assert.equal(fetch.mock.calls[0].arguments[0], "/api/capabilities");
      fetch.mock.restore();
    }
  }
});

test("live takeover uses the selected node endpoint and exact run revision, returning server state", async (t) => {
  const changes: { url: string; options?: RequestInit }[] = [];
  const state = { instanceId: "instance", revision: 18, workspaces: [] };
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options?: RequestInit) => {
      if (url === "/api/capabilities")
        return json({ computerUseTakeover: true });
      changes.push({ url, options });
      return json(state);
    },
  );
  for (const enabled of [true, false]) {
    const body = { enabled, expectedRevision: 2 };
    assert.deepEqual(await api(path, body), state);
    const request = changes.at(-1)!;
    assert.equal(request.url, `/api${path}`);
    assert.equal(request.options?.method, "POST");
    assert.deepEqual(JSON.parse(request.options!.body as string), body);
  }
  assert.equal(changes.length, 2);
});

test("unavailable capability checks never submit a takeover mutation", async (t) => {
  for (const response of [
    () => json({}, 503),
    () => new Response("not json"),
    () => Promise.reject(new Error("offline")),
  ]) {
    const fetch = t.mock.method(globalThis, "fetch", async () => response());
    await assert.rejects(
      api(path, { enabled: true, expectedRevision: 2 }),
      /无法确认当前后端支持 CUA 接管.*开关尚未更改/,
    );
    assert.equal(fetch.mock.callCount(), 1);
    fetch.mock.restore();
  }
});

test("a stale run or ended task returns its conflict for the existing error UI", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string) =>
    url === "/api/capabilities"
      ? json({ computerUseTakeover: true })
      : json({ error: "卡片已重新运行，请刷新后重试。" }, 409),
  );
  await assert.rejects(
    api(path, { enabled: true, expectedRevision: 1 }),
    (error: unknown) =>
      error instanceof ApiError &&
      error.status === 409 &&
      /卡片已重新运行/.test(error.message),
  );
});

test("task grants never silently degrade to basic takeover on an older backend", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () =>
    json({ computerUseTakeover: true }),
  );
  await assert.rejects(
    api(path, {
      enabled: true,
      mode: "task",
      scopeId: "scope",
      expectedRevision: 2,
    }),
    /尚不支持本任务控制/,
  );
  assert.equal(mock.mock.callCount(), 1);
});
