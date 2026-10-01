import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { GenerationIndicator } from "./GenerationIndicator";
import { spinnerVerbGroups, type SpinnerVerbGroup } from "./spinner-verbs";

const { JSDOM } = createRequire(import.meta.url)("jsdom");

test("loading phrases follow activity boundaries and safely switch between different pool sizes", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const { window } = dom;
  window.matchMedia = () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  });
  const globals = {
    window,
    document: window.document,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const root = createRoot(window.document.getElementById("root")!);
  t.mock.method(Math, "random", () => 0.999);
  t.after(async () => {
    try {
      await act(() => root.unmount());
    } finally {
      window.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  const props: ComponentProps<typeof GenerationIndicator> = {
    hasResponse: false,
    active: false,
    activityKey: "initial-answer",
  };
  const render = async (changes: Partial<typeof props> = {}) => {
    Object.assign(props, changes);
    await act(() => root.render(<GenerationIndicator {...props} />));
    return window.document.querySelector(".generation-phrase")!
      .textContent as string;
  };
  const first = await render();
  assert.equal(first, spinnerVerbGroups.thinking.at(-1));
  const initialCurve = window.document.querySelector(".lissajous-drift");
  assert.equal(await render({ hasResponse: true }), first);

  for (const phraseGroup of [
    "computer-use",
    "delegation",
    "subagent",
    "thinking",
  ] as SpinnerVerbGroup[]) {
    const word = await render({
      phraseGroup,
      activityKey: `activity-${phraseGroup}`,
    });
    assert.ok(spinnerVerbGroups[phraseGroup].includes(word));
    assert.equal(
      window.document
        .querySelector(".generation-indicator")!
        .getAttribute("data-phrase-group"),
      phraseGroup,
    );
    assert.equal(
      window.document.querySelector(".lissajous-drift"),
      initialCurve,
    );
    assert.equal(await render({ message: "工具操作等待你的批准…" }), word);
    assert.equal(
      window.document.querySelector('[role="status"]')!.textContent,
      "工具操作等待你的批准…",
    );
    assert.notEqual(await render({ activityKey: `next-${phraseGroup}` }), word);
  }

  const childWord = await render({
    phraseGroup: "subagent",
    activityKey: "same-key",
    message: undefined,
  });
  assert.equal(
    window.document.querySelector('[role="status"]')!.textContent,
    "子代理正在处理任务…",
  );
  const cuaWord = await render({ phraseGroup: "computer-use" });
  assert.notEqual(cuaWord, childWord);
  assert.ok(spinnerVerbGroups["computer-use"].includes(cuaWord));
  assert.equal(
    window.document.querySelector('[role="status"]')!.textContent,
    "正在操作电脑…",
  );
});
