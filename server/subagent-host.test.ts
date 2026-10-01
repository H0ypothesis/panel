import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";
import { NativeSubagentHost } from "./subagent-host.ts";
import type { SubagentRun } from "../shared/types.ts";
import { subagentThreads } from "../shared/subagent-runs.ts";

test(
  "native tool deadlines exclude approval waits and recovery retains its workspace output",
  { timeout: 60000 },
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "panel-native-approval-time-")),
    );
    const cwd = join(directory, "project");
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "reporter.md"),
      "---\nname: reporter\ndescription: fixture\ntools: write\n---\nWrite the report.",
    );
    const registry = createModels();
    const provider = fauxProvider({
      provider: "deadline-test",
      models: [{ id: "test" }],
      tokensPerSecond: 1000000,
    });
    const paths: string[] = [];
    const report = (context: any) => {
      const text = context.messages
        .filter((message: any) => message.role === "user")
        .map((message: any) =>
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part: any) => part.type === "text")
                .map((part: any) => part.text)
                .join("\n"),
        )
        .join("\n");
      const path = [
        ...text.matchAll(/Write your findings to exactly this path: ([^\n]+)/g),
      ].at(-1)?.[1];
      assert.ok(path, text);
      paths.push(path);
      return fauxAssistantMessage(
        fauxToolCall(
          "write",
          { path, content: `report-${paths.length}` },
          { id: `report-${paths.length}` },
        ),
        { stopReason: "toolUse" },
      );
    };
    provider.setResponses([
      report,
      fauxAssistantMessage("first-finished"),
      report,
      fauxAssistantMessage("resumed-finished"),
    ]);
    registry.setProvider(provider.provider);
    const records = new Map<string, SubagentRun>();
    let waiting = false;
    const host = new NativeSubagentHost({
      directory,
      owner: "deadline:0",
      cwd,
      model: "deadline-test/test",
      thinking: "off",
      concurrency: 2,
      registry,
      environment: {
        workingDirectory: cwd,
        beforeToolCall: async () => {
          waiting = true;
          await new Promise((resolve) => setTimeout(resolve, 180));
          waiting = false;
          return true;
        },
        executeTool: async (_call, execute) => {
          assert.equal(waiting, false);
          return execute();
        },
        onToolUpdate() {},
        onSubagentUpdate: (run) => records.set(run.id, run),
      },
    });
    try {
      const result = await host.execute("subagent", {
        agent: "reporter",
        task: "Write a report",
        output: "report.md",
        async: false,
        toolTimeoutMs: 80,
      });
      assert.equal(result.isError ?? false, false, JSON.stringify(result));
      assert.ok(
        paths[0].startsWith(join(cwd, ".pi", "subagents", "artifacts")),
        paths[0],
      );
      assert.equal(await readFile(paths[0], "utf8"), "report-1");
      const original = [...records.values()].find(
        (run) => run.agent === "reporter",
      )!;
      assert.equal(original.status, "completed", JSON.stringify(original));
      const revived = await host.execute("subagent", {
        action: "resume",
        id: original.nativeRunId,
        message: "Continue and update the same report",
        toolTimeoutMs: 80,
      });
      assert.equal(revived.isError ?? false, false, JSON.stringify(revived));
      for (
        let i = 0;
        i < 200 &&
        ![...records.values()].some(
          (run) =>
            run.resumedFrom === original.id && run.status === "completed",
        );
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      const recovered = [...records.values()].find(
        (run) => run.resumedFrom === original.id,
      )!;
      assert.ok(recovered, JSON.stringify([...records.values()]));
      assert.equal(recovered.status, "completed", JSON.stringify(recovered));
      assert.equal(recovered.sessionFile, original.sessionFile);
      assert.equal(paths[1], paths[0]);
      assert.equal(await readFile(paths[0], "utf8"), "report-2");
      assert.equal(
        subagentThreads(
          [...records.values()].filter((run) => run.agent === "reporter"),
        ).length,
        1,
      );
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a granted native tool still times out and is shown as a failure rather than a user stop",
  { timeout: 60000 },
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "panel-native-execution-time-")),
    );
    const cwd = join(directory, "project");
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    const extension = join(cwd, "slow.js");
    await writeFile(
      extension,
      `export default function(pi) { pi.registerTool({ name: "slow_probe", label: "Slow", description: "Slow fixture", parameters: {type:"object", properties:{}}, async execute() { await new Promise(resolve => setTimeout(resolve, 300)); return {content:[{type:"text",text:"settled"}],details:{}}; } }); }`,
    );
    await writeFile(
      join(cwd, ".pi", "agents", "slow.md"),
      `---\nname: slow\ndescription: fixture\ntools: slow_probe\nextensions: ${extension}\n---\nCall slow_probe.`,
    );
    const registry = createModels();
    const provider = fauxProvider({
      provider: "timeout-test",
      models: [{ id: "test" }],
      tokensPerSecond: 1000000,
    });
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("slow_probe", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("unexpected"),
    ]);
    registry.setProvider(provider.provider);
    const records = new Map<string, SubagentRun>(),
      updates: any[] = [],
      toolUpdates: { id: string; update: any }[] = [];
    const host = new NativeSubagentHost({
      directory,
      owner: "timeout:0",
      cwd,
      model: "timeout-test/test",
      thinking: "off",
      concurrency: 1,
      registry,
      environment: {
        workingDirectory: cwd,
        beforeToolCall: async () => {
          await new Promise((resolve) => setTimeout(resolve, 180));
          return true;
        },
        executeTool: async (_call, execute) => execute(),
        onToolUpdate: (id, update) => toolUpdates.push({ id, update }),
        onSubagentUpdate: (run) => records.set(run.id, run),
      },
    });
    try {
      let failure = "";
      try {
        const result = await host.execute(
          "subagent",
          {
            agent: "slow",
            task: "Call slow_probe",
            output: false,
            toolTimeoutMs: 80,
            async: false,
          },
          undefined,
          (update) => updates.push(update),
        );
        failure = JSON.stringify(result);
      } catch (error) {
        failure = String(error);
      }
      assert.match(failure, /exceeded its timeout/);
      const child = [...host.records.values()].find(
        (run) => run.agent === "slow",
      )!;
      assert.equal(child.status, "failed", JSON.stringify(child));
      assert.equal(child.stopReason, "timeout", JSON.stringify(child));
      assert.ok(
        toolUpdates.some(
          ({ update }) =>
            update.status === "failed" && update.stopReason === "timeout",
        ),
        JSON.stringify(toolUpdates),
      );
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "native worktree children use their own directory for tools and approvals",
  { timeout: 60000 },
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "panel-native-worktree-")),
    );
    const cwd = join(directory, "project");
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "write-test.md"),
      "---\nname: write-test\ndescription: fixture\ntools: write\n---\nWrite result.txt.",
    );
    const git = promisify(execFile);
    await git("git", ["init", "-q"], { cwd });
    await git("git", ["add", "."], { cwd });
    await git(
      "git",
      [
        "-c",
        "user.name=Panel Test",
        "-c",
        "user.email=panel@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd },
    );
    const registry = createModels();
    const provider = fauxProvider({
      provider: "host-test",
      models: [{ id: "test" }],
      tokensPerSecond: 1000000,
    });
    provider.setResponses([
      (context) => {
        const output = getCurrentSystemPrompt(context.messages)?.match(
          /Write your findings to exactly this path: ([^\n]+)/,
        )?.[1];
        assert.ok(output);
        return fauxAssistantMessage(
          [
            fauxToolCall(
              "write",
              { path: "result.txt", content: "worktree-only" },
              { id: "worktree-file" },
            ),
            fauxToolCall(
              "write",
              { path: output, content: "worktree-report" },
              { id: "worktree-output" },
            ),
          ],
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("worktree-done"),
    ]);
    registry.setProvider(provider.provider);
    const updates: any[] = [];
    let writtenContent: string | undefined;
    const approved: any[] = [],
      records = new Map<string, SubagentRun>();
    const host = new NativeSubagentHost({
      directory,
      owner: "worktree:0",
      cwd,
      model: "host-test/test",
      thinking: "off",
      concurrency: 2,
      registry,
      environment: {
        workingDirectory: cwd,
        beforeToolCall: async (call) => {
          approved.push(call);
          return true;
        },
        executeTool: async (call, execute) => {
          const result = await execute();
          if (call.name === "write" && call.arguments.path === "result.txt")
            writtenContent = await readFile(
              join(call.workingDirectory!, "result.txt"),
              "utf8",
            );
          return result;
        },
        onToolUpdate: (_id, update) => {
          updates.push(update);
        },
        onSubagentUpdate: (run) => records.set(run.id, run),
      },
    });
    try {
      const result = await host.execute("subagent", {
        agent: "write-test",
        task: "Write result.txt",
        isolation: "worktree",
        async: false,
        output: "report.md",
      });
      assert.match(JSON.stringify(result), /worktree-report/);
      const run = [...records.values()].find(
        (run) => run.agent === "write-test",
      )!;
      assert.ok(run.workingDirectory && run.workingDirectory !== cwd);
      assert.equal(approved[0].workingDirectory, run.workingDirectory);
      assert.ok(
        run.outputPath?.startsWith(
          join(run.workingDirectory!, ".pi", "subagents", "artifacts"),
        ),
        run.outputPath,
      );
      assert.ok(
        updates.some((update) => update.status === "completed"),
        JSON.stringify(updates),
      );
      // Upstream may remove the worktree after preserving its handoff patch.
      assert.equal(writtenContent, "worktree-only");
      assert.match(JSON.stringify(result), /result\.txt/);
      await assert.rejects(readFile(join(cwd, "result.txt")), {
        code: "ENOENT",
      });
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "native child bash executes through the parent sandbox and blocks writes outside its workspace",
  { timeout: 60000 },
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "panel-child-sandbox-")),
    );
    const cwd = join(directory, "project");
    await mkdir(join(cwd, ".pi/agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi/agents/sandbox-child.md"),
      "---\nname: sandbox-child\ndescription: fixture\ntools: bash\n---\nRun the command.",
    );
    const outside = join(directory, "outside.txt");
    await writeFile(outside, "original");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const registry = createModels();
    const provider = fauxProvider({
      provider: "child-sandbox",
      models: [{ id: "test" }],
      tokensPerSecond: 1000000,
    });
    provider.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", {
          command: `printf inside > result.txt; if printf escaped > ${quote(outside)}; then exit 99; fi`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("sandbox-child-done"),
    ]);
    registry.setProvider(provider.provider);
    const calls: Array<{
      name: string;
      sandbox?: { workingDirectory: string };
    }> = [];
    const host = new NativeSubagentHost({
      directory,
      owner: "sandbox-child:0",
      cwd,
      model: "child-sandbox/test",
      thinking: "off",
      concurrency: 1,
      registry,
      environment: {
        workingDirectory: cwd,
        beforeToolCall: async (call) => {
          calls.push(call);
          return true;
        },
        executeTool: async (_call, execute) => execute(),
        onToolUpdate() {},
      },
    });
    try {
      const result = await host.execute("subagent", {
        agent: "sandbox-child",
        task: "Run fixture",
        async: false,
        output: false,
      });
      assert.match(JSON.stringify(result), /sandbox-child-done/);
      assert.equal(await readFile(join(cwd, "result.txt"), "utf8"), "inside");
      assert.equal(await readFile(outside, "utf8"), "original");
      assert.equal(
        calls.find((call) => call.name === "bash")?.sandbox?.workingDirectory,
        cwd,
      );
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "native host loads the full tool, retains role exclusions and runs a guarded Pi child",
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "panel-native-host-test-"));
    const cwd = join(directory, "project");
    await mkdir(cwd);
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "host-test.md"),
      "---\nname: host-test\ndescription: fixture\ntools: read\n---\nReturn the test response.\n",
    );
    await writeFile(
      join(cwd, ".pi", "agents", "broken-role.md"),
      "---\nname: broken-role\ndescription: fixture\ntools: powershell\n---\nFail explicitly.",
    );
    const extensions = join(directory, "subagents", "agent", "extensions");
    await mkdir(extensions, { recursive: true });
    const resources = pathToFileURL(
      join(
        process.cwd(),
        "node_modules/pi-subagents/src/workflows/workflow-resources.js",
      ),
    ).href;
    await writeFile(
      join(extensions, "workflow-fixture.js"),
      `
      import { registerWorkflowResource } from ${JSON.stringify(resources)};
      export default function (pi) {
        let resource;
        pi.on("session_start", (_event, ctx) => {
          resource = registerWorkflowResource({ sessionId: ctx.sessionManager.getSessionId(),
            definition: { name: "panel-test", version: 1, resolve: () => ({ script: 'return "named-workflow-ok";' }) } });
        });
        pi.on("session_shutdown", () => resource?.dispose());
      }
    `,
    );
    const registry = createModels();
    const provider = fauxProvider({
      provider: "host-test",
      models: [{ id: "test", name: "test" }],
    });
    provider.setResponses([fauxAssistantMessage("native-child-ok")]);
    registry.setProvider(provider.provider);
    const records = new Map<string, SubagentRun>();
    const host = new NativeSubagentHost({
      directory,
      owner: "fixture:0",
      cwd,
      model: "host-test/test",
      thinking: "off",
      concurrency: 2,
      registry,
      environment: {
        workingDirectory: cwd,
        beforeToolCall: async () => true,
        executeTool: async (_call, execute) => execute(),
        onToolUpdate() {},
        onSubagentUpdate: (run) => records.set(run.id, run),
      },
    });
    try {
      const tools = await host.tools();
      assert.ok(tools.some((tool) => tool.name === "subagent"));
      const list = JSON.stringify(
        await host.execute("subagent", { action: "list" }),
      );
      assert.ok(list.includes("host-test"));
      assert.ok(!list.includes('"name":"claude-code"'));
      const result = await host.execute("subagent", {
        agent: "host-test",
        task: "Reply native-child-ok.",
        async: false,
        output: false,
      });
      assert.ok(
        JSON.stringify(result).includes("native-child-ok"),
        JSON.stringify(result),
      );
      assert.ok(
        [...records.values()].some((run) =>
          run.response.includes("native-child-ok"),
        ),
      );
      const named = await host.execute("subagent", {
        workflow: "panel-test",
        async: false,
      });
      assert.match(JSON.stringify(named), /named-workflow-ok/);
      await assert.rejects(
        host.execute("subagent", {
          agent: "broken-role",
          task: "fail",
          async: false,
        }),
        /powershell/,
      );
      assert.ok(
        [...records.values()].some(
          (run) => run.agent === "broken-role" && run.status === "failed",
        ),
        JSON.stringify([...records.values()]),
      );
      const scheduled = await host.execute("subagent", {
        action: "schedule.create",
        name: "panel-schedule-fixture",
        at: new Date(Date.now() + 86400000).toISOString(),
        workflowScript: 'return "scheduled-fixture";',
      });
      assert.ok(!scheduled.isError, JSON.stringify(scheduled));
      const other = new NativeSubagentHost({
        ...host.options,
        owner: "other-card:0",
      });
      try {
        const list = await other.execute("subagent", {
          action: "schedule.list",
        });
        assert.doesNotMatch(JSON.stringify(list), /panel-schedule-fixture/);
      } finally {
        await other.close();
      }
      await host.close();
      const restarted = new NativeSubagentHost(host.options);
      try {
        const list = await restarted.execute("subagent", {
          action: "schedule.list",
        });
        assert.match(JSON.stringify(list), /panel-schedule-fixture/);
      } finally {
        await restarted.close();
      }
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "running foreground child detaches without losing its pending tool or result",
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "panel-native-detach-"));
    const cwd = join(directory, "project");
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(join(cwd, "input.txt"), "fixture");
    await writeFile(
      join(cwd, ".pi", "agents", "host-test.md"),
      "---\nname: host-test\ndescription: fixture\ntools: read\n---\nRead input.txt then finish.",
    );
    const registry = createModels();
    const provider = fauxProvider({
      provider: "host-test",
      models: [{ id: "test" }],
      tokensPerSecond: 1000000,
    });
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("detached-finished"),
    ]);
    registry.setProvider(provider.provider);
    let release!: (value: boolean) => void;
    const approval = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    let waiting = false;
    const records = new Map<string, SubagentRun>();
    const host = new NativeSubagentHost({
      directory,
      owner: "detach:0",
      cwd,
      model: "host-test/test",
      thinking: "off",
      concurrency: 2,
      registry,
      environment: {
        workingDirectory: cwd,
        beforeToolCall: () => {
          waiting = true;
          return approval;
        },
        executeTool: (_call, execute) => execute(),
        onToolUpdate() {},
        onSubagentUpdate: (run) => records.set(run.id, run),
      },
    });
    let running: Promise<any> | undefined;
    try {
      running = host.execute("subagent", {
        agent: "host-test",
        task: "Read input.txt",
        async: false,
        output: false,
      });
      for (let i = 0; i < 150 && !waiting; i++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(waiting);
      const run = [...records.values()].find(
        (item) => item.agent === "host-test",
      )!;
      const detached = await host.execute("subagent_detach", {
        id: run.nativeRunId,
        index: run.childIndex,
      });
      assert.equal(
        (detached.details as any).accepted,
        true,
        JSON.stringify(detached),
      );
      const receipt = await running;
      assert.match(JSON.stringify(receipt), /detached/i);
      assert.ok(host.live());
      release(true);
      for (
        let i = 0;
        i < 150 &&
        ![...records.values()].some((item) => item.status === "completed");
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(
        [...records.values()].some(
          (item) =>
            item.response.includes("detached-finished") &&
            item.background &&
            item.status === "completed",
        ),
        JSON.stringify([...records.values()]),
      );
    } finally {
      release(false);
      await host.close();
      await running?.catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "native async survives its dispatch and publishes completion",
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "panel-native-async-"));
    const cwd = join(directory, "project");
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "host-test.md"),
      "---\nname: host-test\ndescription: fixture\ntools: read\n---\nReturn the test response.\n",
    );
    const registry = createModels();
    const provider = fauxProvider({
      provider: "host-test",
      models: [{ id: "test", name: "test" }],
    });
    provider.setResponses([
      fauxAssistantMessage("background-prefix; ", { stopReason: "length" }),
      fauxAssistantMessage("background-child-ok"),
    ]);
    registry.setProvider(provider.provider);
    const records = new Map<string, SubagentRun>();
    const host = new NativeSubagentHost({
      directory,
      owner: "async-fixture:0",
      cwd,
      model: "host-test/test",
      thinking: "off",
      concurrency: 2,
      registry,
      environment: {
        workingDirectory: cwd,
        beforeToolCall: async () => true,
        executeTool: async (_call, execute) => execute(),
        onToolUpdate() {},
        onSubagentUpdate: (run) => records.set(run.id, run),
      },
    });
    host.setHistory([
      { role: "user", content: "Background task", timestamp: Date.now() },
    ]);
    try {
      const result = await host.execute("subagent", {
        agent: "host-test",
        task: "Reply background-child-ok.",
        async: true,
        output: false,
      });
      assert.ok((result.details as any).asyncId, JSON.stringify(result));
      for (
        let i = 0;
        i < 150 &&
        ![...records.values()].some((run) =>
          run.response.includes("background-child-ok"),
        );
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(
        [...records.values()].some((run) =>
          run.response.includes("background-prefix; background-child-ok"),
        ),
        JSON.stringify(
          await host.execute("subagent", {
            action: "status",
            id: (result.details as any).asyncId,
          }),
        ),
      );
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "nested delegation uses the Panel factory and a completed child resumes after host restart",
  { timeout: 90000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "panel-native-nested-"));
    const cwd = join(directory, "project");
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "leaf.md"),
      "---\nname: leaf\ndescription: fixture\ntools: read\n---\nReturn leaf result.\n",
    );
    await writeFile(
      join(cwd, ".pi", "agents", "coordinator.md"),
      "---\nname: coordinator\ndescription: fixture\ntools: read, subagent\nallowNestedSubagents: true\nmaxSubagentDepth: 3\n---\nDelegate to leaf.\n",
    );
    const registry = createModels();
    const provider = fauxProvider({
      provider: "host-test",
      models: [{ id: "test", name: "test" }],
      tokensPerSecond: 1000000,
    });
    provider.setResponses(
      Array.from({ length: 20 }, () => (context: any) => {
        const nested = getCurrentTools(context.messages)?.some(
          (tool) => tool.name === "subagent",
        );
        const called = context.messages.some(
          (message: any) =>
            message.role === "toolResult" && message.toolName === "subagent",
        );
        if (nested && !called)
          return fauxAssistantMessage(
            fauxToolCall("subagent", {
              agent: "leaf",
              task: "Leaf task",
              async: false,
              output: false,
            }),
            { stopReason: "toolUse" },
          );
        return fauxAssistantMessage(
          nested ? "coordinator-complete" : "leaf-complete",
        );
      }),
    );
    registry.setProvider(provider.provider);
    const records = new Map<string, SubagentRun>();
    const approved: string[] = [];
    const options = {
      directory,
      owner: "nested-fixture:0",
      cwd,
      model: "host-test/test",
      thinking: "off",
      concurrency: 2,
      registry,
      environment: {
        workingDirectory: cwd,
        beforeToolCall: async (call: any) => {
          approved.push(call.name);
          return true;
        },
        executeTool: async (_call: any, execute: () => Promise<any>) =>
          execute(),
        onToolUpdate() {},
        onSubagentUpdate: (run: SubagentRun) => records.set(run.id, run),
      },
    };
    let host = new NativeSubagentHost(options);
    host.setHistory([
      { role: "user", content: "FORK_CONTEXT_SENTINEL", timestamp: Date.now() },
    ]);
    try {
      const result = await host.execute("subagent", {
        agent: "coordinator",
        task: "Delegate the leaf task",
        async: false,
        output: false,
        context: "fork",
      });
      assert.match(JSON.stringify(result), /coordinator-complete/);
      assert.ok(approved.includes("subagent"), JSON.stringify(approved));
      assert.ok(
        [...records.values()].some(
          (run) =>
            run.agent === "leaf" && run.response.includes("leaf-complete"),
        ),
        JSON.stringify([...records.values()]),
      );
      const leafCount = [...records.values()].filter(
        (run) => run.agent === "leaf",
      ).length;
      await host.execute("subagent", {
        agent: "coordinator",
        task: "Delegate another leaf",
        async: true,
        output: false,
      });
      for (
        let i = 0;
        i < 150 &&
        [...records.values()].filter(
          (run) =>
            run.agent === "leaf" && run.response.includes("leaf-complete"),
        ).length <= leafCount;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(
        [...records.values()].filter(
          (run) =>
            run.agent === "leaf" && run.response.includes("leaf-complete"),
        ).length > leafCount,
        JSON.stringify([...records.values()]),
      );
      const coordinator = [...records.values()].find(
        (run) => run.agent === "coordinator",
      )!;
      assert.ok(coordinator.sessionFile);
      await host.close();
      host = new NativeSubagentHost({
        ...options,
        records: [...records.values()],
      });
      const resumed = await host.execute("subagent", {
        action: "resume",
        id: coordinator.nativeRunId,
        message: "Continue from your saved work",
      });
      assert.ok(!resumed.isError, JSON.stringify(resumed));
      assert.ok(
        (resumed.details as any).asyncId ||
          JSON.stringify(resumed).includes("coordinator-complete"),
        JSON.stringify(resumed),
      );
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "explicit external CLI roles use the native background runner without restoring removed roles",
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "panel-native-cli-"));
    const cwd = join(directory, "project");
    await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "agents", "echo-cli.md"),
      "---\nname: echo-cli\ndescription: fixture\nrunner:\n  type: external-cli\n  command: /bin/cat\n---\nEcho the input task.\n",
    );
    const registry = createModels();
    const provider = fauxProvider({
      provider: "host-test",
      models: [{ id: "test" }],
    });
    registry.setProvider(provider.provider);
    const records = new Map<string, SubagentRun>();
    const host = new NativeSubagentHost({
      directory,
      owner: "cli:0",
      cwd,
      model: "host-test/test",
      thinking: "off",
      concurrency: 2,
      registry,
      environment: {
        workingDirectory: cwd,
        beforeToolCall: async () => true,
        executeTool: async (_call, execute) => execute(),
        onToolUpdate() {},
        onSubagentUpdate: (run) => records.set(run.id, run),
      },
    });
    host.setHistory([
      { role: "user", content: "Run echo-cli", timestamp: Date.now() },
    ]);
    try {
      const result = await host.execute("subagent", {
        agent: "echo-cli",
        task: "CLI_NATIVE_MARKER",
        async: true,
      });
      assert.ok((result.details as any).asyncId, JSON.stringify(result));
      for (
        let i = 0;
        i < 150 &&
        ![...records.values()].some((run) =>
          run.response.includes("CLI_NATIVE_MARKER"),
        );
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(
        [...records.values()].some((run) =>
          run.response.includes("CLI_NATIVE_MARKER"),
        ),
        JSON.stringify(
          await host.execute("subagent", {
            action: "status",
            id: (result.details as any).asyncId,
          }),
        ),
      );
    } finally {
      await host.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
