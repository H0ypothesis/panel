import type { AgentTool } from "@earendil-works/pi-agent-core";
import { realpathSync, statSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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

const DEFAULT_COMMAND_TIMEOUT = 120;
const MAX_COMMAND_TIMEOUT = 600;

// The Pi file mutation queue is scoped to an environment. Sharing it by canonical
// cwd serializes edits to the same file across concurrent Panel branches.
const environments = new Map<string, WorkspaceExecutionEnv>();

class WorkspaceExecutionEnv extends NodeExecutionEnv {
  private readonly root: string;

  constructor(root: string) {
    super({ cwd: root });
    this.root = root;
  }

  override exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: Context,
  ) {
    // Enforce this at the execution boundary: Pi's bash tool explicitly defaults
    // inheritEnv to true, and NodeExecutionEnv otherwise merges in process.env.
    // No tool-controlled environment overrides are currently supported.
    return super.exec(
      command,
      { ...options, env: createShellEnvironment(), inheritEnv: false },
      context,
    );
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
    return this.bounded(path, context, (canonical) =>
      super.writeFile(canonical, content, context),
    );
  }
}

function adaptTool<TParameters extends TSchema, TDetails>(
  tool: AgentHarnessTool<ExecutionToolContext, TParameters, TDetails>,
  env: WorkspaceExecutionEnv,
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
      return tool.execute(
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
      );
    },
  };
}

/** Reuse Pi's native tools; Panel supplies containment and approval separately. */
export function createPanelTools(cwd: string): AgentTool[] {
  const root = realpathSync(cwd);
  if (!statSync(root).isDirectory()) throw new Error("工作目录必须是文件夹。");
  let env = environments.get(root);
  if (!env) {
    env = new WorkspaceExecutionEnv(root);
    environments.set(root, env);
  }
  const bash = createBashTool();
  const limitedBash: typeof bash = {
    ...bash,
    description: `${bash.description} The default timeout is ${DEFAULT_COMMAND_TIMEOUT} seconds; the maximum is ${MAX_COMMAND_TIMEOUT} seconds. This is a local shell, not an operating-system sandbox.`,
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
  return [
    adaptTool(createReadTool(), env),
    adaptTool(createWriteTool(), env),
    adaptTool(createEditTool(), env),
    adaptTool(limitedBash, env),
  ];
}
