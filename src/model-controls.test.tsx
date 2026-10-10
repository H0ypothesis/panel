import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { type TestContext } from "node:test";
import { act, StrictMode, useState } from "react";
import type { ModelOption, RunConfig } from "../shared/types";
import { ComposerModelControls } from "./WorkspaceControls";
import { thinkingDescription } from "../shared/thinking-controls";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const glm: ModelOption = {
  id: "paperbypass/z-ai/glm-5.3-flash",
  name: "GLM 5.3 Flash",
  provider: "paperbypass",
  providerName: "Paperbypass",
  available: true,
  demo: false,
  thinkingLevels: ["low", "high", "max"],
  contextWindow: 128000,
};
const historic: RunConfig = { model: glm.id, thinking: "off", longTask: true };

async function fixture(t: TestContext) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const { window } = dom;
  const globals = {
    window,
    document: window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
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
  // Load React DOM after the browser globals so it detects native input events.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(window.document.getElementById("root")!);
  let current = historic;
  const changes: RunConfig[] = [];
  function Harness({
    models,
    disabled,
  }: {
    models: ModelOption[];
    disabled: boolean;
  }) {
    const [config, setConfig] = useState(historic);
    current = config;
    return (
      <ComposerModelControls
        models={models}
        config={config}
        disabled={disabled}
        onConfigChange={(next) => {
          changes.push(next);
          setConfig(next);
        }}
      />
    );
  }
  t.after(async () => {
    await act(() => root.unmount());
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const select = (label: string): HTMLSelectElement =>
    window.document.querySelector(`select[aria-label="${label}"]`)!;
  const button = (label: string): HTMLButtonElement =>
    window.document.querySelector(`button[aria-label="${label}"]`)!;
  const open = async (label: string) => {
    if (button(label).getAttribute("aria-expanded") !== "true")
      await act(() => button(label).click());
  };
  return {
    document: window.document as Document,
    window,
    changes,
    get config() {
      return current;
    },
    select,
    button,
    open,
    value: (label: string) => button(label).textContent?.trim(),
    levels: async (label: string) => {
      await open(label);
      return Array.from(
        window.document.querySelectorAll(".intensity-levels > button"),
        (option: Element) => option.textContent,
      );
    },
    click: async (label: string) =>
      act(() =>
        (
          window.document.querySelector(
            `button[aria-label="${label}"]`,
          ) as HTMLButtonElement
        ).click(),
      ),
    render: async (models: ModelOption[], disabled = false) =>
      act(() =>
        root.render(
          <StrictMode>
            <Harness models={models} disabled={disabled} />
          </StrictMode>,
        ),
      ),
    change: async (label: string, value: string) => {
      if (label !== "选择模型") {
        await open(label);
        await act(() =>
          button(`选择 ${value === "default" ? "默认" : value} 强度`).click(),
        );
        return;
      }
      await act(() => {
        const element = select(label);
        element.value = value;
        element.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
    },
  };
}

test("GLM capability refresh repairs a legacy off draft and preserves the chosen effort across refreshes", async (t) => {
  const ui = await fixture(t);
  await ui.render([{ ...glm, thinkingLevels: ["off"] }]);
  assert.equal(ui.value("思考强度"), "off");
  assert.equal(ui.changes.length, 0);
  await ui.render([glm]);
  assert.deepEqual(await ui.levels("思考强度"), ["low", "high", "max"]);
  assert.equal(ui.value("思考强度"), "low");
  assert.deepEqual(ui.config, { ...historic, thinking: "low" });
  for (const thinking of ["high", "max", "low"] as const) {
    await ui.change("思考强度", thinking);
    assert.deepEqual(ui.config, { ...historic, thinking });
    const count: number = ui.changes.length;
    await ui.render([{ ...glm, thinkingLevels: [...glm.thinkingLevels] }]);
    assert.equal(ui.value("思考强度"), thinking);
    assert.equal(
      ui.changes.length,
      count,
      "Catalog refresh must not reset an explicit choice",
    );
  }
  assert.equal(
    historic.thinking,
    "off",
    "Historical run config is not mutated",
  );
});

test("independent thinking toggle preserves effort, required models lock on, and unknown models show default", async (t) => {
  const ui = await fixture(t);
  const optional: ModelOption = {
    ...glm,
    thinkingLevels: ["off", "low", "high"],
    thinkingControls: { toggle: "supported", efforts: ["low", "high"] },
  };
  await ui.render([optional]);
  assert.equal(ui.button("思考开关").getAttribute("aria-checked"), "false");
  assert.equal(ui.button("effort 强度").disabled, false);
  await ui.click("思考开关");
  await ui.change("effort 强度", "high");
  assert.equal(ui.config.effort, "high");
  await ui.click("思考开关");
  assert.equal(ui.config.thinkingMode, "disabled");
  assert.equal(ui.config.effort, "high");
  assert.equal(thinkingDescription(ui.config), "思考关闭 · high");
  await ui.change("effort 强度", "low");
  assert.equal(ui.config.thinkingMode, "disabled");
  assert.equal(ui.config.thinking, "off");
  assert.equal(ui.config.effort, "low");
  await ui.click("思考开关");
  assert.equal(ui.value("effort 强度"), "low");
  await ui.click("恢复默认思考开关");
  assert.equal(ui.config.thinkingMode, "default");
  await ui.render([
    {
      ...glm,
      thinkingControls: { toggle: "required", efforts: ["low", "high", "max"] },
    },
  ]);
  assert.equal(ui.button("思考开关").disabled, true);
  assert.equal(ui.button("思考开关").getAttribute("aria-checked"), "true");
  await ui.render([
    {
      ...glm,
      thinkingLevels: ["off"],
      thinkingControls: { toggle: "unknown", efforts: [] },
    },
  ]);
  assert.match(ui.button("思考开关").textContent ?? "", /服务默认/);
  assert.equal(ui.config.effort, "default");
  assert.equal(ui.button("effort 强度"), null);
});

test("coupled protocols keep both controls editable and show the conflict without overwriting choices", async (t) => {
  const ui = await fixture(t);
  await ui.render([
    {
      ...glm,
      thinkingLevels: ["off", "low", "high"],
      thinkingControls: {
        toggle: "supported",
        efforts: ["low", "high"],
        effortRequiresThinking: true,
      },
    },
  ]);
  await ui.change("effort 强度", "high");
  assert.equal(ui.config.thinkingMode, "disabled");
  assert.equal(ui.config.effort, "high");
  assert.equal(ui.button("effort 强度").disabled, false);
  assert.equal(ui.button("effort 强度").getAttribute("aria-invalid"), "true");
  assert.match(
    ui.button("effort 强度").getAttribute("aria-description")!,
    /无法同时/,
  );
  await ui.click("思考开关");
  assert.equal(ui.config.effort, "high");
  assert.equal(ui.button("effort 强度").getAttribute("aria-invalid"), "false");
  await ui.click("思考开关");
  await ui.change("effort 强度", "default");
  assert.equal(ui.config.thinkingMode, "disabled");
  assert.equal(ui.button("effort 强度").getAttribute("aria-invalid"), "false");
});

test("model changes keep duration preferences and legacy normalization waits for editable controls", async (t) => {
  const ui = await fixture(t);
  await ui.render([]);
  assert.equal(ui.changes.length, 0);
  await ui.render([glm], true);
  assert.equal(ui.changes.length, 0);
  assert.equal(ui.button("思考强度").disabled, true);
  await ui.render([glm]);
  assert.equal(ui.config.thinking, "low");
  const other = {
    ...glm,
    id: "test/other",
    thinkingLevels: ["medium"] as const,
  };
  await ui.render([
    glm,
    { ...other, thinkingLevels: [...other.thinkingLevels] },
  ]);
  await ui.change("选择模型", other.id);
  assert.deepEqual(ui.config, {
    ...historic,
    model: other.id,
    thinking: "medium",
  });
  await ui.change("选择模型", glm.id);
  assert.deepEqual(ui.config, { ...historic, thinking: "low" });
});

test("switching between three-level and five-level models updates raw effort options", async (t) => {
  const ui = await fixture(t);
  const opus = {
    ...glm,
    id: "paperbypass/anthropic/claude-opus-5.5",
    thinkingLevels: [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ] as typeof glm.thinkingLevels,
  };
  await ui.render([glm, opus]);
  await ui.change("选择模型", opus.id);
  assert.deepEqual(await ui.levels("思考强度"), opus.thinkingLevels);
  await ui.change("思考强度", "xhigh");
  assert.equal(ui.config.thinking, "xhigh");
  await ui.change("选择模型", glm.id);
  assert.equal(ui.config.thinking, "low");
  assert.deepEqual(await ui.levels("思考强度"), glm.thinkingLevels);
});

test("intensity cards focus the slider, close on Escape or outside interaction, and remain open while choosing", async (t) => {
  const ui = await fixture(t);
  await ui.render([glm]);
  await ui.open("思考强度");
  const slider = ui.document.querySelector<HTMLInputElement>(
    'input[type="range"]',
  )!;
  assert.equal(ui.document.activeElement, slider);
  assert.equal(slider.max, "2");
  await act(() => {
    Object.getOwnPropertyDescriptor(
      ui.window.HTMLInputElement.prototype,
      "value",
    )!.set!.call(slider, "2");
    slider.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
  });
  assert.equal(ui.button("思考强度").getAttribute("aria-expanded"), "true");
  assert.equal(slider.getAttribute("aria-valuetext"), "max");
  assert.equal(slider.value, "2");
  assert.deepEqual(ui.config, { ...historic, thinking: "max" });
  await act(() =>
    slider.dispatchEvent(
      new ui.window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  assert.equal(ui.document.querySelector('[role="dialog"]'), null);
  assert.equal(ui.document.activeElement, ui.button("思考强度"));
  await ui.open("思考强度");
  await act(() =>
    ui.document.body.dispatchEvent(
      new ui.window.Event("pointerdown", { bubbles: true }),
    ),
  );
  assert.equal(ui.document.querySelector('[role="dialog"]'), null);
  assert.equal(ui.config.thinking, "max");
  await ui.open("思考强度");
  await ui.render([glm], true);
  assert.equal(ui.document.querySelector('[role="dialog"]'), null);
  assert.equal(ui.button("思考强度").disabled, true);
});

test("single-level models explain their fixed intensity, and native dialogs contain the intensity portal", async (t) => {
  const ui = await fixture(t);
  const modal = ui.document.createElement("dialog");
  modal.setAttribute("open", "");
  ui.document.body.append(modal);
  modal.append(ui.document.getElementById("root")!);
  await ui.render([{ ...glm, thinkingLevels: ["off"] }]);
  await ui.open("思考强度");
  const card = modal.querySelector('[role="dialog"]');
  assert.ok(card);
  assert.equal(ui.document.activeElement, card);
  assert.equal(
    card.querySelector<HTMLInputElement>('input[type="range"]')!.disabled,
    true,
  );
  assert.match(card.textContent ?? "", /此模型仅支持 off/);
  assert.equal(ui.changes.length, 0);
  await ui.click("关闭思考强度卡片");
  assert.equal(modal.querySelector('[role="dialog"]'), null);
  assert.equal(ui.document.activeElement, ui.button("思考强度"));
});

test("dragging previews continuous positions, commits the nearest level on outside release, and keeps discrete keyboard controls", async (t) => {
  const ui = await fixture(t);
  await ui.render([glm]);
  await ui.open("思考强度");
  const slider = ui.document.querySelector<HTMLInputElement>(
    'input[type="range"]',
  )!;
  const input = async (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(
        ui.window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(slider, value);
      slider.dispatchEvent(new ui.window.Event("input", { bubbles: true }));
    });
  const pointerDown = async () =>
    act(() =>
      slider.dispatchEvent(
        new ui.window.MouseEvent("pointerdown", { button: 0, bubbles: true }),
      ),
    );
  const key = async (key: string) =>
    act(() =>
      slider.dispatchEvent(
        new ui.window.KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
  const changes = ui.changes.length;
  await pointerDown();
  await input("1.27");
  assert.equal(slider.value, "1.27");
  assert.equal(slider.getAttribute("aria-valuetext"), "high");
  assert.equal(ui.config.thinking, "low");
  assert.equal(ui.changes.length, changes);
  await ui.render([glm]);
  assert.equal(slider.value, "1.27");
  await act(() =>
    ui.document.body.dispatchEvent(
      new ui.window.Event("pointerup", { bubbles: true }),
    ),
  );
  assert.equal(ui.config.thinking, "high");
  assert.equal(ui.changes.length, changes + 1);
  assert.equal(slider.value, "1");
  await key("ArrowRight");
  assert.equal(ui.config.thinking, "max");
  assert.ok(ui.document.querySelector(".intensity-pixels"));
  assert.doesNotMatch(
    ui.document.querySelector('[role="dialog"]')!.textContent!,
    /Galaxy/,
  );
  await pointerDown();
  await input("0.35");
  await act(() =>
    ui.window.dispatchEvent(new ui.window.Event("pointercancel")),
  );
  assert.equal(ui.config.thinking, "max");
  assert.equal(slider.value, "2");
  await key("Home");
  assert.equal(ui.config.thinking, "low");
  assert.equal(ui.document.querySelector(".intensity-pixels"), null);
  await key("End");
  assert.equal(ui.config.thinking, "max");
});
