import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { resolve } from "node:path";

const bundle = await build({
  stdin: {
    contents: `import { act, useState } from "react";
      import { createRoot } from "react-dom/client";
      import { SubagentsPanel } from "./src/Subagents";
      export { act };
      function Harness(props) {
        const [selectedId, onSelect] = useState();
        return <SubagentsPanel {...props} selectedId={selectedId} onSelect={onSelect} />;
      }
      export function mount(props) {
        const root = createRoot(document.getElementById("root"));
        root.render(<Harness {...props} />);
        return root;
      }
      export function update(root, props) {
        root.render(<Harness {...props} />);
      }`,
    resolveDir: resolve(import.meta.dirname, ".."),
    loader: "tsx",
  },
  bundle: true,
  jsx: "automatic",
  write: false,
  format: "iife",
  globalName: "ControlsTest",
  define: { "process.env.NODE_ENV": '"development"' },
  loader: { ".css": "empty" },
});
const child = (id, status = "running") => ({
  id,
  nativeRunId: `native-${id}`,
  childIndex: 2,
  agent: "worker",
  task: `task ${id}`,
  response:
    "## Research result\n\n| Scope | Result |\n|---|---|\n| Web | Verified |",
  status,
  model: "test/model",
  createdAt: 1,
});
async function mount(
  t,
  {
    onCommand,
    subagents = [child("child"), child("other", "completed")],
    notices = [],
  } = {},
) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const channels = [];
  window.MessageChannel = class extends MessageChannel {
    constructor() {
      super();
      channels.push(this);
    }
  };
  window.HTMLElement.prototype.scrollTo = function () {};
  const frames = new Map();
  let frameId = 0;
  window.requestAnimationFrame = (callback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  const motionListeners = new Set();
  const motion = {
    matches: false,
    addEventListener: (_, listener) => motionListeners.add(listener),
    removeEventListener: (_, listener) => motionListeners.delete(listener),
  };
  window.matchMedia = () => motion;
  window.IS_REACT_ACT_ENVIRONMENT = true;
  window.eval(bundle.outputFiles[0].text);
  const { act } = window.ControlsTest;
  const commands = [],
    answers = [];
  let root;
  t.after(async () => {
    await act(() => root?.unmount());
    for (const channel of channels) {
      channel.port1.close();
      channel.port2.close();
    }
    window.close();
  });
  const props = {
    node: {
      id: "parent",
      parentId: "root",
      prompt: "task",
      response: "",
      status: "completed",
      config: { model: "test/model", thinking: "off" },
      position: { x: 0, y: 0 },
      color: "sage",
      contextIds: [],
      createdAt: 1,
      subagents,
      subagentNotices: notices,
    },
    onDecision: async () => {},
    batchApprovalAvailable: false,
    onCommand: async (input) => {
      commands.push(input);
      return onCommand ? onCommand(input, commands.length) : { ok: true };
    },
    onAnswer: async (id, answer) => {
      answers.push({ id, answer });
    },
  };
  await act(async () => {
    root = window.ControlsTest.mount(props);
  });
  const document = window.document;
  const click = async (el) => {
    assert.ok(el);
    await act(() => el.click());
  };
  const select = async (i) =>
    click(document.querySelectorAll(".subagent-list-item")[i]);
  const button = (text) =>
    [...document.querySelectorAll("button")].find(
      (el) => el.textContent === text,
    );
  return {
    window,
    document,
    act,
    commands,
    answers,
    click,
    select,
    button,
    frames,
    frame(time) {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(time);
    },
    reduceMotion(matches) {
      motion.matches = matches;
      for (const listener of motionListeners) listener();
    },
    async updateSubagents(nextRuns) {
      props.node.subagents = nextRuns;
      await act(() => window.ControlsTest.update(root, props));
    },
  };
}

test("pending operations keep task controls and unanswered questions usable without exposing diagnostics", async (t) => {
  let finish;
  const waiting = new Promise((resolve) => {
    finish = resolve;
  });
  t.after(() => finish({ ok: true }));
  const ui = await mount(t, {
    onCommand: (_, count) => (count === 1 ? waiting : { ok: true }),
    notices: [
      {
        kind: "ui-request",
        value: {
          id: "pending-question",
          kind: "confirm",
          title: "继续执行？",
          value: "请确认",
        },
        createdAt: 1,
      },
      {
        kind: "ui-request",
        value: {
          id: "answered-question",
          kind: "confirm",
          title: "已处理的问题",
          value: "之前的请求",
        },
        createdAt: 1,
      },
      { kind: "ui-response", value: { id: "answered-question" }, createdAt: 2 },
      {
        kind: "subagent:async-started",
        value: { privateDiagnostic: "hidden-payload" },
        createdAt: 3,
      },
    ],
  });
  assert.doesNotMatch(
    ui.document.body.textContent,
    /hidden-payload|原生任务与管理|操作结果|后台通知|高级/,
  );
  await ui.click(ui.button("暂停"));
  await ui.select(1);
  await ui.select(0);
  await ui.click(ui.button("转入后台"));
  assert.deepEqual(JSON.parse(JSON.stringify(ui.commands[1])), {
    tool: "subagent_detach",
    id: "native-child",
    index: 2,
  });
  assert.equal(ui.document.querySelectorAll(".subagent-question").length, 1);
  await ui.click(ui.button("确认"));
  assert.deepEqual(ui.answers, [{ id: "pending-question", answer: true }]);
  await ui.act(async () => {
    finish({ ok: true });
    await waiting;
  });
});

test("agent results remain readable without a direct instruction composer", async (t) => {
  const ui = await mount(t);
  for (const index of [0, 1]) {
    await ui.select(index);
    assert.ok(ui.document.querySelector(".subagent-output h2"));
    assert.ok(ui.document.querySelector(".subagent-output table"));
    assert.equal(ui.document.querySelector("textarea"), null);
    assert.equal(
      ui.document.querySelector('[aria-label="子代理消息方式"]'),
      null,
    );
    assert.equal(
      ui.document.querySelector('[aria-label="发送给此代理"]'),
      null,
    );
  }
  assert.equal(ui.commands.length, 0);
});

test("concurrent agent conversations have distinct stable loaders and terminal agents stop animating", async (t) => {
  const runs = Array.from({ length: 8 }, (_, i) => child(`loading-${i}`));
  const ui = await mount(t, { subagents: runs });
  const choices = [];
  for (let i = 0; i < runs.length; i++) {
    await ui.select(i);
    const loader = ui.document.querySelector(
      ".subagent-live-status .math-curve-loader",
    );
    assert.ok(loader);
    assert.ok(ui.document.querySelector(".generation-character"));
    assert.match(
      ui.document.querySelector(".generation-announcement").textContent,
      /正在处理任务/,
    );
    choices.push(loader.dataset.curve);
    assert.equal(ui.frames.size, 1);
  }
  assert.equal(new Set(choices).size, 8);
  await ui.select(0);
  const loader = ui.document.querySelector(".math-curve-loader");
  assert.equal(loader.dataset.curve, choices[0]);
  const head = loader.querySelector("circle");
  const initial = head.getAttribute("cx");
  ui.frame(1000);
  assert.notEqual(head.getAttribute("cx"), initial);
  await ui.updateSubagents(
    runs.map((run, i) =>
      i === 0 ? { ...run, response: "streamed update" } : run,
    ),
  );
  assert.equal(ui.document.querySelector(".math-curve-loader"), loader);
  assert.equal(loader.dataset.curve, choices[0]);
  ui.reduceMotion(true);
  assert.equal(ui.frames.size, 0);
  assert.ok(loader.querySelector("path").getAttribute("d"));
  ui.reduceMotion(false);
  assert.equal(ui.frames.size, 1);
  await ui.updateSubagents(
    runs.map((run, i) => (i === 0 ? { ...run, status: "completed" } : run)),
  );
  assert.equal(ui.document.querySelector(".subagent-live-status"), null);
  assert.equal(ui.frames.size, 0);
});

test("queued agents show the curve loader and retain it when execution begins", async (t) => {
  const queued = child("queued-loading", "queued");
  const ui = await mount(t, { subagents: [queued] });
  const loader = ui.document.querySelector(".math-curve-loader");
  assert.ok(loader);
  assert.match(
    ui.document.querySelector(".generation-announcement").textContent,
    /已进入队列/,
  );
  const choice = loader.dataset.curve;
  await ui.updateSubagents([{ ...queued, status: "running" }]);
  assert.equal(
    ui.document.querySelector(".math-curve-loader").dataset.curve,
    choice,
  );
  assert.match(
    ui.document.querySelector(".generation-announcement").textContent,
    /正在处理任务/,
  );
});
