import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentRun } from "../shared/types";
import { subagentCurves } from "./math-curve-loaders";
import {
  assignSubagentCurves,
  getSubagentCurves,
  subagentLoadingKey,
} from "./subagent-loading";

const child = (
  id: string,
  status: SubagentRun["status"] = "running",
): SubagentRun => ({
  id,
  agent: "worker",
  status,
  task: id,
  response: "",
  model: "test/model",
  createdAt: 1,
});

test("eight concurrent agents use the entire reference pool without duplicates", () => {
  const runs = Array.from({ length: 8 }, (_, i) =>
    child(String(i), i % 2 ? "running" : "queued"),
  );
  const first = assignSubagentCurves(runs, undefined, () => 0);
  const last = assignSubagentCurves(runs, undefined, () => 0.999);
  assert.deepEqual(new Set(first.values()), new Set(subagentCurves));
  assert.notEqual(
    first.get(subagentLoadingKey(runs[0])),
    last.get(subagentLoadingKey(runs[0])),
  );
  const reordered = assignSubagentCurves([...runs].reverse(), first, () => {
    throw new Error("Existing choices must remain stable");
  });
  assert.deepEqual(reordered, first);
});

test("finishing frees a slot without changing the remaining active agents", () => {
  const runs = Array.from({ length: 8 }, (_, i) => child(String(i)));
  const initial = assignSubagentCurves(runs);
  const nextRuns = [
    ...runs.slice(1),
    { ...runs[0], status: "completed" as const },
    child("new"),
  ];
  const next = assignSubagentCurves(nextRuns, initial);
  assert.equal(next.size, 8);
  assert.equal(new Set(next.values()).size, 8);
  for (const run of runs.slice(1))
    assert.equal(
      next.get(subagentLoadingKey(run)),
      initial.get(subagentLoadingKey(run)),
    );
  assert.equal(
    next.get(subagentLoadingKey(nextRuns.at(-1)!)),
    initial.get(subagentLoadingKey(runs[0])),
  );
  for (const status of ["completed", "failed", "cancelled"] as const)
    assert.equal(assignSubagentCurves([child(status, status)]).size, 0);
});

test("overflow is balanced and becomes unique again when concurrency falls to eight", () => {
  const runs = Array.from({ length: 19 }, (_, i) => child(String(i)));
  const choices = assignSubagentCurves(runs);
  const counts = subagentCurves.map(
    (curve) => [...choices.values()].filter((value) => value === curve).length,
  );
  assert.equal(choices.size, 19);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
  const smaller = assignSubagentCurves(
    runs.filter((_, i) => i % 2 === 0).slice(0, 8),
    choices,
  );
  assert.equal(new Set(smaller.values()).size, 8);
});

test("inspector remounts retain choices and a reused run id has a new identity", () => {
  const runs = [child("a"), child("b")];
  const choices = getSubagentCurves("remount-test", runs);
  assert.deepEqual(getSubagentCurves("remount-test", runs), choices);
  const restarted = { ...runs[0], createdAt: 2 };
  assert.notEqual(subagentLoadingKey(restarted), subagentLoadingKey(runs[0]));
});
