// Pinned internal entry: the upstream foreground executor exposes a per-run
// ChildSessionFactory. Panel supplies that factory so child tools retain its
// model configuration, approval grants and file audit instead of using Pi's CLI.
export { runSync } from "../node_modules/pi-subagents/src/runs/foreground/execution.js";
export type { AgentConfig } from "../node_modules/pi-subagents/src/agents/agents.js";
export type { ChildSessionFactory } from "../node_modules/pi-subagents/src/runs/shared/child-session.js";
