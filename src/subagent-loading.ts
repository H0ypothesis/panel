import type { SubagentRun } from "../shared/types";
import { subagentCurves, type SubagentCurve } from "./math-curve-loaders";

export function subagentLoadingKey(run: SubagentRun) {
  return JSON.stringify([run.id, run.createdAt]);
}

/** Retain each active agent's choice, releasing slots as agents finish. */
export function assignSubagentCurves(
  runs: SubagentRun[],
  previous: ReadonlyMap<string, SubagentCurve> = new Map(),
  random: () => number = Math.random,
) {
  const active = runs.filter(
    (run) => run.status === "running" || run.status === "queued",
  );
  const result = new Map<string, SubagentCurve>();
  const counts = new Map(subagentCurves.map((curve) => [curve, 0]));

  // Preserve unique choices first. If an overflowing group shrinks, duplicates
  // can use the newly freed slots without changing the other agents' animations.
  for (const run of active) {
    const key = subagentLoadingKey(run);
    const curve = previous.get(key);
    if (curve && counts.get(curve) === 0) {
      result.set(key, curve);
      counts.set(curve, 1);
    }
  }
  for (const run of active) {
    const key = subagentLoadingKey(run);
    if (result.has(key)) continue;
    const leastUsed = Math.min(...counts.values());
    const available = subagentCurves.filter(
      (curve) => counts.get(curve) === leastUsed,
    );
    const retained = previous.get(key);
    const curve =
      retained && available.includes(retained)
        ? retained
        : available[Math.floor(random() * available.length)];
    result.set(key, curve);
    counts.set(curve, counts.get(curve)! + 1);
  }
  return result;
}

// Keep choices across inspector tab changes and remounts, with bounded storage.
const groups = new Map<string, Map<string, SubagentCurve>>();
export function getSubagentCurves(scope: string, runs: SubagentRun[]) {
  const choices = assignSubagentCurves(runs, groups.get(scope));
  groups.delete(scope);
  groups.set(scope, choices);
  if (groups.size > 128) groups.delete(groups.keys().next().value!);
  return choices;
}
