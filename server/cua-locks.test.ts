import assert from "node:assert/strict";
import test from "node:test";
import { CuaLocks, cuaTargetsConflict, type CuaTarget } from "./cua-locks.ts";

const window = (windowId: number | string, pid = 100): CuaTarget => ({
  kind: "window",
  pid,
  windowId,
});
const page = (tabId: number | string, windowId = 1): CuaTarget => ({
  kind: "page",
  pid: 100,
  windowId,
  tabId,
});

async function pending(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "request should remain queued");
}

test("native windows conflict with all their pages, while CDP pages remain independent", () => {
  assert.equal(cuaTargetsConflict(window(1), window("1")), true);
  assert.equal(cuaTargetsConflict(window(1), window(2)), false);
  assert.equal(cuaTargetsConflict(window(1), window(1, 200)), false);
  assert.equal(cuaTargetsConflict(window(1), page("a")), true);
  assert.equal(cuaTargetsConflict(page("a"), window(1)), true);
  assert.equal(cuaTargetsConflict(page("a"), page("a")), true);
  assert.equal(cuaTargetsConflict(page("a"), page("b")), false);
  assert.equal(cuaTargetsConflict(page("a"), page("a", 2)), false);
});

test("leases protect reasoning between calls and allow separate windows of one app in parallel", async () => {
  const locks = new CuaLocks();
  await locks.acquireTarget("a", window(1));
  const finishObservation = await locks.acquireOperation("a", "background");
  finishObservation();
  const competing = locks.acquireTarget("b", window(1));
  await pending(competing);
  await locks.acquireTarget("c", window(2));
  const finishC = await locks.acquireOperation("c", "background");
  const finishAction = await locks.acquireOperation("a", "background");
  finishAction();
  await pending(competing);
  locks.releaseOwner("a");
  await competing;
  finishC();
  locks.releaseOwner("b");
  locks.releaseOwner("c");
});

test("CDP pages can run together but cannot bypass an earlier whole-window waiter", async () => {
  const locks = new CuaLocks();
  await locks.acquireTarget("a", page("a"));
  await locks.acquireTarget("b", page("b"));
  const finishA = await locks.acquireOperation("a", "background");
  const finishB = await locks.acquireOperation("b", "background");
  const wholeWindow = locks.acquireTarget("window", window(1));
  const anotherPage = locks.acquireTarget("c", page("c"));
  await pending(wholeWindow);
  await pending(anotherPage);
  finishA();
  finishB();
  locks.releaseOwner("a");
  await pending(wholeWindow);
  locks.releaseOwner("b");
  await wholeWindow;
  await pending(anotherPage);
  locks.releaseOwner("window");
  await anotherPage;
  locks.releaseOwner("c");
});

test("conflicting leases acquire in FIFO order while independent windows bypass the queue", async () => {
  const locks = new CuaLocks();
  await locks.acquireTarget("a", window(1));
  const acquired: string[] = [];
  const b = locks.acquireTarget("b", window(1)).then(() => acquired.push("b"));
  const c = locks.acquireTarget("c", window(1)).then(() => acquired.push("c"));
  await locks.acquireTarget("independent", window(2));
  locks.releaseOwner("a");
  await b;
  assert.deepEqual(acquired, ["b"]);
  await pending(c);
  locks.releaseOwner("b");
  await c;
  assert.deepEqual(acquired, ["b", "c"]);
  locks.releaseOwner("c");
  locks.releaseOwner("independent");
});

test("two owners swapping windows do not deadlock or retain their previous targets", async () => {
  const locks = new CuaLocks();
  await locks.acquireTarget("a", window(1));
  await locks.acquireTarget("b", window(2));
  const aSwitch = locks.acquireTarget("a", window(2));
  await pending(aSwitch);
  assert.equal(locks.getTarget("a"), undefined);
  await locks.acquireTarget("b", window(1));
  await aSwitch;
  assert.equal(locks.getTarget("a")?.windowId, "2");
  assert.equal(locks.getTarget("b")?.windowId, "1");
  locks.releaseOwner("a");
  locks.releaseOwner("b");
});

test("target switching and release cannot invalidate queued or active operations", async () => {
  const locks = new CuaLocks();
  await locks.acquireTarget("a", window(1));
  const finishGlobal = await locks.acquireOperation("global", "exclusive");
  const waiting = locks.acquireOperation("a", "background");
  await locks.acquireTarget("a", window(1));
  await assert.rejects(
    locks.acquireTarget("a", window(2)),
    /pending or active/,
  );
  assert.throws(() => locks.releaseTarget("a"), /pending or active/);
  finishGlobal();
  const finishA = await waiting;
  await assert.rejects(
    locks.acquireTarget("a", window(2)),
    /pending or active/,
  );
  assert.throws(() => locks.releaseTarget("a"), /pending or active/);
  finishA();
  locks.releaseTarget("a");
  await assert.rejects(
    locks.acquireOperation("a", "background"),
    /target lease/,
  );
});

test("exclusive operations drain backgrounds, prevent starvation, and retain idle target leases", async () => {
  const locks = new CuaLocks();
  await locks.acquireTarget("a", window(1));
  await locks.acquireTarget("b", window(2));
  await locks.acquireTarget("c", window(3));
  const finishA = await locks.acquireOperation("a", "background");
  const finishB = await locks.acquireOperation("b", "background");
  const global = locks.acquireOperation("global", "exclusive");
  const c = locks.acquireOperation("c", "background");
  await pending(global);
  await pending(c);
  finishA();
  await pending(global);
  finishB();
  const finishGlobal = await global;
  await pending(c);
  assert.equal(locks.getTarget("a")?.windowId, "1");
  assert.equal(locks.getTarget("b")?.windowId, "2");
  finishGlobal();
  (await c)();
  for (const owner of ["a", "b", "c", "global"]) locks.releaseOwner(owner);
});

test("same-owner operations serialize even when all are background calls", async () => {
  const locks = new CuaLocks();
  await locks.acquireTarget("a", window(1));
  await locks.acquireTarget("b", window(2));
  const first = await locks.acquireOperation("a", "background");
  const second = locks.acquireOperation("a", "background");
  const third = locks.acquireOperation("a", "background");
  (await locks.acquireOperation("b", "background"))();
  await pending(second);
  first();
  const finishSecond = await second;
  await pending(third);
  finishSecond();
  (await third)();
  locks.releaseOwner("a");
  locks.releaseOwner("b");
});

test("aborted target waits leave the queue and clear their waiting indicator", async () => {
  const locks = new CuaLocks();
  await locks.acquireTarget("a", page("a"));
  const controller = new AbortController();
  const notices: (string | undefined)[] = [];
  const wholeWindow = locks.acquireTarget(
    "window",
    window(1),
    controller.signal,
    (reason) => {
      notices.push(reason);
    },
  );
  const rejection = assert.rejects(wholeWindow, /cancel target/);
  const otherPage = locks.acquireTarget("b", page("b"));
  await pending(otherPage);
  controller.abort(new Error("cancel target"));
  await rejection;
  await otherPage;
  assert.equal(notices.length, 2);
  assert.equal(typeof notices[0], "string");
  assert.equal(notices[1], undefined);
  assert.equal(locks.getTarget("window"), undefined);
  locks.releaseOwner("a");
  locks.releaseOwner("b");
});

test("aborted exclusive wait stops blocking unrelated background calls", async () => {
  const locks = new CuaLocks();
  await locks.acquireTarget("a", window(1));
  await locks.acquireTarget("b", window(2));
  const finishA = await locks.acquireOperation("a", "background");
  const controller = new AbortController();
  const notices: (string | undefined)[] = [];
  const global = locks.acquireOperation(
    "global",
    "exclusive",
    controller.signal,
    (reason) => {
      notices.push(reason);
    },
  );
  const rejection = assert.rejects(global, /cancel global/);
  const b = locks.acquireOperation("b", "background");
  await pending(b);
  controller.abort(new Error("cancel global"));
  await rejection;
  (await b)();
  assert.equal(notices.length, 2);
  assert.equal(notices[1], undefined);
  finishA();
  locks.releaseOwner("a");
  locks.releaseOwner("b");
});

test("already-aborted requests do not change a retained target or start global work", async () => {
  const locks = new CuaLocks();
  await locks.acquireTarget("a", window(1));
  const signal = AbortSignal.abort(new Error("already canceled"));
  await assert.rejects(
    locks.acquireTarget("a", window(2), signal),
    /already canceled/,
  );
  assert.equal(locks.getTarget("a")?.windowId, "1");
  await assert.rejects(
    locks.acquireOperation("global", "exclusive", signal),
    /already canceled/,
  );
  (await locks.acquireOperation("a", "background"))();
  locks.releaseOwner("a");
});

test("releaseOwner cancels queued operations but keeps an aborted running call's lease and permit", async () => {
  const locks = new CuaLocks();
  const controller = new AbortController();
  await locks.acquireTarget("a", window(1), controller.signal);
  const finishA = await locks.acquireOperation(
    "a",
    "background",
    controller.signal,
  );
  const anotherCall = locks.acquireOperation("a", "background");
  const rejectedCall = assert.rejects(anotherCall, { name: "AbortError" });
  const successor = locks.acquireTarget("b", window(1));
  const global = locks.acquireOperation("global", "exclusive");
  controller.abort(new Error("driver may ignore abort"));
  locks.releaseOwner("a");
  await rejectedCall;
  assert.equal(locks.getTarget("a")?.windowId, "1");
  await pending(successor);
  await pending(global);
  await assert.rejects(
    locks.acquireOperation("a", "background"),
    /being released/,
  );
  finishA();
  finishA(); // Releases must be idempotent.
  await successor;
  (await global)();
  assert.equal(locks.getTarget("a"), undefined);
  locks.releaseOwner("b");
});

test("releaseOwner cancels a pending target and clears its observer before freeing the queue", async () => {
  const locks = new CuaLocks();
  await locks.acquireTarget("a", window(1));
  const notices: (string | undefined)[] = [];
  const b = locks.acquireTarget("b", window(1), undefined, (reason) =>
    notices.push(reason),
  );
  const rejected = assert.rejects(b, { name: "AbortError" });
  const c = locks.acquireTarget("c", window(1));
  locks.releaseOwner("b");
  await rejected;
  assert.equal(notices[1], undefined);
  locks.releaseOwner("a");
  await c;
  locks.releaseOwner("c");
  locks.releaseOwner("unknown");
});

test("acquisition clears waiting indicators and observer errors cannot strand leases", async () => {
  const locks = new CuaLocks();
  await locks.acquireTarget("a", window(1));
  const notices: (string | undefined)[] = [];
  const b = locks.acquireTarget("b", window(1), undefined, (reason) => {
    notices.push(reason);
    throw new Error("UI observer failed");
  });
  locks.releaseOwner("a");
  await b;
  assert.equal(notices.length, 2);
  assert.equal(notices[1], undefined);
  const finishGlobal = await locks.acquireOperation("global", "exclusive");
  const operationNotices: (string | undefined)[] = [];
  const operation = locks.acquireOperation(
    "b",
    "background",
    undefined,
    (reason) => {
      operationNotices.push(reason);
    },
  );
  finishGlobal();
  (await operation)();
  assert.equal(operationNotices.length, 2);
  assert.equal(operationNotices[1], undefined);
  locks.releaseOwner("b");
});

test("target identity is copied and validated, and unknown owners cannot operate in background", async () => {
  const locks = new CuaLocks();
  const target = window(1);
  await locks.acquireTarget("a", target);
  target.windowId = 2;
  const returned = locks.getTarget("a")!;
  returned.windowId = 3;
  assert.equal(locks.getTarget("a")?.windowId, "1");
  await assert.rejects(
    locks.acquireOperation("unknown", "background"),
    /target lease/,
  );
  await assert.rejects(locks.acquireTarget("", window(1)), /owner ID/);
  await assert.rejects(
    locks.acquireTarget("b", window(1, Number.NaN)),
    /identity/,
  );
  await assert.rejects(locks.acquireTarget("b", page("")), /identity/);
  await assert.rejects(
    locks.acquireOperation("b", "wrong" as "background"),
    /mode/,
  );
  locks.releaseOwner("a");
});

test("queued ownership cannot be bypassed by starting an untargeted operation", async () => {
  const locks = new CuaLocks();
  await locks.acquireTarget("a", window(1));
  const b = locks.acquireTarget("b", window(1));
  await assert.rejects(
    locks.acquireOperation("b", "exclusive"),
    /waiting for its target/,
  );
  await assert.rejects(
    locks.acquireTarget("b", window(2)),
    /pending or active/,
  );
  locks.releaseOwner("a");
  await b;
  locks.releaseOwner("b");
});
