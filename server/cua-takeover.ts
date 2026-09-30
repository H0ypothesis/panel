import type { ToolCall } from "../shared/types.ts";

type Check = (value: unknown) => boolean;
type ObjectValue = Record<string, unknown>;

function object(value: unknown): value is ObjectValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function shape(
  value: unknown,
  fields: Record<string, Check>,
  required: readonly string[] = [],
): value is ObjectValue {
  return (
    object(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every(
      (key) => Object.hasOwn(fields, key) && fields[key](value[key]),
    )
  );
}

const boolean: Check = (value) => typeof value === "boolean";
const string: Check = (value) => typeof value === "string";
const nonempty: Check = (value) =>
  string(value) && (value as string).length > 0;
const number: Check = (value) =>
  typeof value === "number" && Number.isFinite(value);
const integer =
  (minimum: number, maximum = Infinity): Check =>
  (value) =>
    number(value) &&
    Number.isInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum;
const oneOf =
  (...values: string[]): Check =>
  (value) =>
    typeof value === "string" && values.includes(value);
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const empty: Check = (value) => shape(value, {});

const windowTarget: Check = (value) =>
  shape(
    value,
    {
      kind: oneOf("window"),
      pid: integer(1),
      windowId: integer(1),
    },
    ["kind", "pid", "windowId"],
  );
const pageTarget: Check = (value) =>
  shape(
    value,
    {
      kind: oneOf("page"),
      pid: integer(1),
      windowId: integer(1),
      tabId: (id) => nonempty(id) && (id as string).length <= 511,
    },
    ["kind", "pid", "windowId", "tabId"],
  );

const predicate: Check = (value) =>
  shape(value, {
    window: nullable((item) =>
      shape(item, {
        exists: nullable(boolean),
        bounds: nullable((bounds) =>
          shape(
            bounds,
            {
              x: number,
              y: number,
              width: number,
              height: number,
              tolerance_px: (n) =>
                number(n) && (n as number) >= 0 && (n as number) <= 100,
            },
            ["x", "y", "width", "height"],
          ),
        ),
      }),
    ),
    element: nullable((item) =>
      shape(
        item,
        {
          exists: boolean,
          enabled: nullable(boolean),
          selected: nullable(boolean),
          value_equals: nullable(string),
          selector: (selector) =>
            shape(selector, { label_contains: nonempty, role: nonempty }),
        },
        ["selector"],
      ),
    ),
  });

const healthCheck = oneOf(
  "binary_version",
  "platform_supported",
  "session_active",
  "bundle_identity",
  "tcc_accessibility",
  "tcc_screen_recording",
  "ax_capability",
  "screen_capture_capability",
);
const healthChecks: Check = (value) =>
  Array.isArray(value) && value.every(healthCheck);

// Caller-owned fields from official Cua Driver 0.30.4's describe schemas.
// This is intentionally narrower than the executable contract: upgrades adding
// actions/fields must not silently expand a user's current takeover grant.
const discovery: Record<string, Check> = {
  list_apps: empty,
  list_windows: (args) =>
    shape(args, { pid: integer(1), on_screen_only: boolean }),
  // Panel injects prompt:false; accepting a caller's prompt would bypass that boundary.
  check_permissions: (args) => shape(args, { probe_direct_capture: boolean }),
  health_report: (args) =>
    shape(args, { include: healthChecks, skip: healthChecks }),
  get_screen_size: empty,
  get_cursor_position: empty,
};

const native: Record<string, Check> = {
  get_window_state: (args) =>
    shape(args, {
      capture_mode: oneOf("ax", "vision"),
      include_accessibility_tree: boolean,
      include_screenshot: boolean,
      max_depth: integer(1),
      max_dimension: integer(1),
      max_elements: integer(1),
      max_image_dimension: integer(0),
      query: string,
      timeout_ms: integer(100, 120000),
    }) &&
    !(
      args.include_accessibility_tree === false &&
      args.include_screenshot === false
    ),
  verify_state: (args) =>
    shape(
      args,
      {
        expect: (items) =>
          Array.isArray(items) &&
          items.length >= 1 &&
          items.length <= 8 &&
          items.every(predicate),
        include_screenshot: nullable(boolean),
        stable_samples: integer(1, 5),
        timeout_ms: integer(0, 10000),
      },
      ["expect"],
    ),
  // In 0.30.4 zoom crops an existing window screenshot; it does not zoom the app.
  zoom: (args) =>
    shape(args, { x1: number, y1: number, x2: number, y2: number }, [
      "x1",
      "y1",
      "x2",
      "y2",
    ]),
  scroll: (args) =>
    shape(
      args,
      {
        direction: oneOf("up", "down", "left", "right"),
        amount: integer(1, 50),
        by: oneOf("line", "page"),
        delivery_mode: oneOf("background"),
        element_index: integer(0),
        element_token: nonempty,
        snapshot_id: (id) =>
          typeof id === "string" && /^s[0-9a-f]{8}$/.test(id),
        x: number,
        y: number,
      },
      ["direction"],
    ) &&
    Object.hasOwn(args, "x") === Object.hasOwn(args, "y") &&
    (!Object.hasOwn(args, "element_index") ||
      Object.hasOwn(args, "snapshot_id")),
};

function browserPointer(args: unknown): boolean {
  if (!object(args)) return false;
  const common = {
    action: oneOf("hover", "scroll"),
    ref: nonempty,
    x: number,
    y: number,
    input_route: oneOf("trusted", "dom_event"),
  };
  if (
    !shape(
      args,
      args.action === "scroll"
        ? { ...common, delta_x: number, delta_y: number }
        : common,
      ["action"],
    )
  )
    return false;
  const coordinates = Object.hasOwn(args, "x") && Object.hasOwn(args, "y");
  const ref = Object.hasOwn(args, "ref");
  if (ref ? Object.hasOwn(args, "x") || Object.hasOwn(args, "y") : !coordinates)
    return false;
  if (args.input_route === "dom_event" && !ref) return false;
  return (
    args.action !== "scroll" ||
    Object.hasOwn(args, "delta_x") ||
    Object.hasOwn(args, "delta_y")
  );
}

/** A narrow user-authorized bypass, evaluated only after normal CUA preflight. */
export function isCuaTakeoverOperation(
  call: Pick<ToolCall, "name" | "arguments">,
): boolean {
  if (call.name === "computer_use_tools")
    return shape(call.arguments, {
      group: oneOf("core", "browser", "window", "diagnostics"),
    });
  if (call.name === "computer_use_release") return empty(call.arguments);
  if (
    call.name !== "computer_use_call" ||
    !shape(
      call.arguments,
      {
        tool: nonempty,
        target: (value) => windowTarget(value) || pageTarget(value),
        arguments: object,
      },
      ["tool"],
    )
  )
    return false;

  const { tool, target } = call.arguments;
  const args = call.arguments.arguments ?? {};
  if (typeof tool !== "string") return false;
  if (Object.hasOwn(discovery, tool))
    return !Object.hasOwn(call.arguments, "target") && discovery[tool](args);
  if (Object.hasOwn(native, tool))
    return windowTarget(target) && native[tool](args);
  if (tool === "get_browser_state") {
    if (windowTarget(target)) return shape(args, { refresh_binding: boolean });
    return (
      pageTarget(target) &&
      shape(args, {
        continuation: string,
        include_screenshot: boolean,
        query: string,
        scope_ref: string,
        snapshot_format: oneOf("dom_refs_v1", "semantic_v2"),
      })
    );
  }
  return (
    tool === "browser_pointer" && pageTarget(target) && browserPointer(args)
  );
}
