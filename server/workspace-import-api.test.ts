import assert from "node:assert/strict";
import {
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createApi } from "./api.ts";
import type { Runtime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { exampleWorkspace } from "./seed.ts";
import { Store, type StoredWorkspace } from "./store.ts";
import { MAX_IMPORT_BYTES } from "./workspace-import.ts";
import { readWorkspaceImportFile } from "./workspace-import-file.ts";

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "panel-import-api-"));
  const dataDirectory = join(directory, "data");
  const store = new Store(dataDirectory);
  await store.init(false);
  const original: StoredWorkspace = exampleWorkspace();
  const answer = original.nodes.find((node) => node.status === "completed")!;
  answer.response = "来自他人的研究结论，包含完整结果。";
  answer.messages = [
    { role: "user", content: answer.prompt, timestamp: answer.createdAt },
    fauxAssistantMessage(answer.response),
  ];
  store.data.workspaces.push(original);
  await store.save();
  let modelCalls = 0;
  const runtime: Runtime = {
    models: () => [],
    async run() {
      modelCalls++;
      throw new Error("Import must not execute a model");
    },
  };
  const scheduler = new Scheduler(store, runtime);
  const api = createApi(store, runtime, scheduler);
  t.after(async () => {
    scheduler.shutdown();
    assert.equal(modelCalls, 0);
    await rm(directory, { recursive: true, force: true });
  });
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const request = Readable.from(
      body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
    ) as IncomingMessage;
    Object.assign(request, {
      method,
      url: `/api${path}`,
      headers: {
        host: "127.0.0.1:9999",
        "content-type": "application/json",
        ...headers,
      },
    });
    let status = 0;
    let output = "";
    const response = {
      setHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        output = value;
      },
    } as unknown as ServerResponse;
    assert.equal(await api(request, response), true);
    return { status, body: JSON.parse(output) };
  };
  const exported = await call("GET", `/workspaces/${original.id}/export`);
  assert.equal(exported.status, 200);
  return {
    directory,
    dataDirectory,
    store,
    original,
    answer,
    call,
    exported: exported.body,
  };
}

test("actual JSON export imports with visible answers, independent IDs and durable transcripts", async (t) => {
  const e = await setup(t);
  const result = await e.call("POST", "/workspaces/import", {
    data: e.exported,
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.state.workspaces.length, 2);
  const restored = e.store.workspace(result.body.workspaceId);
  assert.notEqual(restored.id, e.original.id);
  assert.equal(restored.title, e.original.title);
  assert.equal(restored.nodes.length, e.original.nodes.length);
  const answer = restored.nodes.find(
    (node) => node.prompt === e.answer.prompt,
  )!;
  assert.equal(answer.response, e.answer.response);
  assert.deepEqual(answer.messages, e.answer.messages);
  assert.deepEqual(answer.position, e.answer.position);
  assert.equal(restored.approvalMode, "ask");
  assert.equal(restored.workingDirectory, undefined);
  assert.ok(
    restored.nodes.every(
      (node) => !e.original.nodes.some((source) => source.id === node.id),
    ),
  );
  assert.ok(!("messages" in result.body.state.workspaces[0].nodes[1]));
  const repeated = await e.call("POST", "/workspaces/import", {
    data: e.exported,
  });
  assert.equal(repeated.status, 201);
  assert.notEqual(repeated.body.workspaceId, restored.id);
  const reexport = await e.call("GET", `/workspaces/${restored.id}/export`);
  assert.equal(
    reexport.body.workspace.nodes.find(
      (node: { id: string }) => node.id === answer.id,
    ).response,
    e.answer.response,
  );
  const restarted = new Store(e.dataDirectory);
  await restarted.init(false);
  assert.equal(restarted.data.workspaces.length, 3);
  assert.deepEqual(restarted.workspace(restored.id).nodes, restored.nodes);
});

test("path import reads the selected JSON without modifying it and rejects invalid sources", async (t) => {
  const e = await setup(t);
  const path = join(e.directory, "someone-else.json");
  const content = `\uFEFF${JSON.stringify(e.exported)}`;
  await writeFile(path, content);
  const imported = await e.call("POST", "/workspaces/import", { path });
  assert.equal(imported.status, 201);
  assert.equal(await readFile(path, "utf8"), content);
  const count = e.store.data.workspaces.length;
  for (const body of [
    { path: "relative.json" },
    { path: "https://example.com/export.json" },
    { path: e.directory },
    { path: join(e.directory, "missing.json") },
    { path, data: e.exported },
    {},
    { data: { version: 9, workspace: {} } },
  ]) {
    const invalid = await e.call("POST", "/workspaces/import", body);
    assert.equal(invalid.status, 400);
    assert.ok(invalid.body.error);
    assert.equal(e.store.data.workspaces.length, count);
  }
  await writeFile(path, "{broken json");
  const invalid = await e.call("POST", "/workspaces/import", { path });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /有效的 JSON/);
});

test("imports allow full transcripts above normal mutation limits but bound file and request sizes", async (t) => {
  const e = await setup(t);
  const sourceAnswer = e.exported.workspace.nodes.find(
    (node: { id: string }) => node.id === e.answer.id,
  );
  sourceAnswer.response = "x".repeat(600_000);
  sourceAnswer.messages = undefined;
  const result = await e.call("POST", "/workspaces/import", {
    data: e.exported,
  });
  assert.equal(result.status, 201);
  const oversized = await e.call("POST", "/workspaces/import", {
    data: "x".repeat(MAX_IMPORT_BYTES),
  });
  assert.equal(oversized.status, 400);
  const path = join(e.directory, "oversized.json");
  const file = await open(path, "w");
  await file.truncate(MAX_IMPORT_BYTES + 1);
  await file.close();
  await assert.rejects(readWorkspaceImportFile(path), /20 MB/);
});

test("failed persistence does not publish an imported exploration and retry succeeds", async (t) => {
  const e = await setup(t);
  await rename(e.dataDirectory, `${e.dataDirectory}-saved`);
  const failed = await e.call("POST", "/workspaces/import", {
    data: e.exported,
  });
  assert.equal(failed.status, 400);
  assert.equal(e.store.data.workspaces.length, 1);
  await rename(`${e.dataDirectory}-saved`, e.dataDirectory);
  const result = await e.call("POST", "/workspaces/import", {
    data: e.exported,
  });
  assert.equal(result.status, 201);
  const saved = JSON.parse(
    await readFile(join(e.dataDirectory, "state.json"), "utf8"),
  );
  assert.equal(saved.workspaces.length, 2);
});

test("concurrent imports persist both explorations and keep mutation origin protections", async (t) => {
  const e = await setup(t);
  const results = await Promise.all([
    e.call("POST", "/workspaces/import", { data: e.exported }),
    e.call("POST", "/workspaces/import", { data: e.exported }),
  ]);
  assert.ok(results.every((result) => result.status === 201));
  assert.notEqual(results[0].body.workspaceId, results[1].body.workspaceId);
  const saved = JSON.parse(
    await readFile(join(e.dataDirectory, "state.json"), "utf8"),
  );
  assert.equal(saved.workspaces.length, 3);
  assert.equal(
    (
      await e.call(
        "POST",
        "/workspaces/import",
        { data: e.exported },
        { origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await e.call(
        "POST",
        "/workspaces/import",
        { data: e.exported },
        { "content-type": "text/plain" },
      )
    ).status,
    400,
  );
  assert.equal(e.store.data.workspaces.length, 3);
});
