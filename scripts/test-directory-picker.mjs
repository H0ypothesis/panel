import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";

const bundle = await build({
  stdin: {
    contents: `
      import { act, useState } from "react";
      import { createRoot } from "react-dom/client";
      import { DirectoryField } from "./src/CodingControls";
      export { act };
      function Form({ onChange }) {
        const [directory, setDirectory] = useState("/original");
        return <><output>{directory.trim()}</output><DirectoryField
          value={directory} onChange={value => { onChange(value); setDirectory(value); }}
        /></>;
      }
      export function mount(onChange) {
        const root = createRoot(document.getElementById("root"));
        root.render(<Form onChange={onChange} />);
        return root;
      }
    `,
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
    loader: "tsx",
  },
  bundle: true,
  jsx: "automatic",
  write: false,
  format: "iife",
  globalName: "DirectoryTest",
  define: { "process.env.NODE_ENV": '"development"' },
});

for (const cancelled of [undefined, null, "", "   "]) {
  test(`native cancellation (${JSON.stringify(cancelled)}) preserves the form and allows retry`, async (t) => {
    const diagnostics = [];
    const virtualConsole = new VirtualConsole();
    for (const event of ["error", "warn", "jsdomError"])
      virtualConsole.on(event, (...args) => diagnostics.push(args.join(" ")));
    const dom = new JSDOM('<div id="root"></div>', {
      url: "http://localhost",
      runScripts: "outside-only",
      virtualConsole,
    });
    const { window } = dom;
    window.IS_REACT_ACT_ENVIRONMENT = true;
    const channels = [];
    window.MessageChannel = class extends MessageChannel {
      constructor() { super(); channels.push(this); }
    };
    let finish;
    window.panelDesktop = {
      platform: "macos",
      chooseDirectory: () => new Promise(resolve => { finish = resolve; }),
    };
    window.eval(bundle.outputFiles[0].text);
    const { act, mount } = window.DirectoryTest;
    const changes = [];
    let app;
    t.after(async () => {
      try {
        await act(() => app?.unmount());
        assert.deepEqual(diagnostics, []);
      } finally {
        window.close();
        for (const channel of channels) {
          channel.port1.close();
          channel.port2.close();
        }
      }
    });
    await act(() => { app = mount(value => changes.push(value)); });
    const button = window.document.querySelector(".desktop-actions button");
    await act(() => button.click());
    assert.equal(button.disabled, true);
    await act(async () => { finish(cancelled); });
    assert.deepEqual(changes, []);
    assert.equal(window.document.querySelector("output").textContent, "/original");
    assert.equal(window.document.querySelector("input").value, "/original");
    assert.equal(button.disabled, false);
    assert.equal(window.document.querySelector('[role="alert"]'), null);
    await act(() => button.click());
    await act(async () => { finish("/selected"); });
    assert.deepEqual(changes, ["/selected"]);
    assert.equal(window.document.querySelector("output").textContent, "/selected");
    assert.equal(button.disabled, false);
  });
}
