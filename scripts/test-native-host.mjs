import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(process.env.PANEL_TEST_APP ?? "build/desktop/app");
const { NativeSubagentHost } = await import(
  pathToFileURL(join(root, "server/subagent-host.mjs")).href
);
const {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
} = await import(
  pathToFileURL(join(root, "node_modules/@earendil-works/pi-ai/dist/index.js"))
    .href
);
const directory = await mkdtemp(join(tmpdir(), "panel-bundled-agents-"));
const cwd = join(directory, "project");
await mkdir(join(cwd, ".pi/agents"), { recursive: true });
await writeFile(
  join(cwd, ".pi/agents/leaf.md"),
  "---\nname: leaf\ndescription: smoke\ntools: read\n---\nReturn the smoke result.",
);
await writeFile(
  join(cwd, ".pi/agents/parent.md"),
  "---\nname: parent\ndescription: smoke\ntools: subagent\nallowNestedSubagents: true\n---\nDelegate to leaf.",
);
const registry = createModels();
const mock = fauxProvider({
  provider: "smoke",
  models: [{ id: "test" }],
  tokensPerSecond: 1000000,
});
mock.setResponses(
  Array.from({ length: 20 }, () => (context, options, _state, model) => {
    assert.equal(options.maxTokens, model.contextWindow);
    const canDelegate = getCurrentTools(context.messages)?.some(
      (tool) => tool.name === "subagent",
    );
    const delegated = context.messages.some(
      (message) =>
        message.role === "toolResult" && message.toolName === "subagent",
    );
    if (
      !canDelegate &&
      !context.messages.some((message) => message.role === "assistant")
    )
      return fauxAssistantMessage("bundled-prefix; ", { stopReason: "length" });
    return canDelegate && !delegated
      ? fauxAssistantMessage(
          fauxToolCall("subagent", {
            agent: "leaf",
            task: "Return bundled-native-ok",
            async: false,
            output: false,
          }),
          { stopReason: "toolUse" },
        )
      : fauxAssistantMessage("bundled-native-ok");
  }),
);
registry.setProvider(mock.provider);
const records = new Map();
const host = new NativeSubagentHost({
  directory,
  owner: "desktop-smoke",
  cwd,
  model: "smoke/test",
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
  host.setHistory([
    { role: "user", content: "Delegate the smoke test", timestamp: Date.now() },
  ]);
  const result = await host.execute("subagent", {
    agent: "parent",
    task: "Delegate to leaf",
    async: true,
    output: false,
  });
  assert.ok(result.details.asyncId, JSON.stringify(result));
  for (
    let count = 0;
    count < 200 &&
    ![...records.values()].some(
      (run) => run.agent === "parent" && run.status === "completed",
    );
    count++
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    [...records.values()].some(
      (run) =>
        run.agent === "leaf" &&
        run.response.includes("bundled-prefix; bundled-native-ok"),
    ),
    JSON.stringify(
      await host.execute("subagent", {
        action: "status",
        id: result.details.asyncId,
      }),
    ),
  );
  process.stdout.write("Bundled native async and nested subagents passed.\n");
} finally {
  await host.close();
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
