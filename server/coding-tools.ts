import type { AgentTool } from "@earendil-works/pi-agent-core";
import { realpathSync, statSync } from "node:fs";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { TSchema } from "typebox";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
  type Context,
} from "../pi/packages/agent/src/harness/context.ts";
import { NodeExecutionEnv } from "../pi/packages/agent/src/harness/env/nodejs.ts";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type ExecutionToolContext,
} from "../pi/packages/agent/src/harness/tools/index.ts";
import {
  err,
  FileError,
  type AgentHarnessTool,
  type Result,
  type ShellExecOptions,
} from "../pi/packages/agent/src/harness/types.ts";
import type { JsonValue } from "../pi/packages/agent/src/harness/session/types.ts";
import { createShellEnvironment } from "./shell-environment.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  prepareSandbox,
  prepareSandboxWithRetry,
  type NetworkPermission,
  type PreparedSandbox,
  type SandboxCheck,
  type SandboxPreparation,
} from "./sandbox.ts";
import { SandboxSetupError, type SandboxRecovery } from "./sandbox-errors.ts";
import {
  assertSandboxFilePath,
  assertSandboxWorkspace,
  SANDBOX_POLICY_VERSION,
  type SandboxScope,
} from "./sandbox-policy.ts";

const DEFAULT_COMMAND_TIMEOUT = 120;
const MAX_COMMAND_TIMEOUT = 600;

// The Pi file mutation queue is scoped to an environment. Sharing it by canonical
// cwd serializes edits to the same file across concurrent Panel branches.
const environments = new Map<string, WorkspaceExecutionEnv>();
const sandboxTools = new WeakSet<object>();
const executionNotices = new WeakSet<object>();
/** Process-local control notice, consumed before it reaches the model. */
export function codingExecutionStartedNotice() {
  const notice = { content: [], details: undefined };
  executionNotices.add(notice);
  return notice;
}
export function isCodingExecutionStartedNotice(value: object) {
  return executionNotices.has(value);
}
export interface CodingSandboxOptions {
  preflight?: Promise<SandboxCheck>;
  recover?: SandboxRecovery;
  prepare?: SandboxPreparation;
}
const invocation = new AsyncLocalStorage<
  CodingSandboxOptions & {
    toolCallId: string;
    executionStarted?: () => void;
    requestNetwork?: NetworkPermission;
  }
>();

export function codingSandboxScope(
  tool: object | undefined,
  cwd: string,
): SandboxScope | undefined {
  if (tool && sandboxTools.has(tool))
    return {
      policyVersion: SANDBOX_POLICY_VERSION,
      workingDirectory: realpathSync(cwd),
    };
}

class WorkspaceExecutionEnv extends NodeExecutionEnv {
  private readonly root: string;

  constructor(root: string) {
    super({ cwd: root });
    this.root = root;
  }

  override async exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ) {
    const policy = invocation.getStore();
    const signal = context.abortSignal;
    let dispatched = false;
    let attempts = 0;
    let checked: SandboxCheck | undefined;
    let stage: "preflight" | "initialization" = "preflight";
    const validateRoot = async () => {
      signal?.throwIfAborted();
      if ((await realpath(this.root)) !== this.root)
        throw new Error("工作目录的实际路径已改变，命令未执行。");
      assertSandboxWorkspace(this.root);
    };
    const run = (
      execution: string,
      temporary: string,
      assertAuthorized?: () => void,
    ) => {
      signal?.throwIfAborted();
      assertAuthorized?.();
      dispatched = true;
      policy?.executionStarted?.();
      return super.exec(
        execution,
        {
          ...options,
          env: {
            ...createShellEnvironment(),
            TMPDIR: temporary,
            TMP: temporary,
            TEMP: temporary,
            npm_config_cache: resolve(temporary, "npm-cache"),
            XDG_CACHE_HOME: resolve(temporary, "cache"),
            PIP_CACHE_DIR: resolve(temporary, "pip-cache"),
          },
          inheritEnv: false,
        },
        context,
      );
    };
    const runSandbox = async (
      sandbox: PreparedSandbox,
      assertAuthorized?: () => void,
    ) => {
      try {
        if (!sandbox.alive())
          throw new SandboxSetupError(
            "worker_exit",
            "沙盒执行器已退出，命令未执行。",
          );
        return await run(sandbox.command, sandbox.temporary, assertAuthorized);
      } finally {
        await sandbox.close();
      }
    };
    const prepare = async () => {
      await validateRoot();
      stage = "initialization";
      const sandbox = await prepareSandboxWithRetry(
        policy?.prepare ?? prepareSandbox,
        command,
        this.root,
        signal,
        policy?.requestNetwork,
        () => attempts++,
      );
      // A successful explicit retry repairs this run's negative preflight
      // result, so later commands can use the sandbox without another prompt.
      if (checked) delete checked.error;
      return sandbox;
    };
    let failure: SandboxSetupError;
    try {
      await validateRoot();
      checked = await policy?.preflight;
      signal?.throwIfAborted();
      if (checked?.error) {
        attempts = checked.attempts;
        throw checked.error;
      }
      return await runSandbox(await prepare());
    } catch (error) {
      signal?.throwIfAborted();
      if (
        dispatched ||
        !(error instanceof SandboxSetupError) ||
        !policy?.recover
      )
        throw error;
      failure = error;
    }
    while (true) {
      signal?.throwIfAborted();
      try {
        return await policy.recover(
          {
            toolCallId: policy.toolCallId,
            command,
            workingDirectory: this.root,
            timeoutSeconds: options?.timeout ?? DEFAULT_COMMAND_TIMEOUT,
            reason: failure.message,
            attempts,
            stage,
          },
          async (action, assertAuthorized) => {
            await validateRoot();
            if (action === "retry")
              return runSandbox(await prepare(), assertAuthorized);
            if (action !== "host") throw new Error("无效的沙盒恢复选择。");
            const temporary = await realpath(
              await mkdtemp(join(tmpdir(), "panel-host-")),
            );
            try {
              return await run(command, temporary, assertAuthorized);
            } finally {
              await rm(temporary, { recursive: true, force: true });
            }
          },
          signal,
        );
      } catch (error) {
        signal?.throwIfAborted();
        if (dispatched || !(error instanceof SandboxSetupError)) throw error;
        failure = error;
      }
    }
  }

  private async bounded<T>(
    path: string,
    context: Context,
    operation: (canonicalPath: string) => Promise<Result<T, FileError>>,
  ): Promise<Result<T, FileError>> {
    if (context.abortSignal?.aborted)
      return err(new FileError("aborted", "Operation aborted", path));
    const addressed = await super.absolutePath(path, context);
    if (!addressed.ok) return addressed;
    try {
      // Resolve the nearest existing ancestor for new files and directories.
      // lstat distinguishes a dangling symlink from a genuinely absent path;
      // dangling symlinks must fail rather than bypass containment checks.
      let existing = addressed.value;
      while (true) {
        try {
          await lstat(existing);
          break;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT" ||
            dirname(existing) === existing
          )
            throw error;
          existing = dirname(existing);
        }
      }
      const canonical = resolve(
        await realpath(existing),
        relative(existing, addressed.value),
      );
      const inside = relative(this.root, canonical);
      if (
        inside === ".." ||
        inside.startsWith(`..${sep}`) ||
        isAbsolute(inside)
      )
        throw new Error("文件路径超出当前工作目录。");
      assertSandboxFilePath(this.root, canonical);
      context.abortSignal?.throwIfAborted();
      return await operation(canonical);
    } catch (error) {
      return err(
        new FileError(
          context.abortSignal?.aborted ? "aborted" : "permission_denied",
          error instanceof Error ? error.message : String(error),
          path,
        ),
      );
    }
  }

  override absolutePath(path: string, context: Context) {
    return this.bounded(path, context, (canonical) =>
      super.absolutePath(canonical, context),
    );
  }

  override canonicalPath(path: string, context: Context) {
    return this.bounded(path, context, (canonical) =>
      super.canonicalPath(canonical, context),
    );
  }

  override fileInfo(path: string, context: Context) {
    return this.bounded(path, context, (canonical) =>
      super.fileInfo(canonical, context),
    );
  }

  override readTextFile(path: string, context: Context) {
    return this.bounded(path, context, (canonical) =>
      super.readTextFile(canonical, context),
    );
  }

  override readBinaryFile(path: string, context: Context) {
    return this.bounded(path, context, (canonical) =>
      super.readBinaryFile(canonical, context),
    );
  }

  override writeFile(
    path: string,
    content: string | Uint8Array,
    context: Context,
  ) {
    return this.bounded(path, context, (canonical) => {
      assertSandboxFilePath(this.root, canonical, true);
      return super.writeFile(canonical, content, context);
    });
  }
}

function adaptTool<TParameters extends TSchema, TDetails>(
  tool: AgentHarnessTool<ExecutionToolContext, TParameters, TDetails>,
  env: WorkspaceExecutionEnv,
  requestNetwork?: NetworkPermission,
  sandboxOptions?: CodingSandboxOptions,
): AgentTool<TParameters, TDetails> {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      signal?.throwIfAborted();
      const context = signal
        ? withAbortSignal(signal, BACKGROUND_CONTEXT)
        : BACKGROUND_CONTEXT;
      // These four Pi tools do not require durable invocation replay. Keep their
      // invocation-local memo contract intact at the classic Agent boundary.
      const memos = new Map<string, JsonValue>();
      return invocation.run(
        {
          ...sandboxOptions,
          toolCallId: id,
          requestNetwork,
          executionStarted: () =>
            onUpdate?.(
              codingExecutionStartedNotice() as unknown as Parameters<
                NonNullable<typeof onUpdate>
              >[0],
            ),
        },
        () =>
          tool.execute(
            id,
            params,
            (partial) => onUpdate?.(partial),
            { env },
            {
              invocationId: id,
              operationId: id,
              turnId: id,
              async getMemo(name) {
                return memos.get(name);
              },
              async setMemo(name, value) {
                if (value === undefined) memos.delete(name);
                else memos.set(name, value);
              },
            },
            context,
          ),
      );
    },
  };
}

/** Reuse Pi's native tools; Panel supplies containment and approval separately. */
export function createPanelTools(
  cwd: string,
  requestNetwork?: NetworkPermission,
  sandboxOptions?: CodingSandboxOptions,
): AgentTool[] {
  const root = realpathSync(cwd);
  if (!statSync(root).isDirectory()) throw new Error("工作目录必须是文件夹。");
  assertSandboxWorkspace(root);
  let env = environments.get(root);
  if (!env) {
    env = new WorkspaceExecutionEnv(root);
    environments.set(root, env);
  }
  const bash = createBashTool();
  const limitedBash: typeof bash = {
    ...bash,
    description: `${bash.description} Commands run in an OS sandbox: writes are limited to the workspace and a private temporary directory; credential access is blocked; network destinations require a separate permission. Setup failures may pause for a human to retry the sandbox or explicitly approve this exact command on the host. Never bypass this recovery flow or replay a command that has started. Default timeout: ${DEFAULT_COMMAND_TIMEOUT} seconds; maximum: ${MAX_COMMAND_TIMEOUT} seconds.`,
    parameters: {
      ...bash.parameters,
      properties: {
        ...bash.parameters.properties,
        timeout: Object.assign({}, bash.parameters.properties.timeout, {
          description: `Timeout in seconds (default ${DEFAULT_COMMAND_TIMEOUT}; maximum ${MAX_COMMAND_TIMEOUT})`,
          maximum: MAX_COMMAND_TIMEOUT,
        }),
      },
    },
    execute(id, params, ...args) {
      const timeout = params.timeout ?? DEFAULT_COMMAND_TIMEOUT;
      if (timeout > MAX_COMMAND_TIMEOUT)
        throw new Error(`命令超时上限为 ${MAX_COMMAND_TIMEOUT} 秒。`);
      return bash.execute(id, { ...params, timeout }, ...args);
    },
  };
  const tools = [
    adaptTool(createReadTool(), env),
    adaptTool(createWriteTool(), env),
    adaptTool(createEditTool(), env),
    adaptTool(limitedBash, env, requestNetwork, sandboxOptions),
  ];
  for (const tool of tools) sandboxTools.add(tool);
  return tools;
}
