import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  CUA_DRIVER_VERSION,
  cuaDriverEnvironment,
  resolveCuaDriverLayout,
} from "./cua-driver.ts";
import {
  ComputerUse,
  type ComputerDriver,
  type ComputerSession,
  type ComputerUseRun,
} from "./computer-use.ts";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const binary = resolveCuaDriverLayout().binaryPath;
const native = {
  get_window_state: {},
  verify_state: { expect: [{ window: { exists: true } }] },
  click: { x: 10, y: 20 },
  double_click: { x: 10, y: 20 },
  right_click: { x: 10, y: 20 },
  drag: { from_x: 10, from_y: 20, to_x: 30, to_y: 40 },
  type_text: { text: "sample" },
  press_key: { key: "a" },
  hotkey: { keys: ["cmd", "f"] },
  set_value: { value: "sample", element_token: "sample-token" },
  scroll: { direction: "down", amount: 1 },
  zoom: { x1: 0, y1: 0, x2: 100, y2: 100 },
  set_window_frame: { x: 0, y: 0, width: 800, height: 600 },
  bring_to_front: {},
};
const browser = {
  get_browser_state: { include_screenshot: true },
  browser_navigate: { url: "https://example.com/" },
  browser_click: { x: 10, y: 20 },
  browser_type: { ref: "p1:1", text: "sample" },
  browser_pointer: { action: "hover", x: 10, y: 20 },
  browser_dialog: { action: "inspect" },
};
const discovery = {
  list_apps: {},
  list_windows: { pid: 100 },
  launch_app: { name: "Calculator" },
  browser_prepare: {},
  check_permissions: {},
  health_report: {},
  get_screen_size: {},
  get_cursor_position: {},
};

// These are finite schema commands, not MCP/native actions. No daemon,
// screenshots, app launches or macOS permissions are involved in this test.
test(
  "Panel routes every exposed tool against the staged official 0.30.4 schema",
  {
    skip:
      !existsSync(binary) && "run npm run setup:cua to verify native schemas",
  },
  async () => {
    const version = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      env: cuaDriverEnvironment(),
    });
    assert.match(
      version,
      new RegExp(`\\b${CUA_DRIVER_VERSION.replaceAll(".", "\\.")}\\b`),
    );
    const names = [
      ...new Set([
        ...Object.keys(native),
        ...Object.keys(browser),
        ...Object.keys(discovery),
      ]),
    ];
    const schemas: Tool[] = names.map((name) => {
      const described = execFileSync(binary, ["describe", name], {
        encoding: "utf8",
        env: cuaDriverEnvironment(),
        maxBuffer: 2 * 1024 * 1024,
      });
      return {
        name,
        inputSchema: JSON.parse(described.split("input_schema:\n")[1]),
      };
    });
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const fake: ComputerDriver = {
      getStatus: () => ({
        installed: true,
        state: "ready",
        version: CUA_DRIVER_VERSION,
      }),
      close: async () => {},
      openSession: async (): Promise<ComputerSession> => ({
        id: randomUUID(),
        generation: 1,
        listTools: async () => schemas,
        close: async () => {},
        callTool: async (name, args) => {
          calls.push({ name, args });
          if (name === "get_browser_state" && args.window_id !== undefined)
            return {
              content: [],
              structuredContent: {
                status: "ok",
                mode: "bind",
                target_id: "bt-fixture",
                binding_quality: "exact",
                mutation_allowed: true,
                binding_route: "native_cdp_window",
                tabs: [
                  {
                    tab_id: "tab-fixture",
                    title: "fixture",
                    url: "https://example.com/",
                  },
                ],
              },
            };
          return { content: [{ type: "text", text: "schema-only fixture" }] };
        },
      }),
    };
    const host = new ComputerUse(fake);
    const windowTarget = { kind: "window", pid: 100, windowId: 200 };
    const pageTarget = {
      kind: "page",
      pid: 100,
      windowId: 200,
      tabId: "tab-fixture",
    };
    async function invoke(
      run: ComputerUseRun,
      name: string,
      args: Record<string, unknown>,
      target?: Record<string, unknown>,
    ) {
      const id = randomUUID();
      const parameters = {
        tool: name,
        arguments: args,
        ...(target ? { target } : {}),
      };
      const signal = new AbortController().signal;
      await run.prepare(
        { id, name: "computer_use_call", arguments: parameters },
        signal,
        () => {},
      );
      const call = run
        .tools()
        .find((tool) => tool.name === "computer_use_call")!;
      return call.execute(id, parameters, signal);
    }
    async function discover(run: ComputerUseRun, group: string) {
      const tool = run
        .tools()
        .find((tool) => tool.name === "computer_use_tools")!;
      const result = await tool.execute(randomUUID(), { group });
      const text = result.content.find((part) => part.type === "text");
      assert.ok(text?.type === "text");
      const output = JSON.parse(text.text) as {
        tools: Array<{
          name: string;
          callTool: string;
          inputSchema: Tool["inputSchema"];
          examples: Record<string, unknown>[];
        }>;
      };
      for (const entry of output.tools) {
        assert.equal(entry.callTool, "computer_use_call");
        assert.ok(
          entry.examples.length > 0,
          `${entry.name} must show a full Panel example`,
        );
        const validator = new AjvJsonSchemaValidator().getValidator(
          entry.inputSchema,
        );
        for (const example of entry.examples) {
          const validated = validator(example);
          assert.equal(
            validated.valid,
            true,
            `${entry.name} example: ${validated.errorMessage}`,
          );
        }
      }
    }
    try {
      for (const [name, args] of Object.entries(native)) {
        const run = host.newRun(true);
        try {
          await discover(run, "core");
          await discover(run, "window");
          await invoke(run, "get_window_state", {}, windowTarget);
          await invoke(run, name, args, windowTarget);
          assert.equal(calls.at(-1)?.args.pid, 100, name);
          assert.equal(calls.at(-1)?.args.window_id, 200, name);
        } finally {
          await run.close();
        }
      }
      const run = host.newRun(true);
      try {
        await discover(run, "core");
        await discover(run, "browser");
        await discover(run, "diagnostics");
        for (const [name, args] of Object.entries(discovery))
          await invoke(run, name, args);
        const prepare = calls.find((call) => call.name === "browser_prepare")!;
        assert.deepEqual(prepare.args.profile, { mode: "isolated_new" });
        assert.equal(prepare.args.strategy, undefined);
        await invoke(run, "get_browser_state", {}, windowTarget);
        for (const [name, args] of Object.entries(browser)) {
          await invoke(run, "get_browser_state", {}, pageTarget);
          await invoke(run, name, args, pageTarget);
          assert.equal(calls.at(-1)?.args.target_id, "bt-fixture", name);
          assert.equal(calls.at(-1)?.args.tab_id, "tab-fixture", name);
        }
      } finally {
        await run.close();
      }
    } finally {
      await host.close();
    }
  },
);
