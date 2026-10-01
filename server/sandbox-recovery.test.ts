import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { ModelOption, RunConfig, ToolCall } from "../shared/types.ts";
import {
  codingSandboxScope,
  createPanelTools,
  isCodingExecutionStartedNotice,
} from "./coding-tools.ts";
import type { RunEnvironment, Runtime } from "./runtime.ts";
import { SandboxSetupError } from "./sandbox-errors.ts";
import {
  checkSandbox,
  prepareSandboxWithRetry,
  type SandboxPreparation,
} from "./sandbox.ts";
import { Scheduler } from "./scheduler.ts";
import { createWorkspace } from "./seed.ts";
import { Store } from "./store.ts";

const config: RunConfig = { model: "test/sandbox-recovery", thinking: "off" };
const model: ModelOption = {
  id: config.model,
  name: "Recovery test",
  provider: "test",
  providerName: "Test",
  available: true,
  demo: false,
  thinkingLevels: ["off"],
  contextWindow: 128000,
};
const setupFailure = () =>
  new SandboxSetupError("dependencies", "缺少测试沙盒依赖，命令未执行。");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("Timed out waiting for recovery state");
}
async function directoryFixture(t: TestContext, clean = true) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-recovery-")),
  );
  const project = join(directory, "project");
  await mkdir(project);
  if (clean) t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, project };
}
function ready(command: string, temporary: string) {
  return { command, temporary, alive: () => true, close: async () => {} };
}

test("preflight closes setup without dispatching the wrapped command", async (t) => {
  const { project } = await directoryFixture(t);
  let closed = 0;
  const marker = join(project, "not-executed");
  const checked = await checkSandbox(project, undefined, async () => ({
    ...ready(`touch ${quote(marker)}`, project),
    close: async () => {
      closed++;
    },
  }));
  assert.deepEqual(checked, { attempts: 1 });
  assert.equal(closed, 1);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("only transient setup failures are automatically retried, at most once", async (t) => {
  const { project } = await directoryFixture(t);
  let attempts = 0;
  const transient: SandboxPreparation = async () => {
    attempts++;
    throw new SandboxSetupError("worker_exit", "worker exited");
  };
  await assert.rejects(
    prepareSandboxWithRetry(transient, "true", project),
    SandboxSetupError,
  );
  assert.equal(attempts, 2);
  for (const code of ["dependencies", "unsupported"] as const) {
    attempts = 0;
    await assert.rejects(
      prepareSandboxWithRetry(
        async () => {
          attempts++;
          throw new SandboxSetupError(code, code);
        },
        "true",
        project,
      ),
      SandboxSetupError,
    );
    assert.equal(attempts, 1);
  }
  attempts = 0;
  await assert.rejects(
    prepareSandboxWithRetry(
      async () => {
        attempts++;
        throw new Error("invalid workspace policy");
      },
      "true",
      project,
    ),
    /workspace policy/,
  );
  assert.equal(attempts, 1);
  const controller = new AbortController();
  attempts = 0;
  await assert.rejects(
    prepareSandboxWithRetry(
      async () => {
        attempts++;
        controller.abort();
        throw new SandboxSetupError("timeout", "setup timed out");
      },
      "true",
      project,
      controller.signal,
    ),
    /abort/i,
  );
  assert.equal(attempts, 1);
});

test("automatic setup recovery executes the command once without asking for host access", async (t) => {
  const { project } = await directoryFixture(t);
  let attempts = 0;
  let recoveries = 0;
  const bash = createPanelTools(project, undefined, {
    prepare: async (command) => {
      if (++attempts === 1)
        throw new SandboxSetupError("worker_exit", "worker exited");
      return ready(command, project);
    },
    recover: async () => {
      recoveries++;
      throw new Error("must not recover");
    },
  }).find((tool) => tool.name === "bash")!;
  await bash.execute("retry", { command: "printf once >> progress.txt" });
  assert.equal(attempts, 2);
  assert.equal(recoveries, 0);
  assert.equal(await readFile(join(project, "progress.txt"), "utf8"), "once");
});

test("a command that started and then failed is never replayed or offered host recovery", async (t) => {
  const { project } = await directoryFixture(t);
  let recoveries = 0;
  const bash = createPanelTools(project, undefined, {
    prepare: async (command) => ready(command, project),
    recover: async () => {
      recoveries++;
      throw new Error("must not recover");
    },
  }).find((tool) => tool.name === "bash")!;
  await assert.rejects(
    bash.execute("failure", { command: "printf once >> progress.txt; exit 3" }),
    /exited with code 3/,
  );
  assert.equal(recoveries, 0);
  assert.equal(await readFile(join(project, "progress.txt"), "utf8"), "once");
});

test("recovery waiting neither starts the execution deadline nor publishes a shell-start notice", async (t) => {
  const { project } = await directoryFixture(t);
  let choose!: () => void;
  let waiting!: () => void;
  const entered = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const decision = new Promise<void>((resolve) => {
    choose = resolve;
  });
  let started = 0;
  const bash = createPanelTools(project, undefined, {
    prepare: async () => {
      throw setupFailure();
    },
    recover: async (_request, execute) => {
      waiting();
      await decision;
      return execute("host", () => {});
    },
  }).find((tool) => tool.name === "bash")!;
  const run = bash.execute(
    "waiting",
    { command: "printf once > result.txt", timeout: 0.1 },
    undefined,
    (update) => {
      if (isCodingExecutionStartedNotice(update)) started++;
    },
  );
  await entered;
  await delay(200);
  assert.equal(started, 0);
  await assert.rejects(readFile(join(project, "result.txt")), {
    code: "ENOENT",
  });
  choose();
  await run;
  assert.equal(started, 1);
  assert.equal(await readFile(join(project, "result.txt"), "utf8"), "once");
});

async function executionFixture(
  t: TestContext,
  commands: string[] = ["printf host >> result.txt"],
) {
  const { directory, project } = await directoryFixture(t, false);
  const store = new Store(join(directory, "state"));
  await store.init(false);
  const workspace = createWorkspace("Sandbox recovery", "Test");
  workspace.workingDirectory = project;
  workspace.approvalMode = "auto";
  workspace.safetyModel = config.model;
  store.data.workspaces.push(workspace);
  let execution!: RunEnvironment;
  let reviews = 0;
  let attempts = 0;
  let fixed = false;
  const controller = new AbortController();
  const runtime: Runtime = {
    models: () => [model],
    reviewTool: async () => {
      reviews++;
      return { decision: "approve", reason: "Test" };
    },
    async run(_config, _history, _prompt, signal, _onText, environment) {
      assert.ok(environment);
      execution = environment;
      const activeSignal = AbortSignal.any([signal, controller.signal]);
      const bash = createPanelTools(project, undefined, {
        preflight: Promise.resolve({ attempts: 1, error: setupFailure() }),
        prepare: async (command) => {
          attempts++;
          if (!fixed) throw setupFailure();
          return ready(command, project);
        },
        recover: environment.recoverSandbox,
      }).find((tool) => tool.name === "bash")!;
      for (let index = 0; index < commands.length; index++) {
        const call = {
          id: `bash-${index}`,
          name: "bash",
          arguments: { command: commands[index], timeout: 120 },
          sandbox: codingSandboxScope(bash, project),
          workingDirectory: project,
        };
        if (!(await environment.beforeToolCall(call, undefined, activeSignal)))
          continue;
        try {
          const result = await environment.executeTool(
            call,
            () => bash.execute(call.id, call.arguments, activeSignal),
            activeSignal,
          );
          environment.onToolUpdate(call.id, {
            status: "completed",
            output: result.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join(""),
          });
        } catch (error) {
          environment.onToolUpdate(call.id, {
            status: activeSignal.aborted ? "cancelled" : "failed",
            error: String(error),
          });
          throw error;
        }
      }
      return { messages: [], response: "Finished" };
    },
  };
  const scheduler = new Scheduler(store, runtime);
  t.after(async () => {
    scheduler.shutdown();
    controller.abort();
    await delay(30);
    await store.save();
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const node = await scheduler.submit(workspace.id, {
    parentId: workspace.nodes[0].id,
    prompt: "Run the requested command",
    config,
    requestId: randomUUID(),
  });
  const pending = () =>
    node.toolCalls?.find(
      (call) =>
        call.name === "sandbox_recovery" && call.status === "awaiting_approval",
    );
  await until(() => !!pending());
  const approve = (
    decision: "approve" | "retry_sandbox" | "deny" | "approve_tool",
  ) => scheduler.approve(workspace.id, node.id, pending()!.id, decision);
  return {
    directory,
    project,
    store,
    workspace,
    node,
    scheduler,
    approve,
    pending,
    execution: () => execution,
    reviews: () => reviews,
    attempts: () => attempts,
    fix: () => {
      fixed = true;
    },
    controller,
  };
}

test("auto approval still requires a human for each host command and consumes a scoped single-use grant", async (t) => {
  const env = await executionFixture(t, [
    "printf one >> result.txt",
    "printf two >> result.txt",
  ]);
  const first = env.pending()!;
  assert.equal(env.reviews(), 0);
  assert.equal(env.attempts(), 0);
  assert.equal(first.arguments.command, "printf one >> result.txt");
  assert.equal(first.workingDirectory, env.project);
  await assert.rejects(readFile(join(env.project, "result.txt")), {
    code: "ENOENT",
  });
  await assert.rejects(env.approve("approve_tool"), /不能批量/);
  await env.approve("approve");
  await until(() => !!env.pending() && env.pending()!.id !== first.id);
  assert.equal(await readFile(join(env.project, "result.txt"), "utf8"), "one");
  assert.equal(first.arguments.recoveryAction, "host");
  assert.ok(first.authorization?.consumedAt);
  assert.equal(env.node.toolCalls![0].executionMode, "host");
  await assert.rejects(
    env.scheduler.approve(env.workspace.id, env.node.id, first.id, "approve"),
    /失效/,
  );
  await env.approve("approve");
  await until(() => env.node.status === "completed");
  assert.equal(
    await readFile(join(env.project, "result.txt"), "utf8"),
    "onetwo",
  );
  assert.equal(env.reviews(), 0);
  const records = env.node.toolCalls!.filter(
    (call) => call.name === "sandbox_recovery",
  );
  assert.notEqual(
    records[0].authorization!.actionHash,
    records[1].authorization!.actionHash,
  );
});

test("retry after fixing dependencies repairs preflight for subsequent commands without granting host execution", async (t) => {
  const env = await executionFixture(t, [
    "printf one >> result.txt",
    "printf two >> result.txt",
  ]);
  env.fix();
  const record = env.pending()!;
  await env.approve("retry_sandbox");
  await until(() => env.node.status === "completed");
  assert.equal(env.attempts(), 2);
  assert.equal(record.arguments.recoveryAction, "retry");
  assert.ok(record.authorization?.consumedAt);
  assert.equal(env.node.toolCalls![0].executionMode, undefined);
  assert.equal(
    await readFile(join(env.project, "result.txt"), "utf8"),
    "onetwo",
  );
  assert.equal(
    env.node.toolCalls!.filter((call) => call.name === "sandbox_recovery")
      .length,
    1,
  );
});

test("an unsuccessful explicit retry returns to recovery without executing the command", async (t) => {
  const env = await executionFixture(t);
  const previous = env.pending()!;
  await env.approve("retry_sandbox");
  await until(() => !!env.pending() && env.pending()!.id !== previous.id);
  assert.equal(previous.status, "failed");
  assert.equal(env.attempts(), 1);
  await assert.rejects(readFile(join(env.project, "result.txt")), {
    code: "ENOENT",
  });
  await env.approve("deny");
  await until(() => env.node.status === "failed");
});

for (const decision of ["deny", "cancel"] as const) {
  test(`${decision} during recovery never executes the host command`, async (t) => {
    const env = await executionFixture(t);
    const record = env.pending()!;
    if (decision === "deny") await env.approve("deny");
    else await env.scheduler.cancel(env.workspace.id, env.node.id);
    await until(() => ["failed", "cancelled"].includes(env.node.status));
    await assert.rejects(readFile(join(env.project, "result.txt")), {
      code: "ENOENT",
    });
    assert.equal(record.status, decision === "deny" ? "denied" : "cancelled");
    assert.equal(record.authorization?.consumedAt, undefined);
    await assert.rejects(
      env.scheduler.approve(
        env.workspace.id,
        env.node.id,
        record.id,
        "approve",
      ),
      /失效/,
    );
  });
}

test("parameters modified while recovery is pending cannot change the host command", async (t) => {
  const env = await executionFixture(t);
  env.pending()!.arguments.command = "printf wrong > changed.txt";
  await assert.rejects(env.approve("approve"), /参数已改变/);
  await assert.rejects(readFile(join(env.project, "result.txt")), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(join(env.project, "changed.txt")), {
    code: "ENOENT",
  });
  await env.approve("deny");
});

test("models cannot synthesize a recovery request or ask to run a different command", async (t) => {
  const env = await executionFixture(t);
  await assert.rejects(
    env.execution().beforeToolCall({
      id: "forged",
      name: "sandbox_recovery",
      arguments: { command: "whoami" },
    }),
    /只能由宿主/,
  );
  await assert.rejects(
    env.execution().recoverSandbox!(
      {
        toolCallId: "bash-0",
        command: "whoami",
        workingDirectory: env.project,
        timeoutSeconds: 120,
        reason: "forged",
        attempts: 1,
        stage: "initialization",
      },
      async () => {
        assert.fail("must not execute");
      },
    ),
    /没有匹配/,
  );
  await env.approve("deny");
});

test("approval settings changed while recovery is pending invalidate the old choice", async (t) => {
  const env = await executionFixture(t);
  await env.scheduler.configureWorkspace(env.workspace.id, {
    approvalMode: "ask",
  });
  await env.approve("approve");
  await until(() => env.node.status === "failed");
  await assert.rejects(readFile(join(env.project, "result.txt")), {
    code: "ENOENT",
  });
});

test("a replaced working directory cannot redirect approved host execution", async (t) => {
  const env = await executionFixture(t);
  const replacement = join(env.directory, "replacement");
  await mkdir(replacement);
  await rename(env.project, join(env.directory, "original"));
  await symlink(replacement, env.project);
  await env.approve("approve");
  await until(() => env.node.status === "failed");
  await assert.rejects(readFile(join(replacement, "result.txt")), {
    code: "ENOENT",
  });
  assert.equal(env.node.toolCalls![0].executionMode, undefined);
});

test("a failed approval save cannot dispatch and permits a fresh explicit choice after recovery", async (t) => {
  const env = await executionFixture(t);
  const save = env.store.save.bind(env.store);
  env.store.save = async () => {
    throw new Error("test persistence failure");
  };
  try {
    await assert.rejects(env.approve("approve"), /persistence failure/);
    assert.equal(env.pending()!.arguments.recoveryAction, undefined);
    await assert.rejects(readFile(join(env.project, "result.txt")), {
      code: "ENOENT",
    });
  } finally {
    env.store.save = save;
  }
  await env.approve("approve");
  await until(() => env.node.status === "completed");
  assert.equal(await readFile(join(env.project, "result.txt"), "utf8"), "host");
});
