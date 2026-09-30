import assert from "node:assert/strict";
import test from "node:test";
import {
  compactComputerDiscovery,
  MAX_DISCOVERY_JSON_BYTES,
  MAX_DISCOVERY_RECORDS,
  type ComputerDiscoveryResult,
} from "./computer-use-discovery.ts";

test("large window discovery retains actionable original IDs and prioritizes current visible windows", () => {
  const windows = Array.from({ length: 229 }, (_, index) => ({
    pid: 1000 + index,
    window_id: 8000 + index,
    app_name: `Application ${index}`,
    title: `Document ${index} ${"detail ".repeat(120)}`,
    bounds: { x: 0, y: 0, width: 1000, height: 800 },
    is_on_screen: index === 228,
    on_current_space: index === 228,
    layer: 0,
    current_space_id: 1,
    space_ids: [1],
    z_index: index,
    unused_blob: "x".repeat(1000),
  }));
  const result = {
    content: [{ type: "text", text: "Found 229 windows." }],
    structuredContent: { current_space_id: 1, windows },
  };
  const before = structuredClone(result);
  const compacted = compactComputerDiscovery("list_windows", result);
  const summary = compacted.structuredContent!;
  const selected = summary.windows as Record<string, unknown>[];
  assert.equal(summary.total, 229);
  assert.equal(summary.returned, selected.length);
  assert.equal(summary.omitted, 229 - selected.length);
  assert.equal(summary.truncated, true);
  assert.ok(selected.length > 0 && selected.length <= MAX_DISCOVERY_RECORDS);
  assert.equal(selected[0].pid, 1228);
  assert.equal(selected[0].window_id, 8228);
  assert.equal(summary.current_space_id, 1);
  assert.ok(
    selected.every((item) =>
      windows.some(
        (source) =>
          source.pid === item.pid && source.window_id === item.window_id,
      ),
    ),
  );
  assert.match(String(summary.note), /省略，并非不存在/);
  const encoded = JSON.stringify(summary);
  assert.ok(Buffer.byteLength(encoded) <= MAX_DISCOVERY_JSON_BYTES);
  assert.deepEqual(JSON.parse(encoded), summary);
  assert.doesNotMatch(encoded, /unused_blob|max_elements|"query"/);
  assert.deepEqual(result, before);
});

test("app discovery preserves exact bundle/path identities and useful names before bounded metadata", () => {
  const apps = Array.from({ length: 240 }, (_, index) => ({
    name: `App ${index}`,
    bundle_id: `com.Example.App${index}`,
    pid: 2000 + index,
    active: index === 239,
    running: index >= 220,
    kind: "regular",
    last_used: 1750000000 + index,
    launch_path: `/Applications/App ${index}.app`,
    windows: [],
  }));
  const summary = compactComputerDiscovery("list_apps", {
    structuredContent: { apps },
  }).structuredContent!;
  const selected = summary.apps as typeof apps;
  assert.equal(selected[0].bundle_id, "com.Example.App239");
  assert.equal(selected[0].launch_path, "/Applications/App 239.app");
  assert.equal(selected[0].pid, 2239);
  assert.equal(selected[0].name, "App 239");
  assert.equal(summary.total, 240);
  assert.equal(summary.returned, selected.length);
  assert.equal(summary.omitted, 240 - selected.length);
  const hint = summary.next_call_hint as {
    instruction: string;
    examples: { tool: string; arguments: Record<string, unknown> }[];
  };
  assert.match(hint.instruction, /list_apps 没有筛选参数/);
  assert.deepEqual(hint.examples, [
    { tool: "list_windows", arguments: { on_screen_only: true } },
    { tool: "list_windows", arguments: { pid: 2239 } },
  ]);
  assert.ok(
    Buffer.byteLength(JSON.stringify(summary)) <= MAX_DISCOVERY_JSON_BYTES,
  );
});

test("small scoped responses retain filters, original identity types and complete records", () => {
  const windows = [
    {
      pid: 42,
      window_id: "007",
      app_name: "Notes",
      title: "Budget",
      is_on_screen: true,
      on_current_space: true,
    },
  ];
  const summary = compactComputerDiscovery(
    "list_windows",
    { structuredContent: { windows } },
    { pid: 42, on_screen_only: true, session: "private" },
  ).structuredContent!;
  assert.deepEqual(summary.windows, windows);
  assert.deepEqual(summary.filters, { pid: 42, on_screen_only: true });
  assert.equal(summary.total, 1);
  assert.equal(summary.returned, 1);
  assert.equal(summary.omitted, 0);
  assert.equal(summary.truncated, false);
  assert.doesNotMatch(JSON.stringify(summary), /private|session/);
});

test("long labels are explicitly abbreviated, nested arrays bounded, and oversized IDs never rewritten", () => {
  const source = {
    apps: [
      {
        pid: 8,
        bundle_id: "valid.bundle",
        name: "界".repeat(500),
        windows: Array.from({ length: 20 }, (_, i) => ({
          pid: 8,
          window_id: 900 + i,
          title: "window",
        })),
      },
      { pid: 9, bundle_id: "b".repeat(2000), name: "oversized identity" },
    ],
  };
  const summary = compactComputerDiscovery("list_apps", {
    structuredContent: source,
  }).structuredContent!;
  const apps = summary.apps as Record<string, unknown>[];
  assert.equal(summary.total, 2);
  assert.equal(summary.returned, 1);
  assert.equal(summary.omitted, 1);
  assert.equal(summary.truncated, true);
  assert.equal(apps[0].bundle_id, "valid.bundle");
  assert.ok(String(apps[0].name).length <= 160);
  assert.deepEqual(apps[0].truncated_fields, ["name", "windows"]);
  assert.equal(apps[0].windows_total, 20);
  assert.equal(apps[0].windows_omitted, 12);
  assert.equal((apps[0].windows as unknown[]).length, 8);
  assert.ok(!JSON.stringify(summary).includes("b".repeat(160)));
});

test("empty and malformed discovery is explicit without fabricating ids, unrelated results pass through", () => {
  const empty = compactComputerDiscovery("list_windows", {
    structuredContent: { windows: [] },
  }).structuredContent!;
  assert.deepEqual(empty.windows, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.returned, 0);
  const malformed = compactComputerDiscovery("list_windows", {
    structuredContent: {
      windows: [null, "bad", { pid: { invalid: true }, window_id: 7 }],
    },
  }).structuredContent!;
  assert.equal(malformed.total, 3);
  assert.equal(malformed.returned, 0);
  assert.equal(malformed.omitted, 3);
  assert.equal(malformed.truncated, true);
  const passthrough: [string, ComputerDiscoveryResult][] = [
    ["get_window_state", { structuredContent: { windows: [] } }],
    ["list_windows", { structuredContent: { windows: "not an array" } }],
    [
      "list_apps",
      {
        isError: true,
        content: [{ type: "text", text: "Access denied" }],
        structuredContent: { apps: [] },
      },
    ],
  ];
  for (const [tool, result] of passthrough)
    assert.equal(compactComputerDiscovery(tool, result), result);
});
