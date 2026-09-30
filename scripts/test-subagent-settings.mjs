import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `import { act, StrictMode } from "react";
      import { createRoot } from "react-dom/client";
      import { SubagentSettings } from "./src/SubagentSettings";
      export { act };
      export function mount() {
        const root = createRoot(document.getElementById("root"));
        root.render(<StrictMode><SubagentSettings /></StrictMode>);
        return root;
      }`,
    resolveDir: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    loader: "tsx",
  },
  bundle: true,
  jsx: "automatic",
  write: false,
  format: "iife",
  globalName: "SettingsTest",
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".css": "empty" },
});

async function mount(t, failLoad = false, nativeOptions) {
  const diagnostics = [];
  const virtualConsole = new VirtualConsole();
  for (const event of ["error", "warn", "jsdomError"])
    virtualConsole.on(event, (...args) => diagnostics.push(args.join(" ")));
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    runScripts: "outside-only",
    pretendToBeVisual: true,
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
  let stored = {
    maxConcurrentSubagents: 6,
    ...(nativeOptions ? { nativeOptions } : {}),
  };
  let failSave = false;
  const writes = [];
  window.fetch = async (url, options) => {
    if (url === "/api/subagent-profiles")
      return {
        ok: true,
        json: async () => ({
          profiles: [
            {
              name: "my-reviewer",
              source: "project",
              filePath: "/test/.pi/agents/my-reviewer.md",
              description: "Project review role",
              tools: ["read", "grep"],
              diagnostics: [],
              systemPromptMode: "replace",
            },
          ],
          diagnostics: [],
        }),
      };
    assert.equal(url, "/api/subagent-settings");
    if (options?.method === "PUT") {
      writes.push(JSON.parse(options.body));
      if (failSave)
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: "保存失败，请重试" }),
        };
      stored = writes.at(-1);
    } else if (failLoad)
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: "读取失败" }),
      };
    return { ok: true, json: async () => structuredClone(stored) };
  };
  window.eval(bundle.outputFiles[0].text);
  const { act } = window.SettingsTest;
  let root;
  await act(async () => {
    root = window.SettingsTest.mount();
  });
  t.after(async () => {
    await act(async () => root.unmount());
    channels.forEach((channel) => {
      channel.port1.close();
      channel.port2.close();
    });
    window.close();
    assert.deepEqual(diagnostics, []);
  });
  const input = window.document.querySelector("input");
  const button = (label) =>
    [...window.document.querySelectorAll("button")].find(
      (button) => button.textContent === label,
    );
  const change = async (value, element = input) =>
    act(async () => {
      const select = element.tagName === "SELECT";
      Object.getOwnPropertyDescriptor(
        select
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype,
        "value",
      ).set.call(element, value);
      element.dispatchEvent(
        new window.Event(select ? "change" : "input", { bubbles: true }),
      );
    });
  return {
    window,
    input,
    button,
    writes,
    setFailSave: (value) => {
      failSave = value;
    },
    setFailLoad: (value) => {
      failLoad = value;
    },
    click: async (label) => act(async () => button(label).click()),
    change,
  };
}

test("settings load, validate, save and restore the default through the API", async (t) => {
  const ui = await mount(t);
  assert.equal(ui.input.value, "6");
  assert.match(ui.window.document.body.textContent, /my-reviewer/);
  assert.match(ui.window.document.body.textContent, /Project review role/);
  assert.equal(ui.button("保存").disabled, true);
  await ui.change("0");
  assert.equal(ui.button("保存").disabled, true);
  await ui.change("1.5");
  assert.equal(ui.button("保存").disabled, true);
  await ui.change("2");
  await ui.click("保存");
  assert.deepEqual(ui.writes, [{ maxConcurrentSubagents: 2 }]);
  assert.match(ui.window.document.body.textContent, /已保存/);
  await ui.click("恢复默认");
  assert.equal(ui.input.value, "4");
  await ui.click("保存");
  assert.deepEqual(ui.writes.at(-1), { maxConcurrentSubagents: 4 });
});

test("save failures preserve the draft and permit retry without claiming success", async (t) => {
  const ui = await mount(t);
  ui.setFailSave(true);
  await ui.change("8");
  await ui.click("保存");
  assert.equal(ui.input.value, "8");
  assert.match(
    ui.window.document.querySelector('[role="alert"]').textContent,
    /保存失败/,
  );
  assert.doesNotMatch(ui.window.document.body.textContent, /已保存/);
  assert.equal(ui.button("保存").disabled, false);
  ui.setFailSave(false);
  await ui.click("保存");
  assert.match(ui.window.document.body.textContent, /已保存/);
});

test("failed loading never exposes a fabricated default and can be retried", async (t) => {
  const ui = await mount(t, true);
  assert.equal(ui.input.disabled, true);
  assert.equal(ui.button("保存").disabled, true);
  ui.setFailLoad(false);
  await ui.click("重新读取");
  assert.equal(ui.input.value, "6");
  assert.equal(ui.input.disabled, false);
});

test("hidden advanced settings remain intact when saving, retrying and restoring concurrency", async (t) => {
  const nativeOptions = {
    asyncByDefault: false,
    maxSubagentDepth: 0,
    maxSubagentSpawnsPerRun: 64,
    maxSubagentSpawnsPerSession: 0,
    maxActiveAsyncRunsPerSession: 4,
    timeoutMs: 1800001,
    toolTimeoutMs: 60000,
    usageBudget: {
      tokens: { soft: 1000, hard: 2000 },
      costUsd: { soft: 0.1, hard: 0.5 },
    },
  };
  const ui = await mount(t, false, nativeOptions);
  assert.equal(ui.window.document.querySelectorAll("form input").length, 1);
  assert.equal(
    ui.window.document.querySelector(
      "form select, form textarea, form details",
    ),
    null,
  );
  assert.doesNotMatch(
    ui.window.document.body.textContent,
    /原生后台与预算设置|高级设置/,
  );
  await ui.change("5");
  ui.setFailSave(true);
  await ui.click("保存");
  assert.equal(ui.input.value, "5");
  assert.equal(ui.button("保存").disabled, false);
  ui.setFailSave(false);
  await ui.click("保存");
  assert.deepEqual(ui.writes.at(-1), {
    maxConcurrentSubagents: 5,
    nativeOptions,
  });
  const writesBeforeReset = ui.writes.length;
  await ui.click("恢复默认");
  assert.equal(ui.input.value, "4");
  assert.equal(ui.writes.length, writesBeforeReset);
  await ui.click("保存");
  assert.deepEqual(ui.writes.at(-1), {
    maxConcurrentSubagents: 4,
    nativeOptions,
  });
  assert.equal(ui.button("保存").disabled, true);
  assert.equal(ui.button("恢复默认").disabled, true);
});
