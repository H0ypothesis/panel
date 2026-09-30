import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AppState,
  ModelOption,
  RunConfig,
  ToolCall,
} from "../shared/types.ts";
import { createApi } from "./api.ts";
import { CuaLocks } from "./cua-locks.ts";
import type { RunEnvironment, Runtime } from "./runtime.ts";
import { NodeMutationConflict, Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store } from "./store.ts";

const config: RunConfig = { model: "test/takeover", thinking: "off" };
const model: ModelOption = {
  id: config.model,
  name: "Takeover fixture",
  provider: "test",
  providerName: "Test",
  available: true,
  demo: false,
  supportsImages: true,
  thinkingLevels: ["off"],
  contextWindow: 128000,
};
const target = { kind: "window" as const, pid: 100, windowId: 1 };
const call = (
  tool = "get_window_state",
  args: Record<string, unknown> = {},
): Pick<ToolCall, "id" | "name" | "arguments"> => ({
  id: randomUUID(),
  name: "computer_use_call",
  arguments: { tool, target, arguments: args },
});
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("Timed out waiting for takeover state");
}

async function fixture(
  t: TestContext,
  approvalMode: "auto" | "ask" = "auto",
  concurrency = Infinity,
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-takeover-")),
  );
  const project = join(directory, "project");
  await mkdir(project);
  const stateDirectory = join(directory, "state");
  const store = new Store(stateDirectory);
  await store.init(false);
  const workspace = createWorkspace("Takeover", "Test");
  workspace.workingDirectory = project;
  workspace.approvalMode = approvalMode;
  workspace.safetyModel = config.model;
  store.data.workspaces.push(workspace);
  const runs: Array<{
    execution: RunEnvironment;
    signal: AbortSignal;
    finish: ReturnType<typeof gate<void>>;
  }> = [];
  const reviews: string[] = [];
  let review: Runtime["reviewTool"] = async () => ({
    decision: "approve",
    reason: "fixture",
  });
  const runtime: Runtime = {
    models: () => [model],
    computerUseStatus: () => ({
      available: true,
      connected: true,
      overlay: true,
    }),
    reviewTool: async (request, signal) => {
      reviews.push(request.tool.id);
      return review!(request, signal);
    },
    async run(_config, _history, _prompt, signal, _onText, execution) {
      assert.ok(execution);
      const finish = gate();
      runs.push({ execution, signal, finish });
      signal.addEventListener("abort", () => finish.resolve(), { once: true });
      await finish.promise;
      signal.throwIfAborted();
      return { messages: [], response: "Done" };
    },
  };
  const scheduler = new Scheduler(store, runtime, concurrency);
  const promises: Promise<unknown>[] = [];
  const originalSave = store.save.bind(store);
  t.after(async () => {
    store.save = originalSave;
    scheduler.shutdown();
    for (const run of runs) run.finish.resolve();
    await Promise.allSettled(promises);
    await delay(10);
    await store.save();
    await rm(directory, { recursive: true, force: true });
  });
  const submit = async (explicit = true) =>
    scheduler.submit(workspace.id, {
      parentId: workspace.nodes[0].id,
      prompt: "Inspect this application",
      config,
      toolRequests: explicit ? ["computer_use"] : undefined,
      requestId: randomUUID(),
    });
  const start = async (explicit = true) => {
    const index = runs.length;
    const node = await submit(explicit);
    await until(() => runs.length > index);
    return { node, ...runs[index] };
  };
  const track = <T>(promise: Promise<T>) => {
    promises.push(promise);
    void promise.catch(() => {});
    return promise;
  };
  return {
    store,
    workspace,
    scheduler,
    runtime,
    reviews,
    runs,
    start,
    submit,
    track,
    originalSave,
    stateDirectory,
    setReview: (next: NonNullable<Runtime["reviewTool"]>) => {
      review = next;
    },
    enable: (node: { id: string; revision?: number }, enabled = true) =>
      scheduler.setComputerUseTakeover(
        workspace.id,
        node.id,
        enabled,
        node.revision ?? 0,
      ),
  };
}

test("takeover skips repeated reviews after preflight and issues audited single-use tokens", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  await f.enable(run.node);
  let preparations = 0;
  let executions = 0;
  for (const input of [call(), call("scroll", { direction: "down" })]) {
    assert.equal(
      await run.execution.beforeToolCall(input, async () => {
        preparations++;
      }),
      true,
    );
    const audit = run.node.toolCalls!.find((item) => item.id === input.id)!;
    assert.equal(audit.approval, "cua_takeover");
    assert.equal(audit.safetyReview, undefined);
    assert.ok(audit.authorization);
    await run.execution.executeTool(input, async () => {
      executions++;
    });
    assert.ok(audit.authorization!.consumedAt);
    await assert.rejects(
      run.execution.executeTool(input, async () => {
        executions++;
      }),
    );
  }
  assert.equal(preparations, 2);
  assert.equal(executions, 2);
  assert.deepEqual(f.reviews, []);
});

test("disabled takeover and noneligible operations retain ordinary model reviews", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  await run.execution.beforeToolCall(call(), async () => {});
  await f.enable(run.node);
  for (const input of [
    call("click", { x: 5, y: 5 }),
    call("type_text", { text: "hello" }),
    { id: randomUUID(), name: "bash", arguments: { command: "pwd" } },
  ])
    await run.execution.beforeToolCall(input, async () => {});
  await f.enable(run.node, false);
  await run.execution.beforeToolCall(call(), async () => {});
  assert.equal(f.reviews.length, 5);
  assert.ok(
    run.node.toolCalls!.every((item) => item.approval === "safety_model"),
  );
});

test("takeover is isolated between simultaneous cards", async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  const second = await f.start();
  await f.enable(first.node);
  await Promise.all([
    first.execution.beforeToolCall(call(), async () => {}),
    second.execution.beforeToolCall(call(), async () => {}),
  ]);
  assert.equal(first.node.toolCalls![0].approval, "cua_takeover");
  assert.equal(second.node.toolCalls![0].approval, "safety_model");
  assert.equal(second.node.computerUseTakeover, undefined);
  assert.equal(f.reviews.length, 1);
});

test("takeover preserves target locks and rejects invalid preflight without approval", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  await f.enable(run.node);
  const locks = new CuaLocks();
  t.after(() => {
    locks.releaseOwner("other");
    locks.releaseOwner("current");
  });
  await locks.acquireTarget("other", target);
  const input = call();
  const prepared = f.track(
    run.execution.beforeToolCall(input, (onWait) =>
      locks.acquireTarget("current", target, run.signal, onWait).then(() => {}),
    ),
  );
  await until(() => Boolean(run.node.toolCalls?.[0]?.waitingFor));
  assert.equal(run.node.toolCalls![0].authorization, undefined);
  assert.equal(f.reviews.length, 0);
  locks.releaseOwner("other");
  assert.equal(await prepared, true);
  await assert.rejects(
    run.execution.beforeToolCall(call(), async () => {
      throw new Error("invalid driver schema");
    }),
    /invalid driver schema/,
  );
  assert.equal(run.node.toolCalls![1].status, "failed");
  assert.equal(run.node.toolCalls![1].authorization, undefined);
});

test("enabling during target preparation does not grandfather the existing call", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  const waiting = gate();
  const ready = gate();
  const pending = f.track(
    run.execution.beforeToolCall(call(), async () => {
      ready.resolve();
      await waiting.promise;
    }),
  );
  await ready.promise;
  await f.enable(run.node);
  waiting.resolve();
  assert.equal(await pending, true);
  assert.equal(run.node.toolCalls![0].approval, "safety_model");
  assert.equal(f.reviews.length, 1);
});

test("enabling does not override an in-flight review or its pending rejection", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  const reviewing = gate();
  const verdict = gate();
  f.setReview(async () => {
    reviewing.resolve();
    await verdict.promise;
    return { decision: "deny", reason: "needs confirmation" };
  });
  const input = call();
  const pending = f.track(run.execution.beforeToolCall(input, async () => {}));
  await reviewing.promise;
  await f.enable(run.node);
  assert.equal(run.node.toolCalls![0].status, "reviewing");
  verdict.resolve();
  await until(() => run.node.toolCalls![0].status === "awaiting_approval");
  assert.equal(run.node.toolCalls![0].authorization, undefined);
  await f.scheduler.approve(f.workspace.id, run.node.id, input.id, "deny", 0);
  assert.equal(await pending, false);
  assert.equal(run.node.toolCalls![0].approval, "denied");
  await run.execution.beforeToolCall(call(), async () => {});
  assert.equal(run.node.toolCalls![1].approval, "cua_takeover");
  assert.equal(f.reviews.length, 1);
});

test("existing manual approval remains pending when takeover is enabled", async (t) => {
  const f = await fixture(t, "ask");
  const run = await f.start();
  const input = call();
  const pending = f.track(run.execution.beforeToolCall(input, async () => {}));
  await until(() => run.node.toolCalls?.[0]?.status === "awaiting_approval");
  await f.enable(run.node);
  assert.equal(run.node.toolCalls![0].status, "awaiting_approval");
  assert.equal(run.node.toolCalls![0].authorization, undefined);
  await f.scheduler.approve(f.workspace.id, run.node.id, input.id, "deny", 0);
  assert.equal(await pending, false);
  assert.equal(
    await run.execution.beforeToolCall(call(), async () => {}),
    true,
  );
  assert.equal(run.node.toolCalls![1].approval, "cua_takeover");
});

test("disable immediately revokes unused tokens, including after re-enabling", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  await f.enable(run.node);
  const input = call();
  await run.execution.beforeToolCall(input, async () => {});
  await f.enable(run.node, false);
  assert.ok(run.node.toolCalls![0].authorization!.invalidatedAt);
  await f.enable(run.node);
  let dispatched = false;
  await assert.rejects(
    run.execution.executeTool(input, async () => {
      dispatched = true;
    }),
  );
  assert.equal(dispatched, false);
});

test("duplicate enabled request preserves the already-issued grant", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  await f.enable(run.node);
  const input = call();
  await run.execution.beforeToolCall(input, async () => {});
  await f.enable(run.node);
  let dispatched = false;
  await run.execution.executeTool(input, async () => {
    dispatched = true;
  });
  assert.equal(dispatched, true);
});

test("disable during consumed-token persistence blocks dispatch even if enabled again", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  await f.enable(run.node);
  const input = call();
  await run.execution.beforeToolCall(input, async () => {});
  const saving = gate();
  const resume = gate();
  let hold = true;
  f.store.save = async (...args) => {
    if (
      hold &&
      run.node.toolCalls![0].authorization?.consumedAt !== undefined
    ) {
      hold = false;
      saving.resolve();
      await resume.promise;
    }
    return f.originalSave(...args);
  };
  let dispatched = false;
  const execution = f.track(
    run.execution.executeTool(input, async () => {
      dispatched = true;
    }),
  );
  await saving.promise;
  await f.enable(run.node, false);
  await f.enable(run.node);
  resume.resolve();
  await assert.rejects(execution, /接管/);
  assert.equal(dispatched, false);
  assert.equal(run.node.toolCalls![0].status, "failed");
});

test("disable during token issuance records a failed call without a phantom running state", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  await f.enable(run.node);
  const saving = gate();
  const resume = gate();
  let hold = true;
  f.store.save = async (...args) => {
    if (hold && run.node.toolCalls?.[0]?.approval === "cua_takeover") {
      hold = false;
      saving.resolve();
      await resume.promise;
    }
    return f.originalSave(...args);
  };
  const pending = f.track(run.execution.beforeToolCall(call(), async () => {}));
  await saving.promise;
  await f.enable(run.node, false);
  resume.resolve();
  await assert.rejects(pending, /接管/);
  assert.equal(run.node.toolCalls![0].status, "failed");
  assert.ok(run.node.toolCalls![0].finishedAt);
  assert.ok(run.node.toolCalls![0].authorization!.invalidatedAt);
});

test("disable does not interrupt an operation already dispatched", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  await f.enable(run.node);
  const input = call();
  await run.execution.beforeToolCall(input, async () => {});
  const dispatched = gate();
  const done = gate();
  const execution = f.track(
    run.execution.executeTool(input, async () => {
      dispatched.resolve();
      await done.promise;
      return "finished";
    }),
  );
  await dispatched.promise;
  await f.enable(run.node, false);
  assert.equal(run.signal.aborted, false);
  done.resolve();
  assert.equal(await execution, "finished");
});

test("failed grant persistence stays disabled and does not suppress reviews", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  let fail = true;
  f.store.save = async (...args) => {
    if (fail) {
      fail = false;
      throw new Error("disk full");
    }
    return f.originalSave(...args);
  };
  await assert.rejects(f.enable(run.node), /disk full/);
  assert.equal(run.node.computerUseTakeover, undefined);
  await run.execution.beforeToolCall(call(), async () => {});
  assert.equal(f.reviews.length, 1);
});

test("latest toggle wins over an earlier enable whose save is still pending", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  const saving = gate();
  const resume = gate();
  let hold = true;
  f.store.save = async (...args) => {
    if (hold) {
      hold = false;
      saving.resolve();
      await resume.promise;
    }
    return f.originalSave(...args);
  };
  const enable = f.track(f.enable(run.node));
  await saving.promise;
  const disable = f.track(f.enable(run.node, false));
  resume.resolve();
  await assert.rejects(enable, NodeMutationConflict);
  await disable;
  assert.equal(run.node.computerUseTakeover, undefined);
  await run.execution.beforeToolCall(call(), async () => {});
  assert.equal(f.reviews.length, 1);
});

test("only live CUA cards and their current revision can receive a grant", async (t) => {
  const f = await fixture(t);
  const run = await f.start(false);
  await assert.rejects(f.enable(run.node), /尚未使用/);
  await run.execution.beforeToolCall(call(), async () => {});
  await assert.rejects(
    f.scheduler.setComputerUseTakeover(f.workspace.id, run.node.id, true, 1),
    NodeMutationConflict,
  );
  await assert.rejects(
    f.scheduler.setComputerUseTakeover(
      f.workspace.id,
      run.node.id,
      "true" as unknown as boolean,
      0,
    ),
    /布尔/,
  );
  await f.enable(run.node);
  run.finish.resolve();
  await until(() => run.node.status === "completed");
  assert.equal(run.node.computerUseTakeover, undefined);
  await assert.rejects(f.enable(run.node), NodeMutationConflict);
});

test("a queued explicit CUA card can enable takeover before execution starts", async (t) => {
  const f = await fixture(t, "auto", 1);
  const first = await f.start();
  const queued = await f.submit();
  assert.equal(queued.status, "queued");
  await f.enable(queued);
  first.finish.resolve();
  await until(() => f.runs.length === 2);
  await f.runs[1].execution.beforeToolCall(call(), async () => {});
  assert.equal(queued.toolCalls![0].approval, "cua_takeover");
});

test("cancel and retry do not transfer takeover to the replacement run", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  await f.enable(run.node);
  await f.scheduler.cancel(f.workspace.id, run.node.id);
  await until(
    () =>
      !(
        f.scheduler as unknown as { active: Map<string, AbortController> }
      ).active.has(run.node.id),
  );
  assert.equal(run.node.computerUseTakeover, undefined);
  const retried = await f.scheduler.retry(f.workspace.id, run.node.id, {
    expectedRevision: 0,
    requestId: randomUUID(),
  });
  await until(() => f.runs.length === 2);
  assert.equal(retried.computerUseTakeover, undefined);
  assert.equal(retried.previousRuns![0].computerUseTakeover, undefined);
  await f.runs[1].execution.beforeToolCall(call(), async () => {});
  assert.equal(retried.toolCalls![0].approval, "safety_model");
  await assert.rejects(
    f.scheduler.setComputerUseTakeover(f.workspace.id, retried.id, true, 0),
    NodeMutationConflict,
  );
});

test("service restart clears the live takeover flag and leaves historical approvals as audit only", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  await f.enable(run.node);
  await run.execution.beforeToolCall(call(), async () => {});
  await f.store.save();
  const reloaded = new Store(f.stateDirectory);
  await reloaded.init(false);
  const loaded = reloaded
    .workspace(f.workspace.id)
    .nodes.find((item) => item.id === run.node.id)!;
  assert.equal(loaded.computerUseTakeover, undefined);
  assert.equal(loaded.status, "failed");
  assert.equal(loaded.toolCalls![0].approval, "cua_takeover");
  assert.ok(loaded.toolCalls![0].authorization!.invalidatedAt);
  f.scheduler.shutdown();
  assert.equal(run.node.computerUseTakeover, undefined);
});

test("takeover API validates flags, revisions, origin and returns state plus capability", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  const api = createApi(f.store, f.runtime, f.scheduler);
  const server = createServer((request, response) => {
    void api(request, response).catch((error) => response.destroy(error));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const path = `${base}/api/workspaces/${f.workspace.id}/nodes/${run.node.id}/computer-use-takeover`;
  const post = (body: unknown, origin = base) =>
    fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      (await (await fetch(`${base}/api/capabilities`)).json()) as {
        computerUseTakeover: boolean;
      }
    ).computerUseTakeover,
    true,
  );
  for (const body of [
    {},
    { enabled: "true", expectedRevision: 0 },
    { enabled: true },
    { enabled: true, expectedRevision: -1 },
  ])
    assert.equal((await post(body)).status, 400);
  assert.equal(
    (await post({ enabled: true, expectedRevision: 1 })).status,
    409,
  );
  assert.equal(
    (
      await post(
        { enabled: true, expectedRevision: 0 },
        "https://untrusted.example",
      )
    ).status,
    403,
  );
  assert.equal(run.node.computerUseTakeover, undefined);
  const response = await post({ enabled: true, expectedRevision: 0 });
  assert.equal(response.status, 200);
  const state = (await response.json()) as AppState;
  assert.equal(
    state.workspaces[0].nodes.find((node) => node.id === run.node.id)!
      .computerUseTakeover,
    true,
  );
});

const taskScope = {
  id: "live-page",
  label: "Example page",
  origin: "https://example.com",
  target: { kind: "page" as const, pid: 100, windowId: 1, tabId: "tab1" },
};
const taskCall = (tool = "browser_type") => ({
  id: randomUUID(),
  name: "computer_use_call",
  arguments: {
    tool,
    target: taskScope.target,
    arguments: { ref: "p1:1", text: "query" },
  },
});

test("task control requires live adapter scope, isolates cards, and bypasses repeated routine actions", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  const other = await f.start();
  const enable = () =>
    f.scheduler.setComputerUseTakeover(f.workspace.id, run.node.id, true, 0, {
      mode: "task",
      scopeId: taskScope.id,
    });
  await assert.rejects(enable(), /观察目标已变化/);
  run.execution.onComputerUseScope!(taskScope);
  await enable();
  assert.deepEqual(run.node.computerUseTaskScope, taskScope);
  const context = {
    scope: taskScope,
    routine: true,
    sensitive: false,
    reason: "search field",
    authorizeTask: () => {},
  };
  for (let i = 0; i < 3; i++)
    await run.execution.beforeToolCall(taskCall(), async () => context);
  assert.equal(f.reviews.length, 0);
  assert.ok(run.node.toolCalls!.every((c) => c.approval === "cua_takeover"));
  await other.execution.beforeToolCall(taskCall(), async () => context);
  assert.equal(f.reviews.length, 1);
  await run.execution.beforeToolCall(taskCall(), async () => ({
    ...context,
    scope: { ...taskScope, id: "other-site", origin: "https://other.example" },
  }));
  assert.equal(f.reviews.length, 2);
});

test("known sensitive task actions still require human approval in automatic mode", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  run.execution.onComputerUseScope!(taskScope);
  await f.scheduler.setComputerUseTakeover(
    f.workspace.id,
    run.node.id,
    true,
    0,
    { mode: "task", scopeId: taskScope.id },
  );
  const input = taskCall("browser_click");
  const pending = f.track(
    run.execution.beforeToolCall(input, async () => ({
      scope: taskScope,
      routine: false,
      sensitive: true,
      reason: "付款需要批准",
    })),
  );
  await until(() => run.node.toolCalls?.[0]?.status === "awaiting_approval");
  assert.equal(f.reviews.length, 0);
  assert.equal(run.node.toolCalls![0].authorization, undefined);
  await f.scheduler.approve(f.workspace.id, run.node.id, input.id, "deny", 0);
  assert.equal(await pending, false);
});

test("changing task scope revokes dispatched guards and old unused authorizations", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  run.execution.onComputerUseScope!(taskScope);
  await f.scheduler.setComputerUseTakeover(
    f.workspace.id,
    run.node.id,
    true,
    0,
    { mode: "task", scopeId: taskScope.id },
  );
  let guard!: () => void;
  const input = taskCall();
  await run.execution.beforeToolCall(input, async () => ({
    scope: taskScope,
    routine: true,
    sensitive: false,
    reason: "search",
    authorizeTask: (assertActive) => {
      guard = assertActive;
    },
  }));
  guard();
  await f.enable(run.node, false);
  assert.throws(guard, /接管/);
  assert.equal(run.node.computerUseTaskScope, undefined);
  await assert.rejects(run.execution.executeTool(input, async () => {}));
});

test("task scopes expire on completion and cannot be resurrected from state", async (t) => {
  const f = await fixture(t);
  const run = await f.start();
  run.execution.onComputerUseScope!(taskScope);
  await f.scheduler.setComputerUseTakeover(
    f.workspace.id,
    run.node.id,
    true,
    0,
    { mode: "task", scopeId: taskScope.id },
  );
  const loaded = new Store(f.stateDirectory);
  await loaded.init(false);
  const node = loaded
    .workspace(f.workspace.id)
    .nodes.find((n) => n.id === run.node.id)!;
  assert.equal(node.computerUseScope, undefined);
  assert.equal(node.computerUseTaskScope, undefined);
  run.finish.resolve();
  await until(() => run.node.status === "completed");
  assert.equal(run.node.computerUseScope, undefined);
  assert.equal(run.node.computerUseTaskScope, undefined);
});
