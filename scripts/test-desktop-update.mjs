import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";

const bundle = await build({
  stdin: {
    contents: `import { act } from 'react'; import { createRoot } from 'react-dom/client'; import { DesktopUpdate } from './src/DesktopUpdate'; export { act }; export function mount(){ const root=createRoot(document.getElementById('root')); root.render(<DesktopUpdate/>); return root; }`,
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    loader: "tsx",
  },
  bundle: true,
  jsx: "automatic",
  write: false,
  format: "iife",
  globalName: "UpdateTest",
  define: { "process.env.NODE_ENV": '"development"' },
});

function channelsFor(window) {
  const channels = [];
  window.MessageChannel = class extends MessageChannel {
    constructor() {
      super();
      channels.push(this);
    }
  };
  return () => {
    for (const channel of channels) {
      channel.port1.close();
      channel.port2.close();
    }
  };
}

test("native update badge handles availability, progress, failure, retry and completion", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.IS_REACT_ACT_ENVIRONMENT = true;
  const closeChannels = channelsFor(window);
  let installs = 0,
    checks = 0;
  window.panelDesktop = {
    platform: "macos",
    getUpdateState: async () => ({ phase: "available", version: "v0.6" }),
    installUpdate: async () => {
      installs++;
      return { phase: "available" };
    },
    checkForUpdates: async () => {
      checks++;
      return { phase: "checking" };
    },
  };
  window.eval(bundle.outputFiles[0].text);
  const { act, mount } = window.UpdateTest;
  let root;
  t.after(async () => {
    await act(() => root.unmount());
    window.close();
    closeChannels();
  });
  await act(async () => {
    root = mount();
  });
  const button = () => window.document.querySelector("button");
  const state = (value) =>
    act(() =>
      window.dispatchEvent(
        new window.CustomEvent("panel:update-state", { detail: value }),
      ),
    );
  assert.match(button().textContent, /有更新/);
  assert.equal(button().getAttribute("aria-label"), "更新到 v0.6");
  await act(() => button().click());
  assert.equal(installs, 1);
  await state({ phase: "downloading", version: "v0.6", progress: 48 });
  assert.equal(button().disabled, true);
  assert.match(button().textContent, /48%/);
  await act(() => button().click());
  assert.equal(installs, 1);
  await state({ phase: "error", version: "v0.6", message: "请等待任务结束。" });
  assert.match(
    window.document.querySelector('[role="alert"]').textContent,
    /任务结束/,
  );
  await act(() => button().click());
  assert.equal(installs, 2);
  await state({ phase: "error", message: "网络不可用" });
  await act(() => button().click());
  assert.equal(checks, 1);
  await state({ phase: "idle" });
  assert.equal(button(), null);
});

test("check errors dismiss by close, Escape or timeout and retry checks even with a cached update", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.IS_REACT_ACT_ENVIRONMENT = true;
  const closeChannels = channelsFor(window);
  let checks = 0,
    installs = 0,
    dismissAfterTimeout;
  const realTimeout = window.setTimeout.bind(window);
  window.setTimeout = (callback, delay, ...args) => {
    if (delay === 8_000) {
      dismissAfterTimeout = callback;
      return 100_000;
    }
    return realTimeout(callback, delay, ...args);
  };
  window.panelDesktop = {
    platform: "macos",
    getUpdateState: async () => ({ phase: "idle" }),
    installUpdate: async () => {
      installs++;
    },
    checkForUpdates: async () => {
      checks++;
    },
  };
  window.eval(bundle.outputFiles[0].text);
  const { act, mount } = window.UpdateTest;
  let root;
  t.after(async () => {
    await act(() => root.unmount());
    window.close();
    closeChannels();
  });
  await act(async () => {
    root = mount();
  });
  const error = () =>
    act(() =>
      window.dispatchEvent(
        new window.CustomEvent("panel:update-state", {
          detail: {
            phase: "error",
            operation: "check",
            version: "v0.6",
            message: "GitHub 限流，将自动重试。",
          },
        }),
      ),
    );
  const alert = () => window.document.querySelector('[role="alert"]');
  await error();
  assert.ok(alert());
  await act(() =>
    window.document.querySelector('[aria-label="关闭更新提示"]').click(),
  );
  assert.equal(alert(), null);
  await error();
  await act(() =>
    window.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "Escape" }),
    ),
  );
  assert.equal(alert(), null);
  await error();
  await act(() => dismissAfterTimeout());
  assert.equal(alert(), null);
  await error();
  await act(() =>
    window.document.querySelector('[aria-label="检查 App 更新"]').click(),
  );
  assert.equal(checks, 1);
  assert.equal(installs, 0);
  assert.equal(alert(), null);
});

test("browser-only workbench does not advertise a native installer", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', {
    runScripts: "outside-only",
  });
  const closeChannels = channelsFor(dom.window);
  dom.window.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.eval(bundle.outputFiles[0].text);
  const { act, mount } = dom.window.UpdateTest;
  let root;
  t.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    closeChannels();
  });
  await act(() => {
    root = mount();
  });
  assert.equal(dom.window.document.querySelector("button"), null);
});
