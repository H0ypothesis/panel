import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

type Schema = Record<string, unknown>;
type Parameters = Record<string, unknown>;
export type ComputerTargetMode = "none" | "window" | "page" | "browser_state";
export interface ComputerToolContract {
  inputSchema: Tool["inputSchema"];
  examples: Parameters[];
  validate(parameters: Parameters): void;
}

const HOST_ARGUMENTS = new Set([
  "session",
  "target",
  "target_id",
  "tab_id",
  "window_id",
  "scope",
  "screenshot_out_file",
  "debug_image_out",
  "output_dir",
  "recording_path",
]);

export function isComputerHostArgument(tool: string, key: string): boolean {
  return HOST_ARGUMENTS.has(key) || (key === "pid" && tool !== "list_windows");
}

function record(value: unknown): value is Parameters {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function targetSchema(kind: "window" | "page"): Schema {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string", const: kind },
      pid: { type: "integer", minimum: 1 },
      windowId: { type: "integer", minimum: 1 },
      ...(kind === "page"
        ? { tabId: { type: "string", minLength: 1, maxLength: 511 } }
        : {}),
    },
    required: [
      "kind",
      "pid",
      "windowId",
      ...(kind === "page" ? ["tabId"] : []),
    ],
  };
}

/** Derive only caller-owned fields. Full native validation still runs after routing. */
function callerArguments(tool: Tool): Schema {
  const schema = structuredClone(tool.inputSchema) as Schema;
  const properties = { ...(schema.properties as Schema | undefined) };
  for (const key of Object.keys(properties))
    if (
      isComputerHostArgument(tool.name, key) ||
      (tool.name === "launch_app" &&
        [
          "urls",
          "webkit_inspector_port",
          "additional_arguments",
          "creates_new_application_instance",
        ].includes(key)) ||
      (tool.name === "browser_prepare" &&
        ["strategy", "profile", "allow_launch"].includes(key)) ||
      (tool.name === "check_permissions" && key === "prompt")
    )
      delete properties[key];
  schema.properties = properties;
  // The pinned driver's schemas are flat at the argument boundary; nested
  // predicate/selector schemas are preserved intact, including their limits.
  schema.required = (
    Array.isArray(schema.required) ? schema.required : []
  ).filter((key) => typeof key === "string" && key in properties);
  schema.additionalProperties = false;
  return schema;
}

function wrapper(
  tool: string,
  args: Schema,
  mode: "none" | "window" | "page",
): Tool["inputSchema"] {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      tool: { type: "string", const: tool },
      ...(mode !== "none" ? { target: targetSchema(mode) } : {}),
      arguments: args,
    },
    required: [
      "tool",
      ...(mode !== "none" ? ["target"] : []),
      ...(Array.isArray(args.required) && args.required.length
        ? ["arguments"]
        : []),
    ],
  };
}

const EXAMPLE_ARGUMENTS: Record<string, Parameters> = {
  list_apps: {},
  list_windows: { pid: 12345, on_screen_only: true },
  get_window_state: { query: "搜索", max_elements: 400 },
  browser_prepare: {},
  launch_app: { name: "Calculator" },
  verify_state: { expect: [{ window: { exists: true } }] },
  click: { x: 120, y: 80 },
  double_click: { x: 120, y: 80 },
  right_click: { x: 120, y: 80 },
  drag: { from_x: 100, from_y: 80, to_x: 200, to_y: 160 },
  type_text: { text: "示例文字" },
  press_key: { key: "return" },
  hotkey: { keys: ["cmd", "f"] },
  set_value: {
    element_token: "本次观察返回的 element_token",
    value: "示例文字",
  },
  scroll: { direction: "down", amount: 1 },
  zoom: { x1: 0, y1: 0, x2: 200, y2: 160 },
  set_window_frame: { x: 0, y: 0, width: 800, height: 600 },
  bring_to_front: {},
  check_permissions: {},
  health_report: {},
  get_screen_size: {},
  get_cursor_position: {},
  browser_navigate: { url: "https://example.com/" },
  browser_click: { ref: "本次观察返回的 ref" },
  browser_type: { ref: "本次观察返回的 ref", text: "示例文字" },
  browser_dialog: { action: "inspect" },
  browser_pointer: { action: "hover", ref: "本次观察返回的 ref" },
};

export function createComputerToolContract(
  tool: Tool,
  mode: ComputerTargetMode,
): ComputerToolContract {
  const args = callerArguments(tool);
  const schemas =
    mode === "browser_state"
      ? [
          wrapper(
            tool.name,
            {
              type: "object",
              additionalProperties: false,
              properties: {
                refresh_binding: {
                  type: "boolean",
                  description:
                    "Refresh the window's tab binding after waiting for exclusive ownership. Omit to reuse it.",
                },
              },
            },
            "window",
          ),
          wrapper(tool.name, args, "page"),
        ]
      : [wrapper(tool.name, args, mode)];
  const inputSchema: Tool["inputSchema"] =
    schemas.length === 1 ? schemas[0] : { type: "object", oneOf: schemas };
  const validators = schemas.map((schema) =>
    new AjvJsonSchemaValidator().getValidator(schema),
  );
  const examples: Parameters[] =
    mode === "browser_state"
      ? [
          {
            tool: tool.name,
            target: { kind: "window", pid: 12345, windowId: 678 },
            arguments: {},
          },
          {
            tool: tool.name,
            target: {
              kind: "page",
              pid: 12345,
              windowId: 678,
              tabId: "本次绑定返回的 tab_id",
            },
            arguments: { include_screenshot: true },
          },
        ]
      : EXAMPLE_ARGUMENTS[tool.name]
        ? [
            {
              tool: tool.name,
              ...(mode !== "none"
                ? {
                    target: {
                      kind: mode,
                      pid: 12345,
                      windowId: 678,
                      ...(mode === "page"
                        ? { tabId: "本次绑定返回的 tab_id" }
                        : {}),
                    },
                  }
                : {}),
              arguments: Object.fromEntries(
                Object.entries(
                  structuredClone(EXAMPLE_ARGUMENTS[tool.name]),
                ).filter(([key]) => key in (args.properties as Schema)),
              ),
            },
          ]
        : [];

  function variant(parameters: Parameters): number {
    return mode === "browser_state" &&
      record(parameters.target) &&
      parameters.target.kind === "page"
      ? 1
      : 0;
  }
  function correction(parameters: Parameters): Parameters {
    const schema = schemas[variant(parameters)];
    const allowed = ((schema.properties?.arguments as Schema).properties ??
      {}) as Schema;
    let values = record(parameters.arguments) ? parameters.arguments : {};
    // This is an error-message suggestion only, never an execution rewrite.
    for (let depth = 0; depth < 4 && record(values.arguments); depth++)
      values = values.arguments;
    return {
      tool: tool.name,
      ...(record(parameters.target) && mode !== "none"
        ? { target: parameters.target }
        : {}),
      arguments: Object.fromEntries(
        Object.entries(values).filter(([key]) => key in allowed),
      ),
    };
  }
  return {
    inputSchema,
    examples,
    validate(parameters) {
      const index = variant(parameters);
      const schema = schemas[index];
      const problems: string[] = [];
      const supplied = parameters.arguments;
      if (record(supplied) && ("tool" in supplied || "arguments" in supplied)) {
        for (const key of ["tool", "arguments"])
          if (key in supplied) problems.push(`/arguments/${key}`);
        throw new Error(
          `调用格式错误：${problems.join("、")} 重复嵌套了调用包装。tool、target、arguments 只能出现在最外层，arguments 仅放该工具的业务参数。请重新提交 computer_use_call，例如：${JSON.stringify(correction(parameters))}。本次未占用目标、未审批、未执行。`,
        );
      }
      const objects = [
        { value: parameters, schema, path: "" },
        {
          value: supplied,
          schema: schema.properties?.arguments as Schema,
          path: "/arguments",
        },
        {
          value: parameters.target,
          schema: schema.properties?.target as Schema | undefined,
          path: "/target",
        },
      ];
      for (const entry of objects) {
        if (!record(entry.value) || !entry.schema) continue;
        const properties = (entry.schema.properties ?? {}) as Schema;
        for (const key of Object.keys(entry.value))
          if (!(key in properties)) problems.push(`${entry.path}/${key}`);
      }
      if (problems.length)
        throw new Error(
          `computer_use_call 不接受字段 ${problems.join("、")}。arguments 只能使用本工具 inputSchema.properties.arguments 的字段；进程/窗口/页面标识由最外层 target 提供（list_windows.arguments.pid 可筛选）。请对照 computer_use_tools 的完整 inputSchema 重试。本次未占用目标、未审批、未执行。`,
        );
      const validation = validators[index](parameters);
      if (!validation.valid)
        throw new Error(
          `computer_use_call 参数不符合 ${tool.name} 的 Panel 调用格式：${validation.errorMessage}。请对照 computer_use_tools 返回的完整 inputSchema 重试。本次未占用目标、未审批、未执行。`,
        );
    },
  };
}
