import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  realpath,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { Subagents } from "./subagents.ts";
import { subagentCatalog } from "./subagent-profiles.ts";
import {
  createPanelChildSession,
  persistSubagentOutput,
} from "./subagent-session.ts";
import { createPanelTools } from "./coding-tools.ts";
import type { SubagentRun } from "../shared/types.ts";

async function fixture(
  t: TestContext,
  response: FauxResponseFactory,
  allowed = true,
) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "panel-native-agents-")),
  );
  const cwd = join(directory, "project");
  const user = join(directory, "user");
  await mkdir(join(cwd, ".pi/agents"), { recursive: true });
  await mkdir(join(user, "agents"), { recursive: true });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = user;
  const provider = fauxProvider({
    provider: "openai",
    models: [{ id: "parent" }, { id: "specialist", reasoning: true }],
    tokensPerSecond: 1000000,
  });
  provider.setResponses(Array.from({ length: 20 }, () => response));
  const registry = createModels();
  registry.setProvider(provider.provider);
  const runs = new Map<string, SubagentRun>();
  const approvals: { name: string; arguments: Record<string, unknown> }[] = [];
  const executed: string[] = [];
  let disposed = 0;
  const service = new Subagents({
    cwd,
    model: "openai/parent",
    thinking: "off",
    signal: new AbortController().signal,
    onUpdate: (run) => runs.set(run.id, run),
    persistOutput: async () => {
      throw new Error("Unexpected output persistence in this test");
    },
    createChildSession: (id, launch, skillPaths) =>
      createPanelChildSession(launch, {
        id,
        skillPaths,
        providers: {
          getRegisteredProviderIds: () => ["openai"],
          getRegisteredProviderConfig: () => undefined,
          getRegisteredNativeProvider: () => registry.getProvider("openai"),
        },
        tools: createPanelTools(cwd),
        onDispose: async () => {
          disposed++;
        },
        environment: {
          workingDirectory: cwd,
          beforeToolCall: async (call) => {
            approvals.push(call);
            return allowed;
          },
          executeTool: async (call, execute) => {
            executed.push(call.name);
            return execute();
          },
          onToolUpdate() {},
        },
      }),
  });
  t.after(async () => {
    await service.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const profile = (name: string, content: string, scope = cwd) =>
    writeFile(
      join(scope, scope === cwd ? ".pi/agents" : "agents", `${name}.md`),
      content,
    );
  const run = (name: string) =>
    service.tools()[1].execute("test", {
      agent: name,
      task: "Inspect requested facts; no file edits.",
    });
  return {
    directory,
    cwd,
    user,
    profile,
    run,
    runs,
    approvals,
    executed,
    tools: service.tools(),
    disposed: () => disposed,
  };
}

test("removed CLI roles are absent from settings and model discovery and cannot launch", async (t) => {
  let modelCalls = 0;
  const env = await fixture(t, () => {
    modelCalls++;
    return fauxAssistantMessage("unexpected CLI role");
  });
  const retained = [
    "delegate",
    "evidence-auditor",
    "oracle",
    "researcher",
    "reviewer",
    "scout",
    "worker",
  ];
  const catalog = await subagentCatalog(env.cwd);
  assert.deepEqual(
    catalog.profiles
      .filter((profile) => profile.source === "builtin")
      .map((profile) => profile.name)
      .sort(),
    retained,
  );
  for (const result of [
    await env.tools[0].execute("enable", {}),
    await env.tools[1].execute("list", { action: "list" }),
  ]) {
    const text = result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    assert.doesNotMatch(text, /claude-code|codex-exec|cursor-agent/);
    for (const name of retained) assert.ok(text.includes(`"name":"${name}"`));
  }
  for (const name of ["claude-code", "codex-exec", "cursor-agent"].flatMap(
    (name) => [name, `${name}-writer`],
  ))
    await assert.rejects(env.run(name), /Unknown agent|未知角色/);
  assert.equal(modelCalls, 0);
  assert.equal(env.runs.size, 0);
});

test("native project profiles override user and builtin roles, preserving model, tools, skills and context", async (t) => {
  let requests = 0;
  const env = await fixture(t, (context, options, _state, model) => {
    requests++;
    assert.equal(model.id, "specialist");
    assert.equal(options?.reasoning, "low");
    const prompt = getCurrentSystemPrompt(context.messages);
    assert.match(prompt, /PROJECT_NATIVE_PROMPT/);
    assert.match(prompt, /PROJECT_CONTEXT_MARKER/);
    assert.match(prompt, /<name>evidence<\/name>/);
    assert.match(prompt, /Evidence skill/);
    assert.doesNotMatch(prompt, /USER_NATIVE_PROMPT/);
    assert.deepEqual(
      getCurrentTools(context.messages)?.map((tool) => tool.name),
      ["read"],
    );
    return fauxAssistantMessage("native custom result");
  });
  await writeFile(join(env.cwd, "AGENTS.md"), "PROJECT_CONTEXT_MARKER");
  await mkdir(join(env.cwd, ".pi/skills/evidence"), { recursive: true });
  await writeFile(
    join(env.cwd, ".pi/skills/evidence/SKILL.md"),
    "---\nname: evidence\ndescription: Evidence skill\n---\nSELECTED_SKILL_MARKER",
  );
  await env.profile(
    "scout",
    "---\nname: scout\ndescription: User role\n---\nUSER_NATIVE_PROMPT",
    env.user,
  );
  await env.profile(
    "scout",
    "---\nname: scout\naliases: inspect\ndescription: Project role\nmodel: openai/specialist\nthinking: low\ntools: read, bash\nexcludeTools: bash\nskills: evidence\nsystemPromptMode: replace\ninheritProjectContext: true\n---\nPROJECT_NATIVE_PROMPT",
  );
  const catalog = await subagentCatalog(env.cwd);
  const scout = catalog.profiles.find((item) => item.name === "scout")!;
  assert.equal(scout.source, "project");
  assert.equal(scout.model, "openai/specialist");
  await env.run("inspect");
  assert.equal(requests, 1);
  const run = [...env.runs.values()][0];
  assert.equal(run.agent, "scout");
  assert.equal(run.status, "completed", run.error);
  assert.match(run.model, /specialist/);
  assert.equal(run.response, "native custom result");
  assert.equal(
    env.disposed(),
    1,
    "child-owned resources are disposed before returning to the parent",
  );
});

test("a missing required tool fails before model execution instead of silently narrowing tools", async (t) => {
  let called = false;
  const env = await fixture(t, () => {
    called = true;
    return fauxAssistantMessage("bad");
  });
  await env.profile(
    "custom",
    "---\nname: custom\ndescription: Missing tool\ntools: read, nonexistent_tool\n---\nInspect",
  );
  await env.run("custom");
  const run = [...env.runs.values()][0];
  assert.equal(run.status, "failed");
  assert.match(run.error!, /nonexistent_tool/);
  assert.equal(called, false);
});

for (const allowed of [false, true])
  test(`native extension tools cross Panel approval (allowed=${allowed})`, async (t) => {
    const env = await fixture(
      t,
      (context) =>
        context.messages.some((item) => item.role === "toolResult")
          ? fauxAssistantMessage("finished")
          : fauxAssistantMessage(
              fauxToolCall("extension_probe", { value: "hello" }),
              { stopReason: "toolUse" },
            ),
      allowed,
    );
    const extension = join(env.cwd, "probe.ts");
    await writeFile(
      extension,
      `import { Type } from "typebox";
export default function(pi) { pi.registerTool({ name: "extension_probe", label: "Probe", description: "Probe native extension", parameters: Type.Object({ value: Type.String() }), async execute(id, args) { return { content: [{ type: "text", text: args.value }], details: {} }; } }); }`,
    );
    await env.profile(
      "custom",
      `---\nname: custom\ndescription: Extension test\ntools: extension_probe\nextensions: ${extension}\n---\nCall extension_probe once.`,
    );
    await env.run("custom");
    const run = [...env.runs.values()][0];
    assert.equal(run.status, "completed", run.error);
    assert.equal(env.approvals.length, 1);
    assert.equal(env.approvals[0].name, "extension_probe");
    assert.equal(env.executed.length, allowed ? 1 : 0);
  });

test("native navigation tools cannot follow a directory symlink outside the workspace", async (t) => {
  const env = await fixture(t, (context) => {
    const result = context.messages.find((item) => item.role === "toolResult");
    if (result) {
      assert.match(JSON.stringify(result), /超出当前工作目录/);
      return fauxAssistantMessage("bounded");
    }
    return fauxAssistantMessage(fauxToolCall("ls", { path: "escape" }), {
      stopReason: "toolUse",
    });
  });
  await symlink(env.user, join(env.cwd, "escape"));
  await env.profile(
    "custom",
    "---\nname: custom\ndescription: Navigation\ntools: ls\n---\nList the requested directory",
  );
  await env.run("custom");
  const run = [...env.runs.values()][0];
  assert.equal(run.status, "completed", run.error);
  assert.equal(env.approvals[0].name, "ls");
});

test("native permission rules block tools before Panel execution", async (t) => {
  const env = await fixture(t, (context) => {
    const result = context.messages.find((item) => item.role === "toolResult");
    if (result) {
      assert.match(JSON.stringify(result), /denied|blocked|permission/i);
      return fauxAssistantMessage("policy respected");
    }
    return fauxAssistantMessage(fauxToolCall("read", { path: "AGENTS.md" }), {
      stopReason: "toolUse",
    });
  });
  await env.profile(
    "custom",
    "---\nname: custom\ndescription: Permissions\ntools: read\npermissions:\n  read: deny\n---\nInspect",
  );
  await env.run("custom");
  const run = [...env.runs.values()][0];
  assert.equal(run.status, "completed", run.error);
  assert.equal(env.executed.length, 0);
});

test("unsupported nested runners are visible and cannot bypass Panel's queue", async (t) => {
  let called = false;
  const env = await fixture(t, () => {
    called = true;
    return fauxAssistantMessage("bad");
  });
  await env.profile(
    "custom",
    "---\nname: custom\ndescription: Nested\nallowNestedSubagents: true\n---\nDelegate",
  );
  const catalog = await subagentCatalog(env.cwd);
  assert.match(
    catalog.profiles
      .find((profile) => profile.name === "custom")!
      .diagnostics.join("\n"),
    /嵌套/,
  );
  await env.run("custom");
  assert.equal([...env.runs.values()][0].status, "failed");
  assert.equal(called, false);
});

test("selected global skills can be read through their own audited approval without opening other external paths", async (t) => {
  let skillPath = "";
  const env = await fixture(t, (context) => {
    const result = context.messages.find((item) => item.role === "toolResult");
    if (result) {
      assert.match(JSON.stringify(result), /GLOBAL_SKILL_CONTENT/);
      return fauxAssistantMessage("read skill");
    }
    return fauxAssistantMessage(fauxToolCall("read", { path: skillPath }), {
      stopReason: "toolUse",
    });
  });
  await mkdir(join(env.user, "skills/global-skill"), { recursive: true });
  skillPath = join(env.user, "skills/global-skill/SKILL.md");
  await writeFile(
    skillPath,
    "---\nname: global-skill\ndescription: Global skill\n---\nGLOBAL_SKILL_CONTENT",
  );
  await env.profile(
    "custom",
    "---\nname: custom\ndescription: Skills\ntools: read\nskills: global-skill\n---\nRead the configured skill.",
  );
  await env.run("custom");
  const run = [...env.runs.values()][0];
  assert.equal(run.status, "completed", run.error);
  assert.deepEqual(env.executed, ["read_skill"]);
});

test("automatic output persistence cannot write after approval denial", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "panel-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let executed = false;
  await assert.rejects(
    persistSubagentOutput(
      {
        workingDirectory: directory,
        beforeToolCall: async (call) => {
          assert.equal(call.name, "write");
          assert.equal(call.subagentId, "child");
          return false;
        },
        executeTool: async (_call, execute) => {
          executed = true;
          return execute();
        },
        onToolUpdate() {},
      },
      "child",
      join(directory, "result.md"),
      "native output",
      new AbortController().signal,
    ),
    /拒绝/,
  );
  assert.equal(executed, false);
});

test("native children continue truncated output and return all chunks without compacting away the prefix", async (t) => {
  let requests = 0;
  const env = await fixture(t, (_context, options, _state, model) => {
    assert.equal(options?.maxTokens, model.contextWindow);
    requests++;
    return requests === 1
      ? fauxAssistantMessage("first chapter; ", { stopReason: "length" })
      : fauxAssistantMessage("last chapter");
  });
  await env.profile(
    "continued",
    "---\nname: continued\ndescription: Continuation\ntools: read\noutput: false\n---\nReturn the report.",
  );
  const result = await env.run("continued");
  const run = [...env.runs.values()][0];
  assert.equal(run.status, "completed", run.error);
  assert.equal(requests, 2);
  assert.match(JSON.stringify(result), /first chapter; last chapter/);
  assert.equal(run.response, "first chapter; last chapter");
});

test("native children stop repeated truncation with a distinct failure and retain partial output", async (t) => {
  let requests = 0;
  const env = await fixture(t, () => {
    requests++;
    return fauxAssistantMessage("stuck partial", { stopReason: "length" });
  });
  await env.profile(
    "continued",
    "---\nname: continued\ndescription: Continuation\ntools: read\noutput: false\n---\nReturn the report.",
  );
  await env.run("continued");
  const run = [...env.runs.values()][0];
  assert.equal(run.status, "failed");
  assert.match(run.error ?? "", /输出未完成/);
  assert.match(run.response, /stuck partial/);
  assert.equal(requests, 2);
});
