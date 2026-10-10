import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  stdin: {
    contents: `
      import { act, StrictMode } from "react";
      import { createRoot } from "react-dom/client";
      import { ReactFlowProvider } from "@xyflow/react";
      import { App } from "./src/App";
      export { act };
      export function mount() {
        const root = createRoot(document.getElementById("root"));
        root.render(<StrictMode><ReactFlowProvider><App /></ReactFlowProvider></StrictMode>);
        return root;
      }
    `,
    resolveDir: root,
    loader: "tsx",
  },
  bundle: true,
  jsx: "automatic",
  write: false,
  format: "iife",
  globalName: "InspectorTest",
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".css": "empty" },
  plugins: [
    {
      name: "vite-raw-text",
      setup(build) {
        build.onResolve({ filter: /\.txt\?raw$/ }, (args) => ({
          path: resolve(dirname(args.importer), args.path.slice(0, -4)),
          namespace: "raw-text",
        }));
        build.onLoad({ filter: /.*/, namespace: "raw-text" }, async (args) => ({
          contents: await readFile(args.path, "utf8"),
          loader: "text",
        }));
      },
    },
  ],
});

function fixture() {
  const node = (id, parentId, status, toolName) => ({
    id,
    parentId,
    status,
    prompt: `${id} question`,
    response: `${id} answer`,
    config: { model: "demo/pi-demo", thinking: "off" },
    color: "sage",
    position: { x: 0, y: 0 },
    createdAt: 1,
    contextIds: parentId ? [parentId] : [],
    revision: 0,
    toolCalls: toolName
      ? [
          {
            id: `${id}-tool`,
            name: toolName,
            arguments:
              toolName === "computer_use_call"
                ? {
                    tool: "click",
                    target: { windowId: 42 },
                    arguments: { x: 1, y: 2 },
                  }
                : { query: "glm context length" },
            status: "awaiting_approval",
            startedAt: 1,
          },
        ]
      : [],
  });
  return {
    instanceId: "inspector-test",
    revision: 1,
    workspaces: [
      {
        id: "cua",
        title: "CUA test",
        description: "",
        createdAt: 1,
        updatedAt: 1,
        nodes: [
          node("cua-root", null, "root"),
          node("cua-node", "cua-root", "running", "computer_use_call"),
          node("sibling", "cua-root", "running", "web_search"),
        ],
      },
      {
        id: "glm",
        title: "GLM test",
        description: "",
        createdAt: 1,
        updatedAt: 1,
        nodes: [
          node("glm-root", null, "root"),
          node("glm-node", "glm-root", "running", "web_search"),
        ],
      },
    ],
  };
}

async function mount(t, { models, state = fixture() } = {}) {
  const diagnostics = [];
  const virtualConsole = new VirtualConsole();
  for (const event of ["error", "warn", "jsdomError"])
    virtualConsole.on(event, (...args) => {
      const message = args.join(" ");
      // jsdom has no layout; canvas size/style warnings are outside this test.
      if (
        event === "warn" &&
        /https:\/\/reactflow\.dev\/error#(?:004|013)$/.test(message)
      )
        return;
      diagnostics.push(message);
    });
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
    runScripts: "outside-only",
    virtualConsole,
  });
  const { window } = dom;
  const channels = [];
  window.MessageChannel = class extends MessageChannel {
    constructor() {
      super();
      channels.push(this);
    }
  };
  window.IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = (media) => ({
    media,
    matches: media.includes("reduced-motion"),
    addEventListener() {},
    removeEventListener() {},
  });
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // Navigation uses a viewport animation; jsdom's zero-sized viewport would
  // produce invalid coordinates before the inspector can receive approval focus.
  Object.defineProperties(window.HTMLElement.prototype, {
    clientWidth: { get: () => 1024 },
    clientHeight: { get: () => 768 },
  });
  window.CSS = {
    escape: (value) => value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`),
  };
  window.HTMLElement.prototype.scrollTo = function () {};
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.localStorage.setItem("panel:workspace", "cua");
  window.localStorage.setItem("panel:node", "cua-node");
  const streams = new Set();
  window.EventSource = class extends window.EventTarget {
    constructor() {
      super();
      streams.add(this);
    }
    close() {
      streams.delete(this);
    }
  };
  const requests = [];
  window.fetch = async (url, options = {}) => {
    requests.push({ url, ...options });
    if (options.method === "POST" && url === "/api/workspaces") {
      const body = JSON.parse(options.body);
      const workspace = {
        id: "created",
        title: body.title,
        description: body.description,
        createdAt: 2,
        updatedAt: 2,
        example: false,
        approvalMode: body.approvalMode,
        safetyModel: body.safetyModel,
        defaultConfig: body.config,
        nodes: [
          {
            id: "created-root",
            parentId: null,
            prompt: body.title,
            response: body.description,
            status: "root",
            config: body.config,
            color: "sage",
            position: { x: 0, y: 0 },
            contextIds: [],
            createdAt: 2,
          },
        ],
      };
      state.workspaces.unshift(workspace);
      state.revision++;
      return {
        ok: true,
        json: async () => ({
          workspaceId: workspace.id,
          state: JSON.parse(JSON.stringify(state)),
        }),
      };
    }
    const createNode = url.match(/^\/api\/workspaces\/([^/]+)\/nodes$/);
    if (options.method === "POST" && createNode) {
      const workspace = state.workspaces.find(
        (item) => item.id === createNode[1],
      );
      assert.ok(workspace, "New card must target its owning workspace");
      const body = JSON.parse(options.body);
      const parent = workspace.nodes.find((item) => item.id === body.parentId);
      assert.ok(parent, "New card must have an existing parent");
      const node = {
        id: `created-node-${workspace.nodes.length}`,
        parentId: parent.id,
        prompt: body.prompt,
        response: "Branch answer",
        status: "completed",
        config: body.config,
        color: parent.color,
        position: { x: parent.position.x + 360, y: parent.position.y },
        contextIds: [...parent.contextIds, parent.id],
        createdAt: 2,
        revision: 0,
      };
      workspace.nodes.push(node);
      state.revision++;
      return {
        ok: true,
        json: async () => ({
          nodeId: node.id,
          state: JSON.parse(JSON.stringify(state)),
        }),
      };
    }
    const inputPath = url.match(
      /^\/api\/workspaces\/([^/]+)\/nodes\/([^/]+)\/inputs$/,
    );
    if (options.method === "POST" && inputPath) {
      const workspace = state.workspaces.find(
        (item) => item.id === inputPath[1],
      );
      const node = workspace?.nodes.find((item) => item.id === inputPath[2]);
      const body = JSON.parse(options.body);
      assert.ok(node, "Input must target its owning card");
      if (node.status !== "running" || body.expectedRevision !== node.revision)
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: "当前任务已结束，消息未发送" }),
        };
      const input = {
        id: body.requestId,
        text: body.text,
        mode: body.mode,
        status: "queued",
        createdAt: 2,
      };
      (node.runInputs ??= []).push(input);
      state.revision++;
      return {
        ok: true,
        json: async () => ({ input, state: JSON.parse(JSON.stringify(state)) }),
      };
    }
    const approval = url.match(
      /^\/api\/workspaces\/([^/]+)\/nodes\/([^/]+)\/approvals\/([^/]+)$/,
    );
    if (options.method === "POST" && approval) {
      const owner = state.workspaces.find((item) => item.id === approval[1]);
      const node = owner?.nodes.find((item) => item.id === approval[2]);
      const call = node?.toolCalls.find(
        (item) => item.id === decodeURIComponent(approval[3]),
      );
      const body = JSON.parse(options.body);
      assert.ok(call, "Approval must target its owning card");
      if (
        body.expectedRevision !== node.revision ||
        call.status !== "awaiting_approval"
      )
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: "这次审批已失效" }),
        };
      call.status = body.decision === "deny" ? "denied" : "running";
      state.revision++;
      return { ok: true, json: async () => JSON.parse(JSON.stringify(state)) };
    }
    assert.equal(
      options.method ?? "GET",
      "GET",
      "Fixture must not perform other mutations",
    );
    const values = {
      "/api/state": state,
      "/api/models": models ?? [
        {
          id: "demo/pi-demo",
          name: "Pi Demo",
          provider: "demo",
          available: true,
          demo: true,
          default: true,
          thinkingLevels: ["off"],
          contextWindow: 128000,
        },
      ],
      "/api/capabilities": { toolBatchApproval: true, runInputs: true },
    };
    assert.ok(Object.hasOwn(values, url), `Unexpected request: ${url}`);
    return {
      ok: true,
      json: async () => JSON.parse(JSON.stringify(values[url])),
    };
  };
  window.eval(bundle.outputFiles[0].text);
  const { act } = window.InspectorTest;
  let app;
  t.after(async () => {
    try {
      await act(() => app?.unmount());
    } finally {
      window.close();
      for (const channel of channels) {
        channel.port1.close();
        channel.port2.close();
      }
    }
  });
  await act(async () => {
    app = window.InspectorTest.mount();
  });
  const document = window.document;
  const inspector = () => document.querySelector("#node-inspector");
  const click = async (element) => {
    assert.ok(element, "Expected clickable element");
    await act(() =>
      element.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
    );
  };
  const select = async (id) => {
    await click(document.querySelector(`.react-flow__node[data-id="${id}"]`));
    assert.equal(
      inspector().querySelector(".node-question").textContent,
      `${id} question`,
    );
  };
  const publish = async () => {
    state.revision++;
    await act(() => {
      for (const stream of streams)
        stream.onmessage?.({ data: JSON.stringify(state) });
    });
  };
  const assertTools = (ids) => {
    assert.deepEqual(
      Array.from(
        inspector().querySelectorAll("[data-tool-call-id]"),
        (el) => el.dataset.toolCallId,
      ),
      ids,
    );
    assert.equal(
      inspector().querySelectorAll(".tool-activity").length,
      ids.length ? 1 : 0,
    );
  };
  return {
    state,
    diagnostics,
    requests,
    inspector,
    document,
    click,
    select,
    publish,
    assertTools,
    flushFrame: () =>
      act(() => new Promise((resolve) => window.setTimeout(resolve, 40))),
    unmount: async () => {
      await act(() => app.unmount());
      app = undefined;
    },
    change: async (element, value) => {
      assert.ok(element, "Expected editable element");
      const prototype =
        element.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : element.tagName === "INPUT"
            ? window.HTMLInputElement.prototype
            : window.HTMLSelectElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(
        element,
        value,
      );
      await act(() => {
        element.dispatchEvent(new window.Event("input", { bubbles: true }));
        element.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
    },
  };
}

test("running input sends to the selected card, preserves per-card drafts and renders delivery state", async (t) => {
  const ui = await mount(t);
  await ui.publish();
  const textarea = () =>
    ui.inspector().querySelector('[aria-label="追加任务消息"]');
  await ui.change(textarea(), "adjust A");
  await ui.select("sibling");
  assert.equal(textarea().value, "");
  await ui.change(textarea(), "finish B afterwards");
  await ui.change(
    ui.inspector().querySelector('[aria-label="追加消息发送方式"]'),
    "followUp",
  );
  await ui.click(ui.inspector().querySelector('[aria-label="发送追加消息"]'));
  const sent = ui.requests.filter((request) => request.url.endsWith("/inputs"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "/api/workspaces/cua/nodes/sibling/inputs");
  assert.equal(JSON.parse(sent[0].body).mode, "followUp");
  assert.equal(textarea().value, "");
  assert.match(
    ui.inspector().querySelector(".run-input-history").textContent,
    /finish B afterwards.*等待接收|等待接收.*finish B afterwards/,
  );
  const sibling = ui.state.workspaces[0].nodes.find(
    (node) => node.id === "sibling",
  );
  sibling.runInputs[0].status = "delivered";
  await ui.publish();
  assert.match(
    ui.inspector().querySelector(".run-input-history").textContent,
    /已接收/,
  );
  await ui.select("cua-node");
  assert.equal(textarea().value, "adjust A");
  assert.equal(ui.inspector().querySelector(".run-input-history"), null);
  await ui.click(ui.inspector().querySelector('[aria-label="发送追加消息"]'));
  assert.equal(
    JSON.parse(
      ui.requests.filter((request) => request.url.endsWith("/inputs"))[1].body,
    ).mode,
    "steer",
  );
  assert.deepEqual(ui.diagnostics, []);
});

test("completion during submission preserves the unsent draft for a new branch", async (t) => {
  const ui = await mount(t);
  await ui.publish();
  const textarea = ui.inspector().querySelector('[aria-label="追加任务消息"]');
  await ui.change(textarea, "unsent guidance");
  // The server has finished; the client still displays its last running snapshot.
  const node = ui.state.workspaces[0].nodes[1];
  node.status = "completed";
  await ui.click(ui.inspector().querySelector('[aria-label="发送追加消息"]'));
  assert.equal(
    ui.requests.filter((request) => request.url.endsWith("/inputs")).length,
    1,
  );
  assert.equal(textarea.value, "unsent guidance");
  assert.equal(node.runInputs, undefined);
  await ui.publish();
  assert.equal(
    ui.inspector().querySelector('[aria-label="新分支问题"]').value,
    "unsent guidance",
  );
  assert.deepEqual(ui.diagnostics, []);
});

test("queued cards allow drafts but cannot submit input before the run starts", async (t) => {
  const ui = await mount(t);
  ui.state.workspaces[0].nodes[1].status = "queued";
  await ui.publish();
  await ui.change(
    ui.inspector().querySelector('[aria-label="追加任务消息"]'),
    "draft while queued",
  );
  assert.equal(
    ui.inspector().querySelector('[aria-label="发送追加消息"]').disabled,
    true,
  );
  ui.state.workspaces[0].nodes[1].status = "running";
  await ui.publish();
  assert.equal(
    ui.inspector().querySelector('[aria-label="发送追加消息"]').disabled,
    false,
  );
  assert.equal(
    ui.inspector().querySelector('[aria-label="追加任务消息"]').value,
    "draft while queued",
  );
  assert.deepEqual(ui.diagnostics, []);
});

test("running cards and workspaces never retain another card's tools", async (t) => {
  const ui = await mount(t);
  ui.assertTools(["cua-node-tool"]);
  for (let i = 0; i < 3; i++) {
    await ui.select("sibling");
    ui.assertTools(["sibling-tool"]);
    await ui.select("cua-node");
    ui.assertTools(["cua-node-tool"]);
  }
  await ui.click(
    Array.from(ui.document.querySelectorAll(".workspace-item")).find((el) =>
      el.textContent.includes("GLM test"),
    ),
  );
  ui.assertTools([]);
  await ui.select("glm-node");
  ui.assertTools(["glm-node-tool"]);
  const glm = ui.state.workspaces[1].nodes[1];
  glm.status = "completed";
  glm.toolCalls[0].status = "completed";
  await ui.publish();
  ui.assertTools(["glm-node-tool"]);
  assert.equal(
    ui
      .inspector()
      .querySelectorAll(".tool-approval-actions, .generation-indicator").length,
    0,
  );
  assert.deepEqual(ui.diagnostics, []);
});

test("stream updates preserve disclosure state while retries reset the entire conversation", async (t) => {
  const ui = await mount(t);
  const cua = ui.state.workspaces[0].nodes[1];
  const disclosure = ui.inspector().querySelector(".tool-activity-disclosure");
  disclosure.open = true;
  cua.response += " streamed update";
  await ui.publish();
  assert.equal(
    ui.inspector().querySelector(".tool-activity-disclosure"),
    disclosure,
  );
  assert.equal(disclosure.open, true);
  cua.status = "cancelled";
  cua.toolCalls[0].status = "cancelled";
  await ui.publish();
  ui.assertTools(["cua-node-tool"]);
  assert.equal(
    ui
      .inspector()
      .querySelectorAll(".tool-approval-actions, .generation-indicator").length,
    0,
  );
  cua.revision++;
  cua.status = "running";
  cua.toolCalls[0].status = "awaiting_approval";
  await ui.publish();
  ui.assertTools(["cua-node-tool"]);
  assert.equal(disclosure.isConnected, false);
  assert.equal(
    ui.inspector().querySelector(".tool-activity-disclosure").open,
    false,
  );
  cua.toolCalls = [];
  await ui.publish();
  ui.assertTools([]);
  assert.deepEqual(ui.diagnostics, []);
});

test("subagent avatars open the matching inspector child and live updates preserve selection", async (t) => {
  const ui = await mount(t);
  const card = ui.state.workspaces[0].nodes[1];
  card.subagentsEnabled = true;
  card.subagents = ["scout", "worker", "reviewer"].map((agent, index) => ({
    id: `child-${index}`,
    agent,
    task: `independent task ${index}`,
    model: "openai/test",
    status: "running",
    response: `child result ${index}`,
    createdAt: 1,
  }));
  card.toolCalls[0].subagentId = "child-1";
  await ui.publish();
  ui.assertTools([]);
  card.toolCalls.push(
    {
      id: "main-delegation",
      name: "subagent",
      arguments: { agent: "worker", task: "independent task 1" },
      status: "completed",
      startedAt: 1,
    },
    {
      id: "other-child-tool",
      subagentId: "child-0",
      name: "web_search",
      arguments: { query: "child research" },
      status: "failed",
      startedAt: 1,
    },
  );
  await ui.publish();
  ui.assertTools(["main-delegation"]);
  assert.equal(
    ui.inspector().querySelector(".tool-activity-count").textContent,
    "1 次操作",
  );
  assert.doesNotMatch(
    ui.inspector().querySelector(".tool-activity-heading").textContent,
    /失败|待批准/,
  );
  const avatars = ui.document.querySelectorAll(
    '.react-flow__node[data-id="cua-node"] .card-subagents button',
  );
  assert.equal(avatars.length, 3);
  await ui.click(avatars[1]);
  assert.match(
    ui.inspector().querySelector(".inspector-tabs .active").textContent,
    /Subagents/,
  );
  assert.match(
    ui.inspector().querySelector(".subagent-task").textContent,
    /independent task 1/,
  );
  assert.equal(
    ui.inspector().querySelectorAll(".subagents-panel [data-tool-call-id]")
      .length,
    1,
  );
  card.subagents[1].response += " streamed child answer";
  await ui.publish();
  assert.match(
    ui.inspector().querySelector(".subagent-detail").textContent,
    /streamed child answer/,
  );
  await ui.click(ui.inspector().querySelectorAll(".subagent-list-item")[2]);
  assert.match(
    ui.inspector().querySelector(".subagent-task").textContent,
    /independent task 2/,
  );
  assert.equal(
    ui.inspector().querySelectorAll(".subagent-detail [data-tool-call-id]")
      .length,
    0,
  );
  await ui.click(
    [...ui.inspector().querySelectorAll(".inspector-tabs button")].find(
      (button) => button.textContent.includes("对话详情"),
    ),
  );
  ui.assertTools(["main-delegation"]);
  await ui.click(
    [...ui.document.querySelectorAll(".pending-approval-trigger")].find(
      (button) => button.title.includes(card.prompt),
    ),
  );
  assert.match(
    ui.document.querySelector(".pending-approval-panel").textContent,
    /子代理 · 执行 2/,
  );
  await ui.click(ui.document.querySelector(".pending-approval-locate"));
  await ui.flushFrame();
  assert.match(
    ui.inspector().querySelector(".inspector-tabs .active").textContent,
    /Subagents/,
  );
  assert.match(
    ui.inspector().querySelector(".subagent-task").textContent,
    /independent task 1/,
  );
  assert.ok(
    ui
      .inspector()
      .querySelector(
        '.subagent-detail [data-tool-call-id="cua-node-tool"] .tool-approval-actions',
      ),
  );
  assert.equal(
    ui.inspector().querySelector(".subagent-detail .tool-activity-disclosure")
      .open,
    true,
  );
  await ui.select("sibling");
  assert.equal(ui.inspector().querySelector(".subagents-panel"), null);
  assert.doesNotMatch(
    ui.inspector().querySelector(".inspector-tabs").textContent,
    /Subagents/,
  );
  assert.deepEqual(ui.diagnostics, []);
});

test("global child approvals target their own workspace and card without changing the open conversation", async (t) => {
  const ui = await mount(t);
  const owner = ui.state.workspaces[1];
  const card = owner.nodes[1];
  card.revision = 4;
  card.subagents = [
    {
      id: "research-child",
      agent: "researcher",
      task: "Research docs",
      model: "demo/pi-demo",
      status: "running",
      response: "",
      createdAt: 1,
    },
  ];
  const call = card.toolCalls[0];
  call.subagentId = "research-child";
  call.safetyReview = {
    model: "review/model",
    decision: "deny",
    reason: "需要用户确认具体查询范围",
    startedAt: 1,
    finishedAt: 2,
  };
  await ui.publish();
  await ui.select("sibling");
  const open = () =>
    ui.click(
      [...ui.document.querySelectorAll(".pending-approval-trigger")].find(
        (button) => button.title.includes(card.prompt),
      ),
    );
  await open();
  const panel = () => ui.document.querySelector(".pending-approval-panel");
  assert.match(panel().textContent, /子代理 · 研究 1/);
  assert.match(panel().textContent, /glm context length/);
  assert.match(panel().textContent, /需要用户确认具体查询范围/);
  assert.match(panel().textContent, /拒绝仅跳过这次调用/);
  await ui.click(panel().querySelector(".tool-deny"));
  assert.equal(call.status, "denied");
  assert.equal(card.subagents[0].status, "running");
  assert.equal(panel(), null);
  assert.equal(
    ui.inspector().querySelector(".node-question").textContent,
    "sibling question",
  );
  const request = ui.requests.find((request) => request.method === "POST");
  assert.equal(
    request.url,
    "/api/workspaces/glm/nodes/glm-node/approvals/glm-node-tool",
  );
  assert.deepEqual(JSON.parse(request.body), {
    decision: "deny",
    expectedRevision: 4,
  });
  assert.equal(
    ui.state.workspaces[0].nodes[2].toolCalls[0].status,
    "awaiting_approval",
  );
  call.id = "research-child:next";
  call.status = "awaiting_approval";
  await ui.publish();
  await open();
  await ui.click(panel().querySelector(".tool-approve"));
  assert.equal(call.status, "running");
  assert.equal(
    ui.requests.at(-1).url,
    "/api/workspaces/glm/nodes/glm-node/approvals/research-child%3Anext",
  );
  assert.deepEqual(ui.diagnostics, []);
});

test("expired global approval reports the conflict and never approves a replacement run", async (t) => {
  const ui = await mount(t);
  const card = ui.state.workspaces[0].nodes[1];
  await ui.click(
    [...ui.document.querySelectorAll(".pending-approval-trigger")].find(
      (button) => button.title.includes(card.prompt),
    ),
  );
  card.revision++;
  await ui.click(
    ui.document.querySelector(".pending-approval-panel .tool-approve"),
  );
  assert.equal(card.toolCalls[0].status, "awaiting_approval");
  assert.match(
    ui.document.querySelector(".pending-approval-panel").textContent,
    /这次审批已失效/,
  );
  assert.deepEqual(ui.diagnostics, []);
});

const creationModels = [
  {
    id: "demo/pi-demo",
    name: "Demo",
    provider: "demo",
    available: true,
    demo: true,
    thinkingLevels: ["off"],
    contextWindow: 128000,
  },
  {
    id: "test/default",
    name: "Default",
    provider: "test",
    available: true,
    demo: false,
    default: true,
    thinkingLevels: ["off", "medium", "high"],
    contextWindow: 128000,
  },
  {
    id: "test/execution",
    name: "Execution",
    provider: "test",
    available: true,
    demo: false,
    thinkingLevels: ["low", "high", "max"],
    contextWindow: 128000,
  },
  {
    id: "test/unavailable",
    name: "Unavailable",
    provider: "test",
    available: false,
    demo: false,
    thinkingLevels: ["off"],
    contextWindow: 128000,
  },
];

test("new exploration submits chosen models and approval settings and uses them for the first conversation", async (t) => {
  const ui = await mount(t, { models: creationModels });
  await ui.click(ui.document.querySelector(".new-exploration"));
  const form = () => ui.document.querySelector(".new-workspace-form");
  const model = () => form().querySelector('[aria-label="选择模型"]');
  const safety = () => form().querySelector('[aria-label="选择安全模型"]');
  const create = () => form().querySelector(".primary-button");
  assert.equal(model().value, "test/default");
  assert.equal(form().querySelector('[aria-label="长程任务"]'), null);
  await ui.change(
    form().querySelector("input[maxlength='80']"),
    "模型与审批测试",
  );
  await ui.change(model(), "test/execution");
  assert.equal(
    form().querySelector('[aria-label="思考强度"]').textContent,
    "low",
  );
  await ui.click(form().querySelector('[aria-label="思考强度"]'));
  await ui.click(ui.document.querySelector('[aria-label="选择 high 强度"]'));
  await ui.click(
    [...form().querySelectorAll("button")].find((button) =>
      button.textContent.includes("自动审批"),
    ),
  );
  assert.equal(create().disabled, true);
  assert.equal(ui.document.activeElement, safety());
  assert.match(form().querySelector('[role="alert"]').textContent, /安全模型/);
  assert.equal(safety().querySelector('[value="demo/pi-demo"]'), null);
  assert.equal(
    safety().querySelector('[value="test/unavailable"]').disabled,
    true,
  );
  await ui.change(safety(), "test/default");
  assert.equal(create().disabled, false);
  await ui.click(create());
  const request = ui.requests.find(
    (item) => item.url === "/api/workspaces" && item.method === "POST",
  );
  assert.deepEqual(JSON.parse(request.body), {
    title: "模型与审批测试",
    description: "",
    config: { model: "test/execution", thinking: "high" },
    approvalMode: "auto",
    safetyModel: "test/default",
  });
  assert.equal(form(), null);
  assert.equal(
    ui.inspector().querySelector('[aria-label="选择模型"]').value,
    "test/execution",
  );
  assert.equal(
    ui.inspector().querySelector('[aria-label="思考强度"]').textContent,
    "high",
  );
  const workspace = ui.state.workspaces.find((item) => item.id === "created");
  await ui.unmount();
  const reopened = await mount(t, {
    models: creationModels,
    state: { ...ui.state, workspaces: [workspace] },
  });
  assert.equal(
    reopened.inspector().querySelector('[aria-label="选择模型"]').value,
    "test/execution",
  );
  assert.equal(
    reopened.inspector().querySelector('[aria-label="思考强度"]').textContent,
    "high",
  );
  assert.deepEqual(ui.diagnostics, []);
  assert.deepEqual(reopened.diagnostics, []);
});

test("an explicitly selected demo model survives creation despite a real global default", async (t) => {
  const ui = await mount(t, { models: creationModels });
  await ui.click(ui.document.querySelector(".new-exploration"));
  const form = ui.document.querySelector(".new-workspace-form");
  await ui.change(form.querySelector("input[maxlength='80']"), "演示探索");
  await ui.change(
    form.querySelector('[aria-label="选择模型"]'),
    "demo/pi-demo",
  );
  await ui.click(form.querySelector(".primary-button"));
  assert.equal(
    ui.inspector().querySelector('[aria-label="选择模型"]').value,
    "demo/pi-demo",
  );
  const request = ui.requests.find(
    (item) => item.url === "/api/workspaces" && item.method === "POST",
  );
  assert.equal(JSON.parse(request.body).approvalMode, "ask");
  assert.equal(JSON.parse(request.body).safetyModel, undefined);
  assert.deepEqual(ui.diagnostics, []);
});

test("branching again from an unselected root keeps the workspace's initial model and thinking settings", async (t) => {
  const state = fixture();
  const workspace = state.workspaces[0];
  workspace.defaultConfig = {
    model: "test/execution",
    thinking: "high",
    thinkingMode: "enabled",
    effort: "high",
  };
  workspace.nodes[0].config = { ...workspace.defaultConfig };
  workspace.nodes[1].status = "completed";
  workspace.nodes[1].toolCalls = [];
  workspace.nodes = workspace.nodes.slice(0, 2);
  state.workspaces = [workspace];
  const models = creationModels.map((model) => ({
    ...model,
    default: model.demo,
    ...(model.id === "test/execution"
      ? {
          thinkingControls: {
            toggle: "supported",
            efforts: ["low", "high", "max"],
          },
        }
      : {}),
  }));
  const ui = await mount(t, { state, models });
  await ui.publish();
  // The completed first card uses Pi Demo. Clicking the root's + must use the
  // workspace preference rather than that card or the global demo default.
  assert.equal(
    ui.inspector().querySelector('[aria-label="选择模型"]').value,
    "demo/pi-demo",
  );
  for (const prompt of ["第二张卡片", "第三张卡片"]) {
    await ui.click(
      ui.document.querySelector(
        '.react-flow__node[data-id="cua-root"] .card-branch-button',
      ),
    );
    const draft = ui.document.querySelector('[aria-label="新分支草稿"]');
    assert.ok(draft);
    assert.equal(
      draft.querySelector('[aria-label="选择模型"]').value,
      "test/execution",
    );
    assert.equal(
      draft.querySelector('[aria-label="effort 强度"]').textContent,
      "high",
    );
    assert.equal(
      draft
        .querySelector('[aria-label="思考开关"]')
        .getAttribute("aria-checked"),
      "true",
    );
    await ui.change(
      draft.querySelector('[aria-label="卡片中的新问题"]'),
      prompt,
    );
    const submit = ui.document.querySelector(".branch-draft-submit");
    assert.equal(submit.disabled, false);
    await ui.click(submit);
    const request = ui.requests.findLast(
      (item) =>
        item.method === "POST" && item.url === "/api/workspaces/cua/nodes",
    );
    assert.ok(request);
    const body = JSON.parse(request.body);
    assert.equal(body.parentId, "cua-root");
    assert.equal(body.prompt, prompt);
    assert.deepEqual(body.config, {
      ...workspace.defaultConfig,
      longTask: false,
    });
    assert.equal(ui.document.querySelector('[aria-label="新分支草稿"]'), null);
    assert.equal(
      ui.inspector().querySelector('[aria-label="选择模型"]').value,
      "test/execution",
    );
  }
  assert.deepEqual(ui.diagnostics, []);
});
