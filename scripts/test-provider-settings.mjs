import assert from "node:assert/strict";
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
      import { ProviderSettingsDialog } from "./src/ProviderSettingsDialog";
      export { act };
      export function mount(onSaved) {
        const root = createRoot(document.getElementById("root"));
        root.render(<StrictMode><ProviderSettingsDialog providerId="openai"
          providerName="OpenAI" onClose={() => {}} onSaved={onSaved} /></StrictMode>);
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
  globalName: "ProviderTest",
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".css": "empty" },
});

async function mount(t, configured = false, providerChanges = {}) {
  const diagnostics = [];
  const virtualConsole = new VirtualConsole();
  for (const event of ["error", "warn", "jsdomError"])
    virtualConsole.on(event, (...args) => diagnostics.push(args.join(" ")));
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
  window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  const timers = new Map();
  let timerId = 0;
  window.setTimeout = (callback, delay) => {
    assert.equal(delay, 650);
    timers.set(++timerId, callback);
    return timerId;
  };
  window.clearTimeout = (id) => timers.delete(id);
  const provider = {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://saved.test/v1",
    model: "builtin",
    protocol: "auto",
    apiKeyConfigured: configured,
    supportsContextWindow: true,
    models: [{ id: "builtin", name: "Built In" }],
    ...providerChanges,
  };
  const requests = [];
  const response = (value, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => value,
  });
  window.fetch = async (url, options = {}) => {
    if (url === "/api/model-providers" && !options.method)
      return response([provider]);
    const request = { url, ...options, body: JSON.parse(options.body) };
    requests.push(request);
    if (options.method === "PUT")
      return response({ models: [{ id: "selected" }] });
    assert.equal(options.method, "POST");
    assert.equal(url, "/api/model-providers/openai/models");
    return new Promise((resolve) => {
      request.resolve = (data, status) => resolve(response(data, status));
    });
  };
  window.eval(bundle.outputFiles[0].text);
  const { act } = window.ProviderTest;
  const saved = [];
  let app;
  t.after(async () => {
    try {
      await act(() => app?.unmount());
      assert.equal(timers.size, 0);
      assert.deepEqual(diagnostics, []);
    } finally {
      window.close();
      for (const channel of channels) {
        channel.port1.close();
        channel.port2.close();
      }
    }
  });
  await act(() => {
    app = window.ProviderTest.mount((models) => saved.push(models));
  });
  const document = window.document;
  const find = (selector) => {
    const element = document.querySelector(selector);
    assert.ok(element, `Missing element: ${selector}`);
    return element;
  };
  const edit = async (selector, value) => {
    const element = find(selector);
    await act(() => {
      element.focus();
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      ).set.call(element, value);
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  const click = async (selector) => act(() => find(selector).click());
  const select = async (selector, value) => {
    const element = find(selector);
    await act(() => {
      element.value = value;
      element.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
  };
  const flush = async () =>
    act(() => {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    });
  const deliver = async (request, models, status = 200) =>
    act(() => request.resolve(models, status));
  const key = async (value) =>
    act(() =>
      find("#provider-model").dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: value,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  const options = () =>
    Array.from(
      document.querySelectorAll('[role="option"]'),
      (item) => item.textContent,
    );
  const hint = () => find("#provider-model-hint").textContent;
  return {
    act,
    app,
    find,
    edit,
    click,
    select,
    flush,
    deliver,
    key,
    options,
    hint,
    requests,
    timers,
    saved,
  };
}

test("draft URL and key auto-discover after debounce; search and selection save only on submit", async (t) => {
  const ui = await mount(t);
  assert.equal(ui.timers.size, 0);
  await ui.edit("#provider-base-url", "https://draft.test/v1/");
  await ui.edit("#provider-api-key", "first");
  await ui.edit("#provider-api-key", "latest");
  assert.equal(ui.requests.length, 0);
  assert.equal(ui.timers.size, 1);
  await ui.flush();
  assert.equal(ui.requests.length, 1);
  assert.deepEqual(ui.requests[0].body, {
    baseUrl: "https://draft.test/v1",
    apiKey: "latest",
  });
  await ui.deliver(ui.requests[0], {
    models: [
      { id: "alpha", name: "Alpha" },
      { id: "glm-5.3-flash", name: "GLM Flash" },
    ],
    truncated: false,
  });
  assert.match(ui.hint(), /已获取 2 个模型/);
  assert.equal(ui.find("#provider-model").value, "builtin");
  await ui.click('[aria-label="展开模型列表"]');
  assert.equal(ui.options().length, 2);
  await ui.edit("#provider-model", "flash");
  assert.deepEqual(ui.options(), ["glm-5.3-flashGLM Flash"]);
  await ui.key("Enter");
  assert.equal(ui.find("#provider-model").value, "glm-5.3-flash");
  assert.equal(ui.requests.length, 1);
  await ui.click('button[type="submit"]');
  assert.equal(ui.requests[1].method, "PUT");
  assert.deepEqual(ui.requests[1].body, {
    baseUrl: "https://draft.test/v1/",
    apiKey: "latest",
    model: "glm-5.3-flash",
    protocol: "auto",
  });
  assert.deepEqual(ui.saved, [[{ id: "selected" }]]);
});

test("saved-key discovery aborts on URL change; stale responses cannot replace the new catalog", async (t) => {
  const ui = await mount(t, true);
  await ui.flush();
  const old = ui.requests[0];
  assert.deepEqual(old.body, { baseUrl: "https://saved.test/v1" });
  await ui.edit("#provider-base-url", "https://new.test/v1");
  assert.equal(old.signal.aborted, true);
  assert.equal(ui.timers.size, 0);
  assert.match(ui.hint(), /地址已改变/);
  await ui.edit("#provider-api-key", "new-key");
  await ui.flush();
  await ui.deliver(ui.requests[1], {
    models: [{ id: "new-model", name: "New" }],
    truncated: false,
  });
  await ui.deliver(old, {
    models: [{ id: "stale-model", name: "Stale" }],
    truncated: false,
  });
  await ui.click('[aria-label="展开模型列表"]');
  assert.deepEqual(ui.options(), ["new-modelNew"]);
  await ui.click('[role="option"]');
  assert.equal(ui.find("#provider-model").value, "new-model");
  await ui.click('[aria-label="刷新模型列表"]');
  await ui.flush();
  assert.equal(ui.requests.length, 3);
  await ui.act(() => ui.app.unmount());
  assert.equal(ui.requests[2].signal.aborted, true);
  await ui.deliver(ui.requests[2], { models: [], truncated: false });
});

test("discovery errors retain manual model entry and keyboard navigation", async (t) => {
  const ui = await mount(t, true);
  await ui.flush();
  await ui.deliver(
    ui.requests[0],
    { error: "服务未提供模型列表接口，可手动填写 Model ID。" },
    400,
  );
  assert.match(ui.hint(), /手动填写/);
  await ui.edit("#provider-model", "manual-model");
  assert.equal(ui.options().length, 0);
  await ui.key("Escape");
  assert.equal(
    ui.find("#provider-model").getAttribute("aria-expanded"),
    "false",
  );
  await ui.click('button[type="submit"]');
  assert.equal(ui.requests[1].body.model, "manual-model");
  assert.equal(Object.hasOwn(ui.requests[1].body, "apiKey"), false);
});

test("catalog context limits auto-fill and are saved with the selected model", async (t) => {
  const ui = await mount(t, true);
  await ui.flush();
  await ui.deliver(ui.requests[0], {
    models: [{ id: "remote", name: "Remote", contextWindow: 262144 }],
    truncated: false,
  });
  await ui.click('[aria-label="展开模型列表"]');
  await ui.click('[role="option"]');
  assert.equal(ui.find("#provider-context-window").value, "262144");
  await ui.click('button[type="submit"]');
  assert.equal(ui.requests[1].body.contextWindow, 262144);
  assert.equal(ui.requests[1].body.model, "remote");
});

test("unknown context remains unknown, allows a manual budget, and model or URL changes clear the draft override", async (t) => {
  const ui = await mount(t, true, {
    models: [
      {
        id: "builtin",
        name: "Custom",
        contextWindow: 128000,
        contextWindowSource: "fallback",
      },
    ],
  });
  assert.equal(ui.find("#provider-context-window").value, "");
  assert.match(ui.find("#provider-context-hint").textContent, /上限未知/);
  await ui.edit("#provider-context-window", "1000000");
  await ui.edit("#provider-model", "different");
  assert.equal(ui.find("#provider-context-window").value, "");
  await ui.edit("#provider-context-window", "1000000");
  await ui.edit("#provider-base-url", "https://different.test/v1");
  assert.equal(ui.find("#provider-context-window").value, "");
  await ui.edit("#provider-context-window", "262144");
  await ui.click('button[type="submit"]');
  assert.equal(ui.requests[0].body.contextWindow, 262144);
});

test("saved model budgets survive refreshed catalogs and can be cleared explicitly", async (t) => {
  const ui = await mount(t, true, {
    models: [
      {
        id: "builtin",
        name: "Custom",
        contextWindow: 512000,
        contextWindowSource: "configured",
      },
    ],
  });
  assert.equal(ui.find("#provider-context-window").value, "512000");
  assert.equal(ui.find("#provider-context-preset").value, "512000");
  await ui.flush();
  await ui.deliver(ui.requests[0], {
    models: [{ id: "builtin", name: "Custom", contextWindow: 256000 }],
    truncated: false,
  });
  assert.equal(ui.find("#provider-context-window").value, "512000");
  await ui.edit("#provider-context-window", "");
  await ui.click('button[type="submit"]');
  assert.equal(ui.requests[1].body.contextWindow, null);
});

test("context presets use decimal tokens, save only on submit, and retain custom input", async (t) => {
  const ui = await mount(t, true);
  const preset = ui.find("#provider-context-preset");
  assert.deepEqual(
    Array.from(preset.options, (option) => [option.text, option.value]),
    [
      ["自定义", "custom"],
      ["128K", "128000"],
      ["256K", "256000"],
      ["512K", "512000"],
      ["1M", "1000000"],
    ],
  );
  assert.equal(preset.value, "custom");
  for (const value of ["128000", "256000", "512000", "1000000"]) {
    await ui.select("#provider-context-preset", value);
    assert.equal(ui.find("#provider-context-window").value, value);
    assert.equal(preset.value, value);
    assert.equal(ui.requests.length, 0);
    await ui.click('button[type="submit"]');
    assert.equal(ui.requests.pop().body.contextWindow, Number(value));
  }
  await ui.select("#provider-context-preset", "custom");
  const input = ui.find("#provider-context-window");
  assert.equal(input.value, "");
  assert.equal(input.ownerDocument.activeElement, input);
  await ui.edit("#provider-context-window", "262144");
  assert.equal(preset.value, "custom");
  await ui.click('button[type="submit"]');
  assert.equal(ui.requests.pop().body.contextWindow, 262144);
  await ui.edit("#provider-context-window", "256000");
  assert.equal(preset.value, "256000");
});

test("context preset drafts reset with the model or URL and survive catalog refresh", async (t) => {
  const ui = await mount(t, true);
  await ui.select("#provider-context-preset", "1000000");
  await ui.flush();
  await ui.deliver(ui.requests[0], {
    models: [{ id: "builtin", name: "Built In", contextWindow: 256000 }],
    truncated: false,
  });
  assert.equal(ui.find("#provider-context-preset").value, "1000000");
  assert.equal(ui.find("#provider-context-window").value, "1000000");
  await ui.edit("#provider-model", "different");
  assert.equal(ui.find("#provider-context-preset").value, "custom");
  assert.equal(ui.find("#provider-context-window").value, "");
  await ui.select("#provider-context-preset", "512000");
  await ui.edit("#provider-base-url", "https://different.test/v1");
  assert.equal(ui.find("#provider-context-preset").value, "custom");
  assert.equal(ui.find("#provider-context-window").value, "");
});

test("older backends cannot silently ignore a context budget", async (t) => {
  const ui = await mount(t, true, { supportsContextWindow: undefined });
  await ui.edit("#provider-context-window", "1000000");
  await ui.click('button[type="submit"]');
  assert.equal(ui.requests.length, 0);
  assert.match(ui.find('[role="alert"]').textContent, /更新并重启/);
});
