import { homedir } from "node:os";
import { readdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";

export const SANDBOX_POLICY_VERSION = "panel-sandbox-v1";
export const SANDBOX_TOOL_NAMES = new Set(["read", "write", "edit", "bash"]);

export interface SandboxScope {
  policyVersion: string;
  workingDirectory: string;
}
export interface SandboxNetworkRequest {
  host: string;
  port?: number;
  command: string;
  workingDirectory: string;
}

function contains(parent: string, child: string) {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function workspaceStorageException(root: string, path: string) {
  const state = storageDirectory();
  const workspaces = join(state, "workspaces");
  return path === state && root !== workspaces && contains(workspaces, root);
}

function storageDirectory() {
  const path = resolve(process.env.PANEL_DATA_DIR ?? ".panel");
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function assertSandboxWorkspace(root: string) {
  for (const denied of protectedPaths(root)) {
    if (workspaceStorageException(root, denied)) continue;
    if (contains(denied, root))
      throw new Error("凭证或 Panel 状态目录不能作为编码工作目录。");
  }
}

export function protectedPaths(root: string) {
  return [
    ".ssh",
    ".aws",
    ".gnupg",
    ".codex",
    ".kube",
    ".git-credentials",
    ".npmrc",
    ".netrc",
    ".pypirc",
    ".docker/config.json",
    ".pi/agent/auth.json",
    ".config/gcloud",
    "Library/Keychains",
  ]
    .map((path) => join(homedir(), path))
    .concat([storageDirectory(), join(root, ".panel")]);
}

export function assertSandboxFilePath(
  root: string,
  path: string,
  writing = false,
) {
  const inside = relative(root, path);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new Error("文件路径超出当前工作目录。");
  const name = basename(path).toLowerCase();
  if (isCredentialName(name))
    throw new Error("沙盒禁止访问凭证文件；请使用不含秘密的普通配置文件。");
  for (const denied of protectedPaths(root)) {
    if (workspaceStorageException(root, denied)) continue;
    const rel = relative(denied, path);
    if (
      rel === "" ||
      (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
    )
      throw new Error("沙盒禁止访问 Panel 状态或凭证目录。");
  }
  const artifact = [".pi/subagents/artifacts", ".pi/subagents/handoffs"].some(
    (directory) => contains(join(root, directory), path),
  );
  if (
    writing &&
    ((!artifact && contains(join(root, ".pi"), path)) ||
      [".git/hooks", ".git/config"].some((name) =>
        contains(join(root, name), path),
      ))
  )
    throw new Error("沙盒禁止修改工具安全配置和 Git 执行配置。");
}

function isCredentialName(name: string) {
  return (
    /^(\.env)(\.|$)/i.test(name) ||
    /\.(pem|key)$/i.test(name) ||
    [".npmrc", ".netrc", ".pypirc", ".git-credentials"].includes(
      name.toLowerCase(),
    )
  );
}

export async function sandboxConfig(
  root: string,
  temporary: string,
): Promise<SandboxRuntimeConfig> {
  assertSandboxWorkspace(root);
  // Linux write rules accept concrete paths, not globs. Enumerate existing
  // credential files for both platforms; macOS also denies future matching paths.
  const credentials: string[] = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (isCredentialName(entry.name)) credentials.push(path);
      else if (
        entry.isDirectory() &&
        !["node_modules", ".git", ".panel", ".pi"].includes(entry.name)
      )
        pending.push(path);
    }
  }
  const secrets = [
    ...credentials,
    ...[
      ".env",
      ".env.*",
      "**/.env",
      "**/.env.*",
      "**/*.pem",
      "**/*.key",
      ".npmrc",
      ".netrc",
      ".pypirc",
      ".git-credentials",
    ].map((name) => join(root, name)),
  ];
  return {
    network: {
      allowedDomains: [],
      deniedDomains: ["localhost", "127.0.0.1", "[::1]", "169.254.169.254"],
      deniedResolvedAddresses: [
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "100.64.0.0/10",
        "198.18.0.0/15",
        "fc00::/7",
      ],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead: [...protectedPaths(root), ...secrets],
      allowRead: [root],
      allowWrite: [root, temporary],
      denyWrite: [
        ...protectedPaths(root).filter(
          (path) => !workspaceStorageException(root, path),
        ),
        "/tmp/claude",
        "/private/tmp/claude",
        join(homedir(), ".npm/_logs"),
        join(homedir(), ".claude/debug"),
        ...[
          ".git/hooks",
          ".git/config",
          ".pi/settings.json",
          ".pi/extensions",
          ".pi/skills",
          ".pi/prompts",
          ".pi/agents",
          ".pi/sandbox.json",
          ".pi/mcp.json",
        ].map((name) => join(root, name)),
        ...secrets,
      ],
    },
  };
}
