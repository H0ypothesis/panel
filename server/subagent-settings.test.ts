import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { LocalSubagentSettings } from "./subagent-settings.ts";
import { PiRuntime } from "./runtime.ts";
import { Store } from "./store.ts";
import { Scheduler } from "./scheduler.ts";
import { createApi } from "./api.ts";

test("subagent settings persist through the API and reject invalid or cross-origin changes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "panel-subagent-settings-"));
  const runtime = new PiRuntime();
  await runtime.initSubagentSettings(directory);
  const store = new Store(directory);
  await store.init(false);
  const scheduler = new Scheduler(store, runtime);
  t.after(async () => {
    scheduler.shutdown();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  const api = createApi(store, runtime, scheduler);
  async function call(method: string, body?: unknown, origin?: string) {
    const request = Readable.from(
      body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
    ) as IncomingMessage;
    Object.assign(request, {
      method,
      url: "/api/subagent-settings",
      headers: {
        host: "127.0.0.1:9999",
        "content-type": "application/json",
        ...(origin ? { origin } : {}),
      },
    });
    let status = 0;
    let result: any;
    await api(request, {
      setHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(body: string) {
        result = JSON.parse(body);
      },
    } as unknown as ServerResponse);
    return { status, result };
  }
  assert.deepEqual(await call("GET"), {
    status: 200,
    result: { maxConcurrentSubagents: 4 },
  });
  const initial = runtime.subagentSettings();
  for (const value of [0, -1, 9, 1.5, "4", null, undefined]) {
    assert.equal(
      (await call("PUT", { maxConcurrentSubagents: value })).status,
      400,
    );
    assert.deepEqual(runtime.subagentSettings(), initial);
  }
  assert.equal(
    (
      await call(
        "PUT",
        { maxConcurrentSubagents: 6 },
        "https://foreign.invalid",
      )
    ).status,
    403,
  );
  assert.equal((await call("PUT", { maxConcurrentSubagents: 6 })).status, 200);
  assert.deepEqual((await call("GET")).result, { maxConcurrentSubagents: 6 });
  assert.equal(
    initial.maxConcurrentSubagents,
    4,
    "existing snapshots retain their value",
  );
  const reloaded = new LocalSubagentSettings(directory);
  await reloaded.init();
  assert.equal(reloaded.current().maxConcurrentSubagents, 6);
  assert.ok(
    !JSON.stringify(store.snapshot()).includes("maxConcurrentSubagents"),
  );
});

test("failed saves retain the last persisted setting and do not break subsequent writes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "panel-subagent-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new LocalSubagentSettings(directory);
  await settings.init();
  const path = join(directory, "subagent-settings.json");
  await mkdir(path);
  await assert.rejects(
    settings.save({ maxConcurrentSubagents: 7 }),
    /无法保存/,
  );
  assert.equal(settings.current().maxConcurrentSubagents, 4);
  await rm(path, { recursive: true });
  await Promise.all([
    settings.save({ maxConcurrentSubagents: 2 }),
    settings.save({ maxConcurrentSubagents: 5 }),
  ]);
  const reloaded = new LocalSubagentSettings(directory);
  await reloaded.init();
  assert.equal(reloaded.current().maxConcurrentSubagents, 5);
});

test("native limits and budgets persist independently and cannot be mutated through returned snapshots", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "panel-native-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = new LocalSubagentSettings(directory);
  await settings.init();
  const nativeOptions = {
    maxSubagentDepth: 4,
    maxActiveAsyncRunsPerSession: 6,
    asyncByDefault: true,
    usageBudget: { tokens: { soft: 100, hard: 200 } },
  };
  const saved = await settings.save({
    maxConcurrentSubagents: 3,
    nativeOptions,
  });
  saved.nativeOptions!.usageBudget!.tokens!.hard = 1;
  nativeOptions.maxSubagentDepth = 16;
  assert.equal(
    settings.current().nativeOptions!.usageBudget!.tokens!.hard,
    200,
  );
  assert.equal(settings.current().nativeOptions!.maxSubagentDepth, 4);
  const reloaded = new LocalSubagentSettings(directory);
  await reloaded.init();
  assert.deepEqual(reloaded.current(), settings.current());
  for (const nativeOptions of [
    { maxSubagentDepth: 17 },
    { maxSubagentDepth: -1 },
    { maxActiveAsyncRunsPerSession: 0 },
    { asyncByDefault: "yes" },
    { usageBudget: { tokens: { soft: 200, hard: 100 } } },
    { usageBudget: { costUsd: { hard: 0 } } },
    { unexpected: true },
  ])
    await assert.rejects(
      settings.save({ maxConcurrentSubagents: 3, nativeOptions }),
    );
  assert.deepEqual(reloaded.current(), settings.current());
});
