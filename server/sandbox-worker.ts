import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { SandboxSetupError } from "./sandbox-errors.ts";
import type {
  SandboxRuntimeConfig,
  NetworkHostPattern,
} from "@anthropic-ai/sandbox-runtime";

let closing = false;
let started = false;
let sequence = 0;
const permissions = new Map<number, (allowed: boolean) => void>();
async function close() {
  if (closing) return;
  closing = true;
  for (const resolve of permissions.values()) resolve(false);
  permissions.clear();
  await SandboxManager.reset().catch(() => {});
  process.exit(0);
}
process.on("disconnect", () => void close());
process.on("SIGTERM", () => void close());
process.on(
  "message",
  async (message: {
    type: string;
    id?: number;
    allowed?: boolean;
    config?: SandboxRuntimeConfig;
    command?: string;
  }) => {
    if (message.type === "permission" && typeof message.id === "number") {
      permissions.get(message.id)?.(message.allowed === true);
      permissions.delete(message.id);
      return;
    }
    if (message.type !== "prepare" || started || closing) return;
    started = true;
    try {
      if (!message.config || typeof message.command !== "string")
        throw new Error("无效的沙盒请求。");
      if (process.platform !== "darwin" && process.platform !== "linux")
        throw new SandboxSetupError(
          "unsupported",
          "当前系统尚未接入 Panel 沙盒，命令未执行。",
        );
      if (process.platform === "darwin") {
        try {
          await access("/usr/bin/sandbox-exec", constants.X_OK);
        } catch {
          throw new SandboxSetupError(
            "dependencies",
            "macOS 沙盒执行器 /usr/bin/sandbox-exec 不可用，命令未执行。",
          );
        }
      }
      const dependencies = await SandboxManager.checkDependenciesAsync();
      if (dependencies.errors.length)
        throw new SandboxSetupError(
          "dependencies",
          `沙盒依赖不可用：${dependencies.errors.join("；")}`,
        );
      await SandboxManager.initialize(
        message.config,
        (request: NetworkHostPattern) =>
          new Promise<boolean>((resolve) => {
            const id = ++sequence;
            permissions.set(id, resolve);
            process.send?.({ type: "network", id, ...request });
          }),
      );
      const command = await SandboxManager.wrapWithSandbox(
        message.command,
        "/bin/bash",
      );
      process.send?.({ type: "ready", command });
    } catch (error) {
      process.send?.({
        type: "error",
        code:
          error instanceof SandboxSetupError ? error.code : "initialization",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
