import assert from "node:assert/strict";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { createComputerToolContract } from "./computer-use-contract.ts";

const target = { kind: "window", pid: 81116, windowId: 7726 };
const windowSchema: Tool = {
  name: "get_window_state",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      session: { type: "string" },
      pid: { type: "integer" },
      window_id: { type: "integer" },
      query: { type: "string" },
      max_elements: { type: "integer", minimum: 1 },
      screenshot_out_file: { type: "string" },
      include_screenshot: { type: "boolean" },
    },
    required: ["pid", "window_id"],
  },
};

test("discovery presents a complete Panel contract and leaves native schema intact", () => {
  const original = structuredClone(windowSchema);
  const contract = createComputerToolContract(windowSchema, "window");
  const valid = {
    tool: "get_window_state",
    target,
    arguments: { query: "search", max_elements: 400 },
  };
  assert.doesNotThrow(() => contract.validate(valid));
  const validator = new AjvJsonSchemaValidator().getValidator(
    contract.inputSchema,
  );
  assert.equal(validator(valid).valid, true);
  assert.equal(
    validator({ query: "search" }).valid,
    false,
    "inputSchema describes the whole call, not business arguments",
  );
  for (const example of contract.examples)
    assert.equal(validator(example).valid, true);
  const argsSchema = contract.inputSchema.properties
    ?.arguments as Tool["inputSchema"];
  assert.deepEqual(Object.keys(argsSchema.properties ?? {}).sort(), [
    "include_screenshot",
    "max_elements",
    "query",
  ]);
  assert.deepEqual(argsSchema.required, []);
  assert.deepEqual(windowSchema, original);
  assert.throws(
    () => contract.validate({ ...valid, arguments: { query: 1 } }),
    /arguments\/query must be string/,
  );
  assert.throws(
    () => contract.validate({ ...valid, arguments: { made_up: true } }),
    /\/arguments\/made_up/,
  );
});

test("the actual repeated get_window_state envelope reports exact paths and a corrected suggestion", () => {
  const contract = createComputerToolContract(windowSchema, "window");
  const malformed = {
    tool: "get_window_state",
    target,
    arguments: {
      tool: "get_window_state",
      arguments: {
        pid: 81116,
        window_id: 7726,
        query: "search",
        max_elements: 400,
      },
    },
  };
  const before = structuredClone(malformed);
  assert.throws(
    () => contract.validate(malformed),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\/arguments\/tool/);
      assert.match(error.message, /\/arguments\/arguments/);
      assert.ok(
        error.message.includes(
          JSON.stringify({
            tool: "get_window_state",
            target,
            arguments: { query: "search", max_elements: 400 },
          }),
        ),
      );
      assert.match(error.message, /未占用目标、未审批、未执行/);
      return true;
    },
  );
  assert.deepEqual(
    malformed,
    before,
    "never auto-rewrite the supplied or approved parameters",
  );
});

test("list_windows retains its process filter while rejecting a repeated wrapper", () => {
  const contract = createComputerToolContract(
    {
      name: "list_windows",
      inputSchema: {
        type: "object",
        properties: {
          pid: { type: "integer" },
          on_screen_only: { type: "boolean" },
        },
      },
    },
    "none",
  );
  assert.doesNotThrow(() =>
    contract.validate({
      tool: "list_windows",
      arguments: { pid: 81116, on_screen_only: true },
    }),
  );
  assert.throws(
    () => contract.validate({ tool: "list_windows", target, arguments: {} }),
    /\/target/,
  );
  assert.throws(
    () =>
      contract.validate({
        tool: "list_windows",
        arguments: { tool: "list_windows", arguments: { pid: 81116 } },
      }),
    /"arguments":\{"pid":81116\}/,
  );
});

test("browser window binding and page observation expose distinct complete input contracts", () => {
  const contract = createComputerToolContract(
    {
      name: "get_browser_state",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          pid: { type: "integer" },
          window_id: { type: "integer" },
          session: { type: "string" },
          target_id: { type: "string" },
          tab_id: { type: "string" },
          query: { type: "string" },
          include_screenshot: { type: "boolean" },
        },
      },
    },
    "browser_state",
  );
  const page = { ...target, kind: "page", tabId: "fresh-tab-id" };
  assert.doesNotThrow(() =>
    contract.validate({
      tool: "get_browser_state",
      target,
      arguments: { refresh_binding: true },
    }),
  );
  assert.doesNotThrow(() =>
    contract.validate({
      tool: "get_browser_state",
      target: page,
      arguments: { query: "search", include_screenshot: true },
    }),
  );
  assert.throws(
    () =>
      contract.validate({
        tool: "get_browser_state",
        target,
        arguments: { query: "silently ignored before" },
      }),
    /\/arguments\/query/,
  );
  assert.throws(
    () =>
      contract.validate({
        tool: "get_browser_state",
        target: page,
        arguments: { refresh_binding: true },
      }),
    /\/arguments\/refresh_binding/,
  );
  assert.throws(
    () =>
      contract.validate({
        tool: "get_browser_state",
        target: { ...target, kind: "page" },
      }),
    /tabId/,
  );
  const validator = new AjvJsonSchemaValidator().getValidator(
    contract.inputSchema,
  );
  for (const example of contract.examples)
    assert.equal(validator(example).valid, true);
});

test("caller contracts preserve nested predicates but do not advertise host-only permission and launch settings", () => {
  const predicate = {
    type: "array",
    minItems: 1,
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        window: { type: "object", properties: { exists: { type: "boolean" } } },
      },
    },
  };
  const contract = createComputerToolContract(
    {
      name: "verify_state",
      inputSchema: {
        type: "object",
        properties: {
          pid: { type: "integer" },
          window_id: { type: "integer" },
          expect: predicate,
        },
        required: ["pid", "window_id", "expect"],
      },
    },
    "window",
  );
  const argsSchema = contract.inputSchema.properties
    ?.arguments as Tool["inputSchema"];
  assert.deepEqual(argsSchema.properties?.expect, predicate);
  assert.throws(
    () => contract.validate({ tool: "verify_state", target }),
    /arguments/,
  );
  assert.doesNotThrow(() =>
    contract.validate({
      tool: "verify_state",
      target,
      arguments: { expect: [{ window: { exists: true } }] },
    }),
  );
  for (const [name, fields] of Object.entries({
    browser_prepare: ["profile", "allow_launch", "strategy"],
    launch_app: [
      "additional_arguments",
      "urls",
      "webkit_inspector_port",
      "creates_new_application_instance",
    ],
    check_permissions: ["prompt"],
  })) {
    const controlled = createComputerToolContract(
      {
        name,
        inputSchema: {
          type: "object",
          properties: Object.fromEntries(fields.map((field) => [field, {}])),
        },
      },
      "none",
    );
    for (const field of fields)
      assert.throws(
        () => controlled.validate({ tool: name, arguments: { [field]: true } }),
        new RegExp(`/arguments/${field}`),
      );
  }
});
