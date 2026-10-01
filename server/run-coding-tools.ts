import { randomUUID } from "node:crypto";
import { createPanelTools } from "./coding-tools.ts";
import type { RunEnvironment } from "./runtime.ts";
import type { SandboxNetworkRequest } from "./sandbox-policy.ts";
import { checkSandbox, type SandboxCheck } from "./sandbox.ts";

const permissions = new WeakMap<
  RunEnvironment,
  Map<string, Promise<boolean>>
>();
const checks = new WeakMap<
  RunEnvironment,
  Map<string, Promise<SandboxCheck>>
>();

export function startSandboxPreflight(
  cwd: string,
  environment: RunEnvironment,
  subagentId?: string,
  signal?: AbortSignal,
) {
  const checkKey = JSON.stringify([
    environment.sandboxPermissionScope?.(),
    cwd,
    subagentId,
  ]);
  let runChecks = checks.get(environment);
  if (!runChecks) {
    runChecks = new Map();
    checks.set(environment, runChecks);
  }
  let preflight = runChecks.get(checkKey);
  if (!preflight) {
    // Start while the model prepares its first tool call, rather than waiting
    // until the first shell invocation to discover missing dependencies.
    preflight = checkSandbox(cwd, signal);
    void preflight.catch(() => {});
    runChecks.set(checkKey, preflight);
  }
  return preflight;
}

export function createRunCodingTools(
  cwd: string,
  environment: RunEnvironment,
  subagentId?: string,
  signal?: AbortSignal,
) {
  const preflight = startSandboxPreflight(cwd, environment, subagentId, signal);
  let grants = permissions.get(environment);
  if (!grants) {
    grants = new Map();
    permissions.set(environment, grants);
  }
  const allowed = grants;
  return createPanelTools(
    cwd,
    async (request: SandboxNetworkRequest, signal) => {
      signal?.throwIfAborted();
      const scope = environment.sandboxPermissionScope?.();
      const key = JSON.stringify([
        scope,
        request.workingDirectory,
        request.host,
        request.port,
      ]);
      const previous = allowed.get(key);
      if (previous) return previous;
      const approve = (async () => {
        const call = {
          id: `sandbox-network:${randomUUID()}`,
          name: "sandbox_network",
          arguments: {
            ...request,
            port: request.port ?? 443,
            authorizationScope: "本轮同一工作目录到此 host/port 的网络连接",
          },
          workingDirectory: request.workingDirectory,
          ...(subagentId ? { subagentId } : {}),
        };
        if (!(await environment.beforeToolCall(call, undefined, signal)))
          return false;
        await environment.executeTool(
          call,
          async () => {
            signal?.throwIfAborted();
            if (scope !== environment.sandboxPermissionScope?.())
              throw new Error("审批设置已改变，网络授权失效。");
            environment.onToolUpdate(call.id, {
              status: "completed",
              output: `已允许本轮访问 ${request.host}:${request.port ?? 443}；命令继续执行。`,
            });
          },
          signal,
        );
        return true;
      })().catch((error) => {
        allowed.delete(key);
        throw error;
      });
      allowed.set(key, approve);
      const result = await approve;
      if (!result) allowed.delete(key);
      return result;
    },
    {
      preflight,
      ...(environment.recoverSandbox
        ? {
            recover: (request, execute, recoverySignal) =>
              environment.recoverSandbox!(
                { ...request, ...(subagentId ? { subagentId } : {}) },
                execute,
                recoverySignal,
              ),
          }
        : {}),
    },
  );
}
