import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
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
async function api(path, body) {
  const response = await fetch(url + path, {
    method: body ? "POST" : "GET",
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
  assert.ok(
    models.some((model) => model.id === "demo/pi-demo" && model.available),
  );
  assert.ok(
    models.filter((model) => !model.demo).every((model) => !model.available),
    "Smoke test must not inherit model credentials",
  );
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
    config: { model: "demo/pi-demo", thinking: "off" },
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
  const exported = await fetch(
    `${url}/api/workspaces/${workspace.id}/export?format=json`,
  );
  assert.ok(exported.ok);
  assert.match(exported.headers.get("content-disposition"), /attachment/);
  assert.match(await exported.text(), /Mac 客户端验收/);
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
  assert.ok(
    (await api("/api/state")).workspaces
      .find((item) => item.id === workspace.id)
      ?.nodes.some((item) => item.id === completed.id),
  );
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
    "PASS: standalone runtime, assets, model catalog, Pi demo, idempotency, SSE, export, origin checks, persistence, port reuse/fallback, graceful shutdown",
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
  await rm(directory, { recursive: true, force: true });
}
