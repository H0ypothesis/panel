import assert from "node:assert/strict";
import test from "node:test";
import { api } from "./api.ts";

test("running input is sent only to backends advertising native queue support", async (t) => {
  let supported = false;
  const bodies: unknown[] = [];
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options?: RequestInit) => {
      if (url === "/api/capabilities")
        return new Response(JSON.stringify({ runInputs: supported }));
      bodies.push(JSON.parse(options!.body as string));
      return new Response(JSON.stringify({ input: { status: "queued" } }));
    },
  );
  const path = "/workspaces/w/nodes/n/inputs";
  const body = {
    text: "adjust direction",
    mode: "steer",
    requestId: "one",
    expectedRevision: 3,
  };
  await assert.rejects(api(path, body), /后端尚不支持运行中引导/);
  assert.deepEqual(bodies, []);
  supported = true;
  await api(path, body);
  assert.deepEqual(bodies, [body]);
  assert.equal(fetch.mock.callCount(), 3);
});
