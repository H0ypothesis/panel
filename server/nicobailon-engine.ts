// Pinned upstream internals. Keep discovery, profile semantics and child hooks
// together so Panel does not implement a competing agent configuration format.
export { runSync } from "../node_modules/pi-subagents/src/runs/foreground/execution.js";
export {
  discoverAgents,
  clearAgentDiscoveryCache,
  resolveAgentName,
  findBlockingAgentDiagnostic,
} from "../node_modules/pi-subagents/src/agents/agents.js";
export type { AgentConfig } from "../node_modules/pi-subagents/src/agents/agents.js";
export {
  setChildSessionFactory,
  setChildSessionFactoryModule,
} from "../node_modules/pi-subagents/src/runs/shared/child-session.js";
export { createHerdrPiSession } from "../node_modules/pi-subagents/src/runs/shared/herdr-placed-run.js";
export { createSubagentParamsSchema } from "../node_modules/pi-subagents/src/extension/schemas.js";
export { buildSubagentToolDescription } from "../node_modules/pi-subagents/src/extension/tool-description.js";
export async function loadNativeSubagentExtension() {
  return (await import("../node_modules/pi-subagents/src/extension/index.js"))
    .default;
}
export { createDefaultChildSessionFactory } from "../node_modules/pi-subagents/src/runs/shared/child-session.js";
export type {
  ChildSessionFactory,
  ChildSessionLaunch,
  ChildSession,
  ParentProviderRegistry,
} from "../node_modules/pi-subagents/src/runs/shared/child-session.js";
export * as piSdk from "@earendil-works/pi-coding-agent";
export { planChildLaunch } from "../node_modules/pi-subagents/src/runs/shared/child-launch-plan.js";
export { injectSingleOutputInstruction } from "../node_modules/pi-subagents/src/runs/shared/single-output.js";
export { resolveExistingReadPaths } from "../node_modules/pi-subagents/src/shared/settings.js";
export { createStructuredOutputRuntime } from "../node_modules/pi-subagents/src/runs/shared/structured-output.js";
export { AuthStorage } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
export { validateToolBudgetConfig } from "../node_modules/pi-subagents/src/runs/shared/tool-budget.js";
export {
  captureSingleOutputSnapshot,
  hasSingleOutputChangedSinceSnapshot,
} from "../node_modules/pi-subagents/src/runs/shared/single-output.js";
export {
  resolveSkillsWithFallback,
  clearSkillCache,
} from "../node_modules/pi-subagents/src/agents/skills.js";
