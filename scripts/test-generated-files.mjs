import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  stdin: {
    contents: `
    import { act } from "react";
    import { createRoot } from "react-dom/client";
    import { GeneratedFiles } from "./src/GeneratedFiles";
    export { act };
    const root = createRoot(document.getElementById("root"));
    export function render(workspace, node) {
      root.render(<GeneratedFiles key={workspace.id + ':' + node.id + ':' + (node.revision ?? 0)} workspace={workspace} node={node} />);
    }
    export function unmount() { root.unmount(); }
  `,
    resolveDir: root,
    loader: "tsx",
  },
  bundle: true,
  jsx: "automatic",
  write: false,
  format: "iife",
  globalName: "GeneratedFilesTest",
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".css": "empty" },
});

const htmlFile = {
  id: "a".repeat(64),
  name: "opd-opsd-multimodal-survey.html",
  path: "opd-opsd-multimodal-survey.html",
  size: 51601,
  mediaType: "text/html; charset=utf-8",
  previewable: true,
  nativeOpenable: true,
  status: "available",
};

async function mount(t, { desktop, fetchFiles } = {}) {
  const diagnostics = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => diagnostics.push(error.message));
  virtualConsole.on("error", (...values) => diagnostics.push(values.join(" ")));
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://127.0.0.1:4317",
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  window.MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = {
        postMessage: () => setTimeout(() => this.port1.onmessage?.(), 0),
      };
    }
  };
  window.IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  if (desktop) window.panelDesktop = { platform: "macos", ...desktop };
  const requests = [];
  let files = [htmlFile];
  window.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        files: fetchFiles ? await fetchFiles(requests.length) : files,
      }),
    };
  };
  const downloads = [];
  const originalClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () {
    downloads.push({ href: this.href, name: this.download });
  };
  window.eval(bundle.outputFiles[0].text);
  const node = {
    id: "node",
    revision: 0,
    status: "completed",
    response: "文件：`opd-opsd-multimodal-survey.html`",
    toolCalls: [
      {
        id: "write",
        name: "write",
        status: "completed",
        arguments: { path: htmlFile.path },
      },
    ],
  };
  const workspace = {
    id: "opd",
    nodes: [node],
    temporaryDirectory: "/workspace",
  };
  const render = async (nextNode = node) => {
    await window.GeneratedFilesTest.act(async () => {
      window.GeneratedFilesTest.render(workspace, nextNode);
    });
  };
  await render();
  t.after(async () => {
    await window.GeneratedFilesTest.act(async () => {
      window.GeneratedFilesTest.unmount();
    });
    window.HTMLAnchorElement.prototype.click = originalClick;
    window.close();
  });
  const click = async (element) => {
    assert.ok(element, "Expected a file action element");
    await window.GeneratedFilesTest.act(async () => {
      element.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
  };
  return {
    window,
    document: window.document,
    requests,
    diagnostics,
    downloads,
    node,
    render,
    click,
    setFiles(value) {
      files = value;
    },
  };
}

test("historical files show metadata, open a sandboxed Web preview, and download the original", async (t) => {
  const ui = await mount(t);
  assert.match(
    ui.document.querySelector('[aria-label="交付文件"]').textContent,
    /opd-opsd-multimodal-survey.html.*HTML.*KB/,
  );
  assert.equal(
    ui.requests[0].url,
    "/api/workspaces/opd/nodes/node/generated-files?revision=0",
  );
  await ui.click(ui.document.querySelector(".generated-file-name"));
  const iframe = ui.document.querySelector("iframe");
  assert.ok(iframe);
  assert.match(iframe.src, /generated-files\/a{64}\/content\?revision=0$/);
  assert.equal(
    iframe.getAttribute("sandbox"),
    "allow-scripts allow-popups allow-popups-to-escape-sandbox",
  );
  assert.doesNotMatch(
    iframe.getAttribute("sandbox"),
    /allow-same-origin|allow-top-navigation/,
  );
  await ui.click(ui.document.querySelector('[aria-label="关闭文件预览"]'));
  assert.equal(ui.document.querySelector("iframe"), null);
  await ui.click(
    ui.document.querySelector(
      '[aria-label="下载 opd-opsd-multimodal-survey.html"]',
    ),
  );
  assert.equal(ui.downloads[0].name, htmlFile.name);
  assert.match(ui.downloads[0].href, /revision=0&download=1$/);
  assert.deepEqual(ui.diagnostics, []);
});

test("Mac opens and reveals server-registered IDs without handing arbitrary paths to the bridge", async (t) => {
  const actions = [];
  const ui = await mount(t, {
    desktop: {
      openGeneratedFile: async (target) => {
        actions.push({ action: "open", target });
      },
      revealGeneratedFile: async (target) => {
        actions.push({ action: "reveal", target });
      },
    },
  });
  await ui.click(
    ui.document.querySelector(
      '[aria-label="打开 opd-opsd-multimodal-survey.html"]',
    ),
  );
  await ui.click(
    ui.document.querySelector(
      '[aria-label="在 Finder 中显示 opd-opsd-multimodal-survey.html"]',
    ),
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(actions)),
    ["open", "reveal"].map((action) => ({
      action,
      target: {
        workspaceId: "opd",
        nodeId: "node",
        revision: 0,
        fileId: htmlFile.id,
      },
    })),
  );
  assert.equal(ui.document.querySelector("iframe"), null);
  assert.deepEqual(ui.diagnostics, []);
});

test("external file deletion is explained before opening and disables stale actions", async (t) => {
  const ui = await mount(t);
  ui.setFiles([{ ...htmlFile, status: "missing", size: undefined }]);
  await ui.click(ui.document.querySelector(".generated-file-name"));
  assert.match(
    ui.document.querySelector('[role="alert"]').textContent,
    /不存在或已删除/,
  );
  assert.match(
    ui.document.querySelector(".generated-file-info").textContent,
    /已删除或移动/,
  );
  assert.equal(
    ui.document.querySelector(".generated-file-name").disabled,
    true,
  );
  assert.equal(ui.document.querySelector("iframe"), null);
  assert.deepEqual(ui.diagnostics, []);
});

test("old Mac bridges fall back to Web previews; cards without execution evidence stay empty", async (t) => {
  const ui = await mount(t, { desktop: {} });
  await ui.click(ui.document.querySelector(".generated-file-name"));
  assert.ok(ui.document.querySelector("iframe"));
  await ui.render({
    ...ui.node,
    id: "plain",
    toolCalls: [],
    response: "`file.html`",
  });
  assert.equal(ui.document.querySelector('[aria-label="交付文件"]'), null);
  assert.deepEqual(ui.diagnostics, []);
});

test("a late file action cannot open a previous card after selection changes", async (t) => {
  let resolveFiles;
  const actions = [];
  const ui = await mount(t, {
    desktop: { openGeneratedFile: async (target) => actions.push(target) },
    fetchFiles: async (count) =>
      count === 2
        ? new Promise((resolve) => {
            resolveFiles = resolve;
          })
        : [htmlFile],
  });
  await ui.click(ui.document.querySelector(".generated-file-name"));
  await ui.render({ ...ui.node, id: "new", toolCalls: [] });
  await ui.window.GeneratedFilesTest.act(async () => {
    resolveFiles([htmlFile]);
  });
  assert.deepEqual(actions, []);
  assert.deepEqual(ui.diagnostics, []);
});

test("only completed deliveries show a file section, with no other-files entry", async (t) => {
  const ui = await mount(t, { fetchFiles: async () => [] });
  assert.equal(ui.document.querySelector(".generated-files"), null);
  assert.doesNotMatch(ui.document.body.textContent, /其他文件|查看本轮文件/);
  const count = ui.requests.length;
  await ui.render({ ...ui.node, status: "running" });
  assert.equal(ui.requests.length, count);
  assert.equal(ui.document.querySelector(".generated-files"), null);
  await ui.render({
    ...ui.node,
    status: "completed",
    response: "### 交付文件\n- `opd-opsd-multimodal-survey.html`",
  });
  assert.equal(ui.requests.length, count + 1);
  assert.deepEqual(ui.diagnostics, []);
});
