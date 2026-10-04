import assert from "node:assert/strict";
import { mkdtemp, rename, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import { DEFAULT_CONFIG, type ModelOption } from "../shared/types.ts";
import { createApi } from "./api.ts";
import type { Runtime } from "./runtime.ts";
import { Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";

const executionModel: ModelOption = {
  id: "test/execution",
  name: "Execution",
  provider: "test",
  providerName: "Test",
  available: true,
  demo: false,
  contextWindow: 128000,
  thinkingLevels: ["off", "medium", "high"],
  thinkingControls: {
    toggle: "supported",
    efforts: ["medium", "high"],
    effortRequiresThinking: true,
  },
};
const config = {
  model: executionModel.id,
  thinking: "off",
  thinkingMode: "disabled",
  effort: "default",
} as const;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "panel-workspace-create-"));
  const dataDirectory = join(directory, "data");
  const store = new Store(dataDirectory);
  await store.init(false);
  const runtime: Runtime = {
    models: () => [
      executionModel,
      { ...executionModel, id: "test/reviewer", default: true },
      { ...executionModel, id: "test/unavailable", available: false },
      { ...executionModel, id: DEFAULT_CONFIG.model, demo: true },
    ],
    async run() {
      assert.fail("Creating a workspace must not run a model");
    },
  };
  const scheduler = new Scheduler(store, runtime);
  const api = createApi(store, runtime, scheduler);
  t.after(async () => {
    scheduler.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  const create = async (body: unknown) => {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(request, {
      method: "POST",
      url: "/api/workspaces",
      headers: {
        host: "127.0.0.1:9999",
        "content-type": "application/json",
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
    assert.equal(await api(request as IncomingMessage, response), true);
    return { status, body: JSON.parse(output) };
  };
  return { create, store, dataDirectory };
}

test("workspace creation persists independent execution and safety models across restart", async (t) => {
  const e = await fixture(t);
  const result = await e.create({
    title: " 新探索 ",
    description: "背景",
    config,
    approvalMode: "auto",
    safetyModel: "test/reviewer",
  });
  assert.equal(result.status, 201);
  const workspace = result.body.state.workspaces[0];
  assert.equal(workspace.id, result.body.workspaceId);
  assert.equal(workspace.title, "新探索");
  assert.deepEqual(workspace.defaultConfig, config);
  assert.deepEqual(workspace.nodes[0].config, config);
  assert.equal(workspace.approvalMode, "auto");
  assert.equal(workspace.safetyModel, "test/reviewer");
  const restarted = new Store(e.dataDirectory);
  await restarted.init(false);
  const restored = restarted.workspace(workspace.id);
  assert.deepEqual(restored.defaultConfig, config);
  assert.deepEqual(restored.nodes[0].config, config);
  assert.equal(restored.approvalMode, "auto");
  assert.equal(restored.safetyModel, "test/reviewer");
});

test("creation without model settings keeps legacy defaults", async (t) => {
  const e = await fixture(t);
  const result = await e.create({ title: "旧客户端" });
  assert.equal(result.status, 201);
  const workspace = e.store.workspace(result.body.workspaceId);
  assert.deepEqual(workspace.nodes[0].config, DEFAULT_CONFIG);
  assert.equal(workspace.defaultConfig, undefined);
  assert.equal(workspace.approvalMode, "ask");
});

test("invalid execution or auto-review settings never publish a workspace", async (t) => {
  const e = await fixture(t);
  for (const settings of [
    { config: null },
    { config: [] },
    { config: { ...config, model: "test/missing" } },
    { config: { ...config, model: "test/unavailable" } },
    { config: { ...config, thinking: "invalid" } },
    { config: { ...config, thinkingMode: "invalid" } },
    { config: { ...config, effort: "invalid" } },
    { config: { ...config, effort: "high" } },
    { config: { ...config, longTask: "yes" } },
    { config, approvalMode: "auto" },
    { config, approvalMode: "auto", safetyModel: DEFAULT_CONFIG.model },
    { config, approvalMode: "auto", safetyModel: "test/unavailable" },
  ]) {
    const result = await e.create({ title: "无效设置", ...settings });
    assert.equal(result.status, 400, JSON.stringify(settings));
    assert.ok(result.body.error);
    assert.equal(e.store.data.workspaces.length, 0);
  }
});

test("failed persistence leaves creation retryable without a phantom workspace", async (t) => {
  const e = await fixture(t);
  const body = {
    title: "重试创建",
    config,
    approvalMode: "auto",
    safetyModel: "test/reviewer",
  };
  await rename(e.dataDirectory, `${e.dataDirectory}-saved`);
  const failed = await e.create(body);
  assert.equal(failed.status, 400);
  assert.equal(e.store.data.workspaces.length, 0);
  await rename(`${e.dataDirectory}-saved`, e.dataDirectory);
  const retry = await e.create(body);
  assert.equal(retry.status, 201);
  assert.equal(e.store.data.workspaces.length, 1);
});
