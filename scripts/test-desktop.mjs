import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = resolve(
  process.env.PANEL_TEST_APP ||
    join(root, "release/Panel.app/Contents/Resources/app"),
);
const node =
  process.env.PANEL_NODE_BINARY || resolve(app, "../runtime/bin/node");
const directory = await mkdtemp(join(tmpdir(), "panel-desktop-test-"));
const readyFile = join(directory, "server.json");
const environment = {
  PATH: process.env.PATH,
  HOME: directory,
  TMPDIR: tmpdir(),
  NODE_ENV: "production",
  PORT: "0",
  PANEL_ENV_FILE: join(directory, ".env"),
  PANEL_DATA_DIR: join(directory, "data"),
  PANEL_DESKTOP_READY_FILE: readyFile,
  PANEL_DESKTOP_PARENT_PID: String(process.pid),
};
let child;
let blocker;
let modelService;
let output = "";
let url;
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
async function start(overrides = {}) {
  output = "";
  child = spawn(node, [join(app, "server/index.mjs")], {
    cwd: app,
    env: { ...environment, ...overrides },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  child.on("error", (error) => (output += error.message));
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`Desktop service exited: ${output}`);
    try {
      const ready = JSON.parse(await readFile(readyFile, "utf8"));
      if (ready.pid === child.pid) {
        url = ready.url;
        return;
      }
    } catch {
      /* Wait for atomic readiness file. */
    }
    await delay(100);
  }
  throw new Error(`Desktop service did not become ready: ${output}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, "close");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  child.kill("SIGTERM");
  const [code] = await closed;
  clearTimeout(timeout);
  assert.equal(code, 0, output);
  child = undefined;
  await assert.rejects(readFile(readyFile), { code: "ENOENT" });
}
async function api(path, body, method = body ? "POST" : "GET") {
  const response = await fetch(url + path, {
    method,
    headers: { Origin: url, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
}
try {
  await start();
  const initialUrl = url;
  assert.match(await (await fetch(url)).text(), /<div id="root">/);
  const models = await api("/api/models");
  const capabilities = await api("/api/capabilities");
  assert.equal(capabilities.toolRequests, true);
  assert.equal(capabilities.longTasks, true);
  assert.equal(capabilities.computerUseTakeover, true);
  const computer = await api("/api/computer-use");
  assert.equal(computer.overlay, true);
  assert.equal(
    computer.connected,
    false,
    "Reading status must not start desktop control",
  );
  try {
    const manifest = JSON.parse(
      await readFile(
        join(
          app,
          "cua-driver",
          computer.version,
          process.platform === "darwin"
            ? "darwin-universal"
            : `${process.platform}-${process.arch}`,
          "release.json",
        ),
        "utf8",
      ),
    );
    assert.equal(
      computer.available,
      true,
      "Bundled official Cua Driver should be discoverable",
    );
    assert.equal(computer.version, manifest.version);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    assert.equal(computer.available, false);
  }
  assert.ok(
    models.some((model) => model.id === "demo/pi-demo" && model.available),
  );
  assert.ok(
    models.filter((model) => !model.demo).every((model) => !model.available),
    "Smoke test must not inherit model credentials",
  );
  const providerSettings = await api("/api/model-providers");
  assert.ok(providerSettings.every((provider) => !provider.apiKeyConfigured));
  modelService = createHttpServer((request, response) => {
    assert.ok(["/v1/models", "/api/v1/models"].includes(request.url));
    assert.equal(request.headers.authorization, "Bearer catalog-test-key");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        request.url === "/api/v1/models"
          ? {
              success: true,
              data: [
                {
                  slug: "z-ai/glm-5.3-flash",
                  displayName: "GLM Flash",
                  contextWindow: 262144,
                },
              ],
            }
          : { data: [{ id: "glm-5.3-flash" }] },
      ),
    );
  });
  modelService.listen(0, "127.0.0.1");
  await once(modelService, "listening");
  const catalog = await api("/api/model-providers/openai/models", {
    baseUrl: `http://127.0.0.1:${modelService.address().port}/v1`,
    apiKey: "catalog-test-key",
  });
  assert.deepEqual(catalog, {
    models: [{ id: "glm-5.3-flash", name: "glm-5.3-flash" }],
    truncated: false,
  });
  const paperCatalog = await api("/api/model-providers/paperbypass/models", {
    baseUrl: `http://127.0.0.1:${modelService.address().port}/api`,
    apiKey: "catalog-test-key",
  });
  assert.deepEqual(paperCatalog, {
    models: [
      { id: "z-ai/glm-5.3-flash", name: "GLM Flash", contextWindow: 262144 },
    ],
    truncated: false,
  });
  assert.deepEqual(await api("/api/model-providers"), providerSettings);
  assert.deepEqual(await api("/api/models"), models);
  await new Promise((resolve) => modelService.close(resolve));
  modelService = undefined;
  const testKey = "panel-desktop-test-key-not-a-real-credential";
  const configured = await api(
    "/api/model-providers/openai",
    {
      baseUrl: "http://127.0.0.1:9/v1",
      model: "desktop-test-model",
      apiKey: testKey,
      protocol: "openai-completions",
      contextWindow: 262144,
    },
    "PUT",
  );
  assert.equal(configured.provider.apiKeyConfigured, true);
  assert.equal(configured.provider.protocol, "openai-completions");
  assert.equal(
    configured.models.find((model) => model.id === "openai/desktop-test-model")
      .contextWindow,
    262144,
  );
  assert.equal(
    configured.models.find((model) => model.id === "openai/desktop-test-model")
      .contextWindowSource,
    "configured",
  );
  assert.ok(
    configured.models.some(
      (model) => model.id === "openai/desktop-test-model" && model.available,
    ),
  );
  assert.ok(!JSON.stringify(configured).includes(testKey));
  const created = await api("/api/workspaces", {
    title: "Mac 客户端验收",
    description: "独立运行时测试",
  });
  const workspace = created.state.workspaces.find(
    (item) => item.id === created.workspaceId,
  );
  const request = {
    prompt: "验证 macOS 内置运行时",
    parentId: workspace.nodes[0].id,
    requestId: "mac-desktop-smoke-001",
    config: { model: "demo/pi-demo", thinking: "off", longTask: true },
  };
  await api(`/api/workspaces/${workspace.id}/nodes`, request);
  await api(`/api/workspaces/${workspace.id}/nodes`, request);
  let completed;
  for (let attempt = 0; attempt < 150; attempt++) {
    const state = await api("/api/state");
    const nodes = state.workspaces.find(
      (item) => item.id === workspace.id,
    ).nodes;
    assert.equal(
      nodes.length,
      2,
      "Idempotent submission must not duplicate a run",
    );
    const turn = nodes.find((item) => item.parentId);
    if (turn.status === "failed") throw new Error(turn.error);
    if (turn.status === "completed") {
      completed = turn;
      break;
    }
    await delay(100);
  }
  assert.ok(
    completed?.response,
    "Bundled Pi Agent should stream a complete demo response",
  );
  assert.equal(completed.config.longTask, true);
  const exported = await fetch(
    `${url}/api/workspaces/${workspace.id}/export?format=json`,
  );
  assert.ok(exported.ok);
  assert.match(exported.headers.get("content-disposition"), /attachment/);
  const exportText = await exported.text();
  assert.match(exportText, /Mac 客户端验收/);
  assert.ok(
    !exportText.includes(testKey),
    "Provider credentials must not be exported",
  );
  // Exercise the bundled upstream engine with a local model fixture. This
  // catches SDK asset/import assumptions that source-runtime tests cannot.
  let childRequests = 0;
  modelService = createHttpServer(async (request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const isParent = body.tools?.some(
      (tool) => tool.function.name === "subagent",
    );
    const delegate =
      isParent && !body.messages.some((message) => message.role === "tool");
    if (!isParent) childRequests++;
    const delta = delegate
      ? {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "delegate-desktop",
              type: "function",
              function: {
                name: "subagent",
                arguments: JSON.stringify({
                  tasks: [
                    { agent: "scout", task: "local fixture one" },
                    { agent: "reviewer", task: "local fixture two" },
                  ],
                }),
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: isParent
            ? "bundled parent synthesis"
            : "bundled child result",
        };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const choice of [
      { index: 0, delta, finish_reason: null },
      { index: 0, delta: {}, finish_reason: delegate ? "tool_calls" : "stop" },
    ]) {
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "desktop-test-model", choices: [choice] })}\n\n`,
      );
    }
    response.end("data: [DONE]\n\n");
  });
  modelService.listen(0, "127.0.0.1");
  await once(modelService, "listening");
  await api(
    "/api/model-providers/openai",
    {
      baseUrl: `http://127.0.0.1:${modelService.address().port}/v1`,
      model: "desktop-test-model",
      apiKey: testKey,
      protocol: "openai-completions",
      contextWindow: 262144,
    },
    "PUT",
  );
  await api(`/api/workspaces/${workspace.id}/nodes`, {
    parentId: workspace.nodes[0].id,
    prompt: "Delegate two independent fixture tasks",
    requestId: "desktop-subagents-001",
    toolRequests: ["subagents"],
    config: { model: "openai/desktop-test-model", thinking: "off" },
  });
  let subagentTurn;
  for (let attempt = 0; attempt < 200; attempt++) {
    subagentTurn = (await api("/api/state")).workspaces
      .find((item) => item.id === workspace.id)
      .nodes.at(-1);
    if (subagentTurn.status === "failed") throw new Error(subagentTurn.error);
    if (subagentTurn.status === "completed") break;
    await delay(100);
  }
  assert.equal(subagentTurn.status, "completed", JSON.stringify(subagentTurn));
  assert.equal(childRequests, 2);
  assert.equal(subagentTurn.subagentsEnabled, true);
  assert.equal(subagentTurn.subagents.length, 2);
  assert.ok(
    subagentTurn.subagents.every(
      (run) =>
        run.status === "completed" &&
        run.response.includes("bundled child result"),
    ),
    JSON.stringify(subagentTurn.subagents),
  );
  assert.match(subagentTurn.response, /bundled parent synthesis/);
  await new Promise((resolve) => modelService.close(resolve));
  modelService = undefined;
  console.log(
    "PASS: bundled nicobailon executor, @subagents bootstrap, independent child sessions and parent synthesis",
  );
  assert.equal(
    (
      await fetch(url + "/api/state", {
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  const events = await fetch(url + "/api/events");
  const reader = events.body.getReader();
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /^data: /,
  );
  await reader.cancel();
  await stop();
  await start();
  assert.equal(
    url,
    initialUrl,
    "Desktop origin should persist between launches",
  );
  const restoredNode = (await api("/api/state")).workspaces
    .find((item) => item.id === workspace.id)
    ?.nodes.find((item) => item.id === completed.id);
  assert.ok(restoredNode);
  assert.equal(restoredNode.config.longTask, true);
  const restoredProvider = (await api("/api/model-providers")).find(
    (provider) => provider.id === "openai",
  );
  assert.equal(restoredProvider.model, "desktop-test-model");
  assert.equal(restoredProvider.protocol, "openai-completions");
  assert.equal(restoredProvider.apiKeyConfigured, true);
  assert.equal(
    restoredProvider.models.find((model) => model.id === "desktop-test-model")
      .contextWindow,
    262144,
  );
  assert.ok(!JSON.stringify(restoredProvider).includes(testKey));
  await stop();
  blocker = createServer();
  blocker.listen(Number(new URL(initialUrl).port), "127.0.0.1");
  await once(blocker, "listening");
  await start();
  assert.notEqual(
    url,
    initialUrl,
    "Occupied saved port must fall back to an available port",
  );
  await stop();
  blocker.close();
  blocker = undefined;
  console.log(
    "PASS: standalone runtime, assets, model catalog, provider settings persistence/redaction, Pi demo, idempotency, SSE, export, origin checks, persistence, port reuse/fallback, graceful shutdown",
  );

  const require = createRequire(join(app, "package.json"));
  const loader = pathToFileURL(require.resolve("tsx")).href;
  const imports = ["pi-web-access/exa.ts", "pi-web-access/extract.ts", "unpdf"];
  const script = imports
    .map(
      (name) =>
        `await import(${JSON.stringify(pathToFileURL(require.resolve(name)).href)});`,
    )
    .join("\n");
  execFileSync(
    node,
    ["--import", loader, "--input-type=module", "-e", script],
    {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        PI_CODING_AGENT_DIR: directory,
      },
      stdio: "pipe",
    },
  );
  console.log(
    "PASS: bundled TS loader, web search/extraction engines, PDF runtime load without source checkout",
  );
  await start({ PANEL_DESKTOP_PARENT_PID: "2147483646" });
  const exited = once(child, "close");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 4000);
  const [code] = await exited;
  clearTimeout(timeout);
  assert.equal(code, 0, "Service must exit when desktop parent disappears");
  child = undefined;
  console.log("PASS: desktop parent death cleanup");
} finally {
  if (child && child.exitCode === null) child.kill("SIGKILL");
  blocker?.close();
  modelService?.close();
  await rm(directory, { recursive: true, force: true });
}
