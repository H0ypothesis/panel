import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCall } from "../shared/types.ts";
import { isCuaTakeoverOperation } from "./cua-takeover.ts";

const window = { kind: "window", pid: 100, windowId: 200 };
const page = { ...window, kind: "page", tabId: "page-1" };
function call(tool: string, args?: unknown, target?: unknown) {
  return {
    name: "computer_use_call",
    arguments: {
      tool,
      ...(args !== undefined ? { arguments: args } : {}),
      ...(target !== undefined ? { target } : {}),
    },
  };
}

test("takeover accepts only exact metadata wrapper shapes", () => {
  for (const group of [undefined, "core", "browser", "window", "diagnostics"])
    assert.equal(
      isCuaTakeoverOperation({
        name: "computer_use_tools",
        arguments: group ? { group } : {},
      }),
      true,
    );
  assert.equal(
    isCuaTakeoverOperation({ name: "computer_use_release", arguments: {} }),
    true,
  );
  for (const args of [
    { group: "unknown" },
    { group: "core", arguments: {} },
    { group: null },
  ])
    assert.equal(
      isCuaTakeoverOperation({ name: "computer_use_tools", arguments: args }),
      false,
    );
  assert.equal(
    isCuaTakeoverOperation({
      name: "computer_use_release",
      arguments: { target: window },
    }),
    false,
  );
});

test("takeover accepts pinned discovery and read-only diagnostic arguments", () => {
  const positive: Array<[string, Record<string, unknown>?]> = [
    ["list_apps"],
    ["list_windows"],
    ["list_windows", { pid: 100, on_screen_only: true }],
    ["check_permissions"],
    ["check_permissions", { probe_direct_capture: false }],
    ["health_report"],
    [
      "health_report",
      { include: ["screen_capture_capability"], skip: ["binary_version"] },
    ],
    ["get_screen_size"],
    ["get_cursor_position"],
  ];
  for (const [tool, args] of positive)
    assert.equal(isCuaTakeoverOperation(call(tool, args)), true, tool);
  for (const [tool, args] of [
    ["check_permissions", { prompt: true }],
    ["check_permissions", { prompt: false }],
    ["health_report", { include: ["future_action"] }],
    ["list_windows", { pid: "100" }],
  ] as const)
    assert.equal(isCuaTakeoverOperation(call(tool, args)), false, tool);
});

test("takeover accepts window observations and cropped screenshot zoom", () => {
  for (const args of [
    undefined,
    {},
    { query: "click delete", max_elements: 100 },
    {
      capture_mode: "vision",
      include_accessibility_tree: false,
      include_screenshot: true,
      max_depth: 4,
      max_dimension: 1000,
      max_image_dimension: 0,
      timeout_ms: 5000,
    },
  ])
    assert.equal(
      isCuaTakeoverOperation(call("get_window_state", args, window)),
      true,
    );
  assert.equal(
    isCuaTakeoverOperation(
      call("zoom", { x1: 0, y1: 0, x2: 100, y2: 100 }, window),
    ),
    true,
  );
  assert.equal(
    isCuaTakeoverOperation(
      call(
        "verify_state",
        {
          expect: [
            {
              window: {
                exists: true,
                bounds: {
                  x: 0,
                  y: 0,
                  width: 100,
                  height: 100,
                  tolerance_px: 3,
                },
              },
            },
            {
              element: {
                selector: { role: "AXButton", label_contains: "Save" },
                exists: true,
                enabled: true,
                selected: null,
                value_equals: null,
              },
            },
          ],
          stable_samples: 2,
          timeout_ms: 5000,
          include_screenshot: true,
        },
        window,
      ),
    ),
    true,
  );
});

test("takeover accepts read-only browser binding and page snapshots", () => {
  for (const args of [undefined, {}, { refresh_binding: true }])
    assert.equal(
      isCuaTakeoverOperation(call("get_browser_state", args, window)),
      true,
    );
  for (const args of [
    undefined,
    {},
    { include_screenshot: true },
    {
      continuation: "opaque",
      scope_ref: "ref",
      query: "search",
      snapshot_format: "semantic_v2",
    },
    { snapshot_format: "dom_refs_v1" },
  ])
    assert.equal(
      isCuaTakeoverOperation(call("get_browser_state", args, page)),
      true,
    );
  assert.equal(
    isCuaTakeoverOperation(
      call("get_browser_state", { snapshot_format: "future" }, page),
    ),
    false,
  );
  assert.equal(
    isCuaTakeoverOperation(
      call("get_browser_state", { include_screenshot: true }, window),
    ),
    false,
  );
  assert.equal(
    isCuaTakeoverOperation(
      call("get_browser_state", { refresh_binding: true }, page),
    ),
    false,
  );
});

test("takeover permits background native scrolling with valid target coordinates", () => {
  for (const args of [
    { direction: "down" },
    { direction: "up", by: "page", amount: 3 },
    { direction: "left", x: 20, y: 30, delivery_mode: "background" },
    { direction: "right", element_token: "token" },
    { direction: "down", element_index: 0, snapshot_id: "s1234abcd" },
  ])
    assert.equal(isCuaTakeoverOperation(call("scroll", args, window)), true);
  for (const args of [
    { direction: "down", delivery_mode: "foreground" },
    { direction: "next" },
    { direction: "down", x: 1 },
    { direction: "down", element_index: 1 },
    { direction: "down", amount: -1 },
    { direction: "down", by: "document" },
  ])
    assert.equal(isCuaTakeoverOperation(call("scroll", args, window)), false);
});

test("browser_pointer permits only hover and scroll with their exact action fields", () => {
  for (const args of [
    { action: "hover", ref: "p1:1" },
    { action: "hover", x: 10, y: 20 },
    { action: "hover", ref: "p1:1", input_route: "dom_event" },
    { action: "scroll", ref: "p1:1", delta_y: 200, input_route: "trusted" },
    { action: "scroll", x: 1, y: 2, delta_x: -100, delta_y: 0 },
  ])
    assert.equal(
      isCuaTakeoverOperation(call("browser_pointer", args, page)),
      true,
    );
  for (const args of [
    { action: "right_click", ref: "p1:1" },
    { action: "double_click", ref: "p1:1" },
    { action: "drag", ref: "p1:1", destination_ref: "p1:2" },
    { action: "move", x: 1, y: 2 },
    { action: "hover", ref: "p1:1", destination_ref: "p1:2" },
    { action: "hover", ref: "p1:1", delta_y: 100 },
    { action: "hover", x: 1, y: 2, to_x: 10, to_y: 10 },
    { action: "hover", ref: "p1:1", button: "left" },
    { action: "hover", x: 1 },
    { action: "hover", ref: "p1:1", x: 1, y: 2 },
    { action: "hover", x: 1, y: 2, input_route: "dom_event" },
    { action: "scroll", ref: "p1:1" },
    { action: "scroll", ref: "p1:1", delta_y: "100" },
    { action: "hover", ref: "p1:1", input_route: "new_route" },
    { ref: "p1:1" },
  ])
    assert.equal(
      isCuaTakeoverOperation(call("browser_pointer", args, page)),
      false,
      JSON.stringify(args),
    );
});

test("clicks, input, navigation, launching and window changes always retain review", () => {
  for (const tool of [
    "click",
    "double_click",
    "right_click",
    "drag",
    "type_text",
    "press_key",
    "hotkey",
    "set_value",
    "browser_click",
    "browser_type",
    "browser_navigate",
    "browser_dialog",
    "browser_prepare",
    "launch_app",
    "bring_to_front",
    "set_window_frame",
    "move_mouse",
    "get_desktop_state",
    "screenshot",
  ])
    for (const target of [undefined, window, page])
      assert.equal(
        isCuaTakeoverOperation(
          call(tool, { action: "inspect", risk: "low" }, target),
        ),
        false,
        tool,
      );
  for (const name of [
    "bash",
    "read",
    "web_search",
    "get_window_state",
    "computer_use_call_safe",
  ])
    assert.equal(
      isCuaTakeoverOperation({
        name,
        arguments: { tool: "get_window_state", target: window },
      }),
      false,
    );
});

test("malformed envelopes, extra fields and unrecognized selectors never bypass review", () => {
  const positive = call("get_window_state", {}, window);
  const malformed: unknown[] = [
    null,
    [],
    "get_window_state",
    { arguments: {} },
    { ...positive.arguments, safe: true },
    { ...positive.arguments, arguments: null },
    { ...positive.arguments, arguments: [] },
    {
      ...positive.arguments,
      arguments: { tool: "get_window_state", arguments: {} },
    },
    { ...positive.arguments, arguments: { action: "click" } },
    { ...positive.arguments, arguments: { pid: 100, window_id: 200 } },
    {
      ...positive.arguments,
      arguments: { screenshot_out_file: "/tmp/screen.png" },
    },
    { ...positive.arguments, arguments: { max_depth: Infinity } },
    { ...positive.arguments, arguments: { capture_mode: "som" } },
    {
      ...positive.arguments,
      arguments: {
        include_accessibility_tree: false,
        include_screenshot: false,
      },
    },
    { ...positive.arguments, target: undefined },
    { ...positive.arguments, target: page },
    { ...positive.arguments, target: { ...window, action: "click" } },
    { ...positive.arguments, target: { ...window, pid: 0 } },
    { ...positive.arguments, target: { ...window, tabId: "other" } },
    { ...positive.arguments, tool: "__proto__" },
    { ...positive.arguments, tool: "constructor" },
  ];
  for (const args of malformed)
    assert.equal(
      isCuaTakeoverOperation({
        name: "computer_use_call",
        arguments: args,
      } as Pick<ToolCall, "name" | "arguments">),
      false,
      JSON.stringify(args),
    );
  assert.equal(isCuaTakeoverOperation(call("list_apps", {}, window)), false);
  assert.equal(
    isCuaTakeoverOperation(
      call(
        "verify_state",
        {
          expect: [
            { element: { selector: { role: "button", action: "click" } } },
          ],
        },
        window,
      ),
    ),
    false,
  );
});
