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

async function mount(t) {
  const state = fixture();
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
    assert.equal(
      options.method ?? "GET",
      "GET",
      "Fixture must not execute tools",
    );
    const values = {
      "/api/state": state,
      "/api/models": [
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
      "/api/capabilities": { toolBatchApproval: true },
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
  };
}

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
    ui.inspector().querySelectorAll(".subagents-panel [data-tool-call-id]")
      .length,
    0,
  );
  await ui.select("sibling");
  assert.equal(ui.inspector().querySelector(".subagents-panel"), null);
  assert.doesNotMatch(
    ui.inspector().querySelector(".inspector-tabs").textContent,
    /Subagents/,
  );
  assert.deepEqual(ui.diagnostics, []);
});
