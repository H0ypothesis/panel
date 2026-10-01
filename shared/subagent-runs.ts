import type { SubagentRun } from "./types";

export interface SubagentThread extends SubagentRun {
  executions: SubagentRun[];
  runIds: string[];
}

export function isWorkflowRun(run: SubagentRun) {
  return run.agent === "workflow" && run.id.startsWith("native:");
}

/** Only a verified recovery edge can join executions; role/task similarity cannot. */
export function recoverySource(run: SubagentRun, runs: SubagentRun[]) {
  const original =
    run.task.startsWith(
      "Task: You are reviving a previous subagent conversation.",
    ) ||
    run.task.startsWith("You are reviving a previous subagent conversation.")
      ? run.task.match(/^Original run: (.+)$/m)?.[1]?.trim()
      : undefined;
  return runs.find(
    (candidate) =>
      candidate.id !== run.id &&
      candidate.agent === run.agent &&
      !!run.sessionFile &&
      candidate.sessionFile === run.sessionFile &&
      candidate.createdAt <= run.createdAt &&
      (run.resumedFrom
        ? candidate.id === run.resumedFrom
        : !!original && candidate.nativeRunId === original),
  );
}

export function subagentThreads(runs: SubagentRun[] = []): SubagentThread[] {
  runs = runs.filter(
    (run) =>
      isWorkflowRun(run) ||
      !run.id.startsWith("native:") ||
      !runs.some(
        (other) =>
          !other.id.startsWith("native:") &&
          other.nativeRunId === run.nativeRunId,
      ),
  );
  const roots = new Map<string, SubagentRun[]>();
  for (const run of runs) {
    let root = run;
    const seen = new Set([run.id]);
    for (;;) {
      const source = recoverySource(root, runs);
      if (!source || seen.has(source.id)) break;
      seen.add(source.id);
      root = source;
    }
    const executions = roots.get(root.id) ?? [];
    executions.push(run);
    roots.set(root.id, executions);
  }
  return [...roots.values()].map((executions) => {
    executions.sort((a, b) => a.createdAt - b.createdAt);
    const first = executions[0],
      latest = executions.at(-1)!;
    return {
      ...latest,
      id: first.id,
      task: first.task,
      createdAt: first.createdAt,
      response: executions
        .map((run) => run.response)
        .filter(Boolean)
        .join("\n\n"),
      usage: executions.some((run) => run.usage)
        ? executions.reduce(
            (sum, run) => ({
              input: sum.input + (run.usage?.input ?? 0),
              output: sum.output + (run.usage?.output ?? 0),
              total: sum.total + (run.usage?.total ?? 0),
              cost: sum.cost + (run.usage?.cost ?? 0),
            }),
            { input: 0, output: 0, total: 0, cost: 0 },
          )
        : undefined,
      executions,
      runIds: executions.map((run) => run.id),
    };
  });
}

export function subagentStatusLabel(run: SubagentRun) {
  if (
    run.stopReason === "timeout" ||
    /exceeded its timeout|timed[ -]?out|执行超时/i.test(run.error ?? "")
  )
    return "执行超时";
  if (run.stopReason === "interrupted") return "已暂停";
  return {
    queued: "排队中",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
    cancelled: run.stopReason === "user" ? "已停止" : "已中断",
  }[run.status];
}
