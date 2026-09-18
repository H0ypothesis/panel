import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TOOL_POLICY_VERSION,
  ToolAuthorizationRegistry,
  type ToolAuthorizationCall,
  type ToolAuthorizationScope,
} from "./tool-authorization.ts";

function fixture() {
  const scope: ToolAuthorizationScope = {
    workspaceId: "workspace-1",
    nodeId: "node-1",
    workingDirectory: "/tmp/workspace",
    settingsVersion: 3,
    approvalMode: "auto",
    safetyModel: "provider/safety-model",
  };
  const call: ToolAuthorizationCall = {
    id: "call-1",
    name: "write",
    arguments: {
      path: "hello.ts",
      content: "console.log(42);\n",
      nested: { z: [true, null, 12], a: "value" },
    },
  };
  let now = 1000;
  const registry = new ToolAuthorizationRegistry(() => now, 100);
  return { scope, call, registry, setTime: (value: number) => (now = value) };
}

test("a grant binds complete action data and is consumed exactly once", () => {
  const { scope, call, registry, setTime } = fixture();
  const audit = registry.issue(scope, call);
  assert.equal(audit.policyVersion, TOOL_POLICY_VERSION);
  assert.match(audit.actionHash, /^[0-9a-f]{64}$/);
  assert.equal(audit.issuedAt, 1000);
  assert.equal(audit.expiresAt, 1100);
  setTime(1001);
  assert.deepEqual(registry.consume(audit.id, scope, call), {
    ...audit,
    consumedAt: 1001,
  });
  assert.throws(() => registry.consume(audit.id, scope, call), /已使用/);
});

test("canonical hashes ignore object key order but preserve complete values", () => {
  const { scope, call, registry } = fixture();
  const audit = registry.issue(scope, call);
  const reordered: ToolAuthorizationCall = {
    arguments: {
      nested: { a: "value", z: [true, null, 12] },
      content: "console.log(42);\n",
      path: "hello.ts",
    },
    name: "write",
    id: "call-1",
  };
  const second = registry.issue({ ...scope }, reordered);
  assert.equal(audit.actionHash, second.actionHash);
  assert.notEqual(audit.id, second.id);
  assert.equal(
    registry.consume(audit.id, scope, reordered).actionHash,
    audit.actionHash,
  );
  const absentModel = { ...scope, safetyModel: undefined };
  const { safetyModel: _unused, ...withoutModel } = scope;
  assert.equal(
    registry.issue(absentModel, call).actionHash,
    registry.issue(withoutModel, call).actionHash,
  );
});

const changedScopes: Partial<ToolAuthorizationScope>[] = [
  { workspaceId: "workspace-2" },
  { nodeId: "node-2" },
  { workingDirectory: "/tmp/other" },
  { workingDirectory: null },
  { settingsVersion: 4 },
  { approvalMode: "ask" },
  { safetyModel: "provider/other-safety-model" },
  { safetyModel: undefined },
];
for (const change of changedScopes) {
  test(`changed scope ${Object.keys(change)[0]} invalidates and consumes a grant`, () => {
    const { scope, call, registry } = fixture();
    const audit = registry.issue(scope, call);
    assert.throws(
      () => registry.consume(audit.id, { ...scope, ...change }, call),
      /已变化/,
    );
    assert.throws(() => registry.consume(audit.id, scope, call), /已使用/);
  });
}

const changedCalls: Partial<ToolAuthorizationCall>[] = [
  { id: "call-2" },
  { name: "bash" },
  { arguments: { path: "hello.ts", content: "different content" } },
];
for (const change of changedCalls) {
  test(`changed call ${Object.keys(change)[0]} invalidates and consumes a grant`, () => {
    const { scope, call, registry } = fixture();
    const audit = registry.issue(scope, call);
    assert.throws(
      () => registry.consume(audit.id, scope, { ...call, ...change }),
      /已变化/,
    );
    assert.throws(() => registry.consume(audit.id, scope, call), /已使用/);
  });
}

test("caller mutations cannot rewrite stored action or grant metadata", () => {
  const { scope, call, registry } = fixture();
  const originalScope = structuredClone(scope);
  const originalCall = structuredClone(call);
  const audit = registry.issue(scope, call);
  const originalAudit = { ...audit };
  scope.nodeId = "mutated-node";
  (call.arguments.nested as { z: unknown[] }).z[0] = false;
  audit.id = "forged";
  audit.actionHash = "forged";
  audit.policyVersion = "forged";
  audit.expiresAt = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(
    registry.consume(originalAudit.id, originalScope, originalCall),
    { ...originalAudit, consumedAt: 1000 },
  );
});

test("mutating nested arguments after issue cannot authorize the new action", () => {
  const { scope, call, registry } = fixture();
  const audit = registry.issue(scope, call);
  (call.arguments.nested as { z: unknown[] }).z.push("extra");
  assert.throws(() => registry.consume(audit.id, scope, call), /已变化/);
});

test("grants expire at their exact deadline and reject clock rollback", () => {
  for (const now of [1100, 1101, 999]) {
    const { scope, call, registry, setTime } = fixture();
    const audit = registry.issue(scope, call);
    setTime(now);
    assert.throws(() => registry.consume(audit.id, scope, call), /已过期/);
    setTime(1000);
    assert.throws(() => registry.consume(audit.id, scope, call), /已使用/);
  }
});

test("concurrent microtasks cannot consume a grant twice", async () => {
  const { scope, call, registry } = fixture();
  const audit = registry.issue(scope, call);
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      Promise.resolve().then(() => registry.consume(audit.id, scope, call)),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    9,
  );
});

test("revocation is scoped by grant or node and repeated revocation is safe", () => {
  const { scope, call, registry } = fixture();
  const one = registry.issue(scope, call);
  const two = registry.issue(scope, { ...call, id: "call-2" });
  const otherScope = { ...scope, nodeId: "other-node" };
  const three = registry.issue(otherScope, call);
  registry.revoke(one.id);
  registry.revoke(one.id);
  assert.throws(() => registry.consume(one.id, scope, call), /已失效/);
  registry.revokeNode(scope.nodeId);
  assert.throws(
    () => registry.consume(two.id, scope, { ...call, id: "call-2" }),
    /已失效/,
  );
  assert.equal(registry.consume(three.id, otherScope, call).id, three.id);
});

test("persisted audit metadata cannot restore process-local authorization", () => {
  const { scope, call, registry } = fixture();
  const restored = JSON.parse(JSON.stringify(registry.issue(scope, call)));
  const restartedRegistry = new ToolAuthorizationRegistry(() => 1000, 100);
  assert.throws(
    () => restartedRegistry.consume(restored.id, scope, call),
    /不存在/,
  );
});

test("non-JSON inputs cannot be issued and accessors are never invoked", () => {
  const { scope, call, registry } = fixture();
  let reads = 0;
  const getter = {
    get content() {
      reads += 1;
      return "unsafe";
    },
  };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const hidden = Object.defineProperty({}, "secret", { value: "hidden" });
  const symbolKey = { [Symbol("secret")]: "hidden" };
  const arrayWithProperty = Object.assign([1], { extra: "hidden" });
  const values = [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol("secret"),
    () => "value",
    new Date(),
    new Map(),
    Buffer.from("value"),
    cycle,
    getter,
    hidden,
    symbolKey,
    arrayWithProperty,
    new Array(2),
    [undefined],
    new Proxy({}, {}),
  ];
  for (const value of values) {
    assert.throws(
      () => registry.issue(scope, { ...call, arguments: { value } }),
      /JSON/,
    );
  }
  assert.throws(
    () =>
      registry.issue(
        Object.defineProperty({ ...scope }, "nodeId", {
          get() {
            reads += 1;
            return "unsafe";
          },
        }),
        call,
      ),
    /JSON/,
  );
  assert.equal(reads, 0);
});

test("invalid consumption input still destroys the grant", () => {
  const { scope, call, registry } = fixture();
  const audit = registry.issue(scope, call);
  assert.throws(
    () => registry.consume(audit.id, scope, { ...call, arguments: { x: NaN } }),
    /JSON/,
  );
  assert.throws(() => registry.consume(audit.id, scope, call), /已使用/);
});

test("invalid authorization TTL and clock values fail closed", () => {
  for (const ttl of [0, -1, NaN, Infinity, 0.5]) {
    assert.throws(() => new ToolAuthorizationRegistry(Date.now, ttl), /有效期/);
  }
  const { scope, call } = fixture();
  for (const now of [NaN, Infinity, -1, 0.5]) {
    const registry = new ToolAuthorizationRegistry(() => now);
    assert.throws(() => registry.issue(scope, call), /时间来源/);
  }
  assert.throws(
    () =>
      new ToolAuthorizationRegistry(() => Number.MAX_SAFE_INTEGER).issue(
        scope,
        call,
      ),
    /过期时间/,
  );
});
