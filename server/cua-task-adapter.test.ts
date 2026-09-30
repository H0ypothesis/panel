import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ComputerUseScope } from "../shared/types.ts";
import {
  ComputerUse,
  type ComputerDriver,
  type ComputerSession,
} from "./computer-use.ts";

async function fixture(t: TestContext) {
  const state = {
    url: "https://example.com/search",
    name: "Search",
    duplicate: false,
    generation: 1,
    snapshots: 0,
    afterSnapshot: undefined as (() => void) | undefined,
  };
  const invocations: { name: string; args: Record<string, unknown> }[] = [];
  const schemas: Tool[] = [
    "get_browser_state",
    "browser_click",
    "browser_type",
    "browser_pointer",
  ].map((name) => ({
    name,
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string" },
        pid: { type: "integer" },
        window_id: { type: "integer" },
        target_id: { type: "string" },
        tab_id: { type: "string" },
        ref: { type: "string" },
        text: { type: "string" },
        snapshot_format: { type: "string" },
        action: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
        delta_y: { type: "number" },
      },
      additionalProperties: false,
    },
  }));
  const driver: ComputerDriver = {
    getStatus: () => ({ installed: true, state: "ready" }),
    close: async () => {},
    openSession: async (): Promise<ComputerSession> => ({
      id: randomUUID(),
      get generation() {
        return state.generation;
      },
      close: async () => {},
      listTools: async () => schemas,
      callTool: async (name, args) => {
        invocations.push({ name, args: structuredClone(args) });
        if (name === "check_permissions")
          return {
            structuredContent: { accessibility: true, screen_recording: true },
          };
        if (name === "get_browser_state" && args.window_id)
          return {
            structuredContent: {
              target_id: "bound",
              binding_quality: "exact",
              mutation_allowed: true,
              tabs: [{ tab_id: "tab", url: state.url }],
            },
          };
        if (name === "get_browser_state") {
          const n = ++state.snapshots;
          const element = {
            ref: `p${n}:1`,
            role: "searchbox",
            name: state.name,
            actions: ["click", "type"],
            frame: "main",
            visibility: "in_viewport",
          };
          state.afterSnapshot?.();
          return {
            structuredContent: {
              status: "ok",
              mode: "snapshot",
              target_id: "bound",
              tab_id: "tab",
              snapshot: { id: `p${n}`, format: "semantic_v2" },
              page: { url: state.url },
              refs: state.duplicate
                ? [element, { ...element, ref: `p${n}:2` }]
                : [element],
            },
          };
        }
        return { content: [{ type: "text", text: "done" }] };
      },
    }),
  };
  const scopes: (ComputerUseScope | undefined)[] = [];
  const host = new ComputerUse(driver);
  const run = host.newRun(true, (scope) => scopes.push(scope));
  t.after(async () => {
    await run.close();
    await host.close();
  });
  const tools = run.tools();
  await tools
    .find((t) => t.name === "computer_use_tools")!
    .execute("discover", { group: "browser" });
  const signal = new AbortController().signal;
  const target = { kind: "page" as const, pid: 1, windowId: 2, tabId: "tab" };
  const prepare = async (
    tool: string,
    args: Record<string, unknown> = {},
    scope: Record<string, unknown> = target,
  ) => {
    const id = randomUUID();
    const parameters = { tool, target: scope, arguments: args };
    const context = await run.prepare(
      { id, name: "computer_use_call", arguments: parameters },
      signal,
      () => {},
    );
    return {
      context,
      execute: () =>
        tools
          .find((t) => t.name === "computer_use_call")!
          .execute(id, parameters, signal),
    };
  };
  await (
    await prepare(
      "get_browser_state",
      {},
      { kind: "window", pid: 1, windowId: 2 },
    )
  ).execute();
  await (
    await prepare("get_browser_state", { snapshot_format: "semantic_v2" })
  ).execute();
  const prepareAction = () =>
    prepare("browser_type", { ref: `p${state.snapshots}:1`, text: "pictures" });
  return { state, invocations, scopes, prepare, prepareAction };
}

test("actual adapter mints stable scopes and revalidates/remaps refs before task dispatch", async (t) => {
  const f = await fixture(t);
  const scope = f.scopes.at(-1)!;
  const action = await f.prepareAction();
  assert.equal(action.context?.routine, true);
  let guards = 0;
  action.context!.authorizeTask!(() => guards++);
  await action.execute();
  assert.equal(f.invocations.at(-1)!.args.ref, "p2:1");
  assert.equal(f.invocations.at(-1)!.args.text, "pictures");
  assert.equal(f.scopes.at(-1)!.id, scope.id);
  assert.equal(guards, 2);
  // A post-action observation stays within the same task scope.
  const observation = await f.prepare("get_browser_state", {
    snapshot_format: "semantic_v2",
  });
  assert.equal(observation.context?.scope?.id, scope.id);
  observation.context!.authorizeTask!(() => {});
  await observation.execute();
  assert.equal(f.scopes.at(-1)!.id, scope.id);
});

test("task dispatch refuses a changed origin, renamed control, duplicate element, or revoked grant", async (t) => {
  for (const scenario of [
    "origin",
    "name",
    "duplicate",
    "revoke",
    "generation",
  ] as const) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      const action = await f.prepareAction();
      let active = true;
      action.context!.authorizeTask!(() => {
        if (!active) throw new Error("grant revoked");
      });
      if (scenario === "origin") f.state.url = "https://other.example/pay";
      if (scenario === "name") f.state.name = "付款";
      if (scenario === "duplicate") f.state.duplicate = true;
      if (scenario === "generation") f.state.generation++;
      if (scenario === "revoke")
        f.state.afterSnapshot = () => {
          active = false;
        };
      await assert.rejects(action.execute());
      assert.equal(
        f.invocations.filter((c) => c.name === "browser_type").length,
        0,
      );
    });
  }
});

test("basic scroll also works inside task scope with a live origin check", async (t) => {
  const f = await fixture(t);
  const action = await f.prepare("browser_pointer", {
    action: "scroll",
    x: 10,
    y: 20,
    delta_y: 400,
  });
  action.context!.authorizeTask!(() => {});
  await action.execute();
  assert.equal(f.invocations.at(-1)?.name, "browser_pointer");
});

test("an observation after external navigation does not expose the new site under the old grant", async (t) => {
  const f = await fixture(t);
  const read = await f.prepare("get_browser_state", {
    snapshot_format: "semantic_v2",
  });
  read.context!.authorizeTask!(() => {});
  f.state.url = "https://other.example";
  await assert.rejects(read.execute(), /超出本任务授权/);
  assert.equal(f.scopes.at(-1)!.origin, "https://other.example");
});
