import { join, delimiter } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import type { AgentConfig } from "./nicobailon-engine.ts";
import { loadNicobailon } from "./nicobailon-loader.ts";
import excludedProfiles from "./subagent-exclusions.json" with { type: "json" };
import type {
  SubagentCatalog,
  SubagentProfile,
} from "../shared/subagent-profiles.ts";

// Apply the same removals to settings, model discovery and execution, including
// when reinstalling the upstream package restores its bundled definition files.
const excludedNames = new Set(excludedProfiles);

export function profileDiagnostics(
  agent: AgentConfig,
  native = false,
): string[] {
  const issues: string[] = [];
  if (!native && agent.runner)
    issues.push("此角色使用外部 CLI runner；Panel 当前仅支持 Pi 前台子会话。");
  if (!native && agent.machine)
    issues.push("此角色要求远程 machine，Panel 尚未连接远程子代理运行器。");
  if (!native && agent.defaultAsync)
    issues.push("此角色要求后台运行，Panel 当前会话不能脱离卡片运行。");
  if (!native && agent.interactive)
    issues.push("此角色要求交互式终端，Panel 子会话使用无终端模式。");
  if (
    !native &&
    (agent.allowNestedSubagents || agent.tools?.includes("subagent"))
  )
    issues.push(
      "此角色启用了嵌套委派；Panel 当前只支持由主模型委派，以保持全局并发与审批边界。",
    );
  if (agent.tools?.includes("powershell"))
    issues.push("powershell 尚未接入 Panel 的命令环境，请使用 bash。");
  if (!native && agent.mcpDirectTools?.length)
    issues.push("mcpDirectTools 需要插件的后台运行模式。");
  return issues;
}
export function presentProfile(
  agent: AgentConfig,
  native = false,
): SubagentProfile {
  const diagnostics = profileDiagnostics(agent, native);
  const builtins = new Set([
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "find",
    "ls",
    "web_search",
    "fetch_content",
    "get_search_content",
    "source_check",
    "contact_supervisor",
    "watchdog_diff",
    "structured_output",
    ...(native
      ? ["subagent", "bg_wait", "subagent_notify", "interactive_shell"]
      : []),
  ]);
  const missing =
    agent.tools?.filter(
      (name) => !builtins.has(name) && !agent.excludeTools?.includes(name),
    ) ?? [];
  if (
    missing.length &&
    !agent.extensions?.length &&
    !agent.subagentOnlyExtensions?.length
  )
    diagnostics.push(
      `需通过 extensions 配置工具提供者：${missing.join(", ")}。启动时会校验实际加载结果。`,
    );
  return {
    name: agent.name,
    description: agent.description,
    source: agent.source,
    filePath: agent.filePath,
    model: agent.model,
    thinking: agent.thinking,
    tools: agent.tools,
    excludeTools: agent.excludeTools,
    skills: agent.skills,
    extensions: [
      ...(agent.extensions ?? []),
      ...(agent.subagentOnlyExtensions ?? []),
    ],
    systemPromptMode: agent.systemPromptMode,
    inheritProjectContext: agent.inheritProjectContext,
    inheritGlobalContext: agent.inheritGlobalContext,
    inheritSkills: agent.inheritSkills,
    diagnostics,
  };
}
export async function discoverSubagentProfiles(
  cwd: string,
  preferredProvider?: string,
) {
  const engine = await loadNicobailon();
  engine.clearAgentDiscoveryCache();
  engine.clearSkillCache();
  const found = engine.discoverAgents(cwd, "both", preferredProvider);
  return {
    ...found,
    agents: found.agents.filter((agent) => !excludedNames.has(agent.name)),
  };
}
export async function subagentCatalog(
  cwd: string,
  nativeDirectory?: string,
): Promise<SubagentCatalog> {
  const engine = await loadNicobailon();
  const previous = process.env.PI_CODING_AGENT_DIR;
  const extras = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
  let found: Awaited<ReturnType<typeof discoverSubagentProfiles>>;
  try {
    if (nativeDirectory && existsSync(join(nativeDirectory, "settings.json"))) {
      process.env.PI_CODING_AGENT_DIR = nativeDirectory;
      process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = [
        join(previous ?? join(homedir(), ".pi", "agent"), "agents"),
        extras,
      ]
        .filter(Boolean)
        .join(delimiter);
    }
    engine.clearAgentDiscoveryCache();
    found = engine.discoverAgents(cwd, "both");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (extras === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
    else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = extras;
    engine.clearAgentDiscoveryCache();
  }
  return {
    profiles: found.agents
      .filter((agent) => !excludedNames.has(agent.name))
      .map((agent) => presentProfile(agent, !!nativeDirectory)),
    diagnostics: found.agentDiagnostics ?? [],
  };
}
