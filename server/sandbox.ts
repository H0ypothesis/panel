import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { webUrl } from "./web-transport.ts";
import { createShellEnvironment } from "./shell-environment.ts";
import { sandboxConfig, type SandboxNetworkRequest } from "./sandbox-policy.ts";
import {
  SandboxSetupError,
  type SandboxSetupFailure,
} from "./sandbox-errors.ts";

export type NetworkPermission = (
  request: SandboxNetworkRequest,
  signal?: AbortSignal,
) => Promise<boolean>;
const active = new Set<() => Promise<void>>();

/** One host manager per invocation: policies/proxies cannot leak across concurrent cards. */
export async function prepareSandbox(
  command: string,
  root: string,
  signal?: AbortSignal,
  requestNetwork?: NetworkPermission,
) {
  signal?.throwIfAborted();
  const temporary = await realpath(
    await mkdtemp(join(tmpdir(), "panel-sandbox-")),
  );
  let worker: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      signal?.removeEventListener("abort", abort);
      if (worker && worker.exitCode === null && worker.signalCode === null) {
        const kill = setTimeout(() => {
          if (worker?.pid) {
            try {
              process.kill(-worker.pid, "SIGKILL");
            } catch {
              worker.kill("SIGKILL");
            }
          }
        }, 2000);
        worker.kill("SIGTERM");
        await closed;
        clearTimeout(kill);
      }
      await rm(temporary, { recursive: true, force: true });
      active.delete(close);
    })());
  const abort = () => {
    void close();
  };
  try {
    const config = await sandboxConfig(root, temporary);
    signal?.throwIfAborted();
    const source = !import.meta.url.endsWith(".mjs");
    worker = fork(
      fileURLToPath(
        new URL(
          source ? "./sandbox-worker.ts" : "./sandbox-worker.mjs",
          import.meta.url,
        ),
      ),
      [],
      {
        cwd: root,
        env: {
          ...createShellEnvironment(),
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
          CLAUDE_CODE_TMPDIR: temporary,
        },
        execArgv: source ? ["--import", import.meta.resolve("tsx")] : [],
        detached: true,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    closed = new Promise((resolve) => worker!.once("close", () => resolve()));
    worker.stderr?.resume();
    active.add(close);
    const broker = worker;
    const ready = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new SandboxSetupError("timeout", "沙盒初始化超时，命令未执行。"),
          ),
        15_000,
      );
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      broker.once("error", (error) =>
        fail(new SandboxSetupError("initialization", error.message)),
      );
      broker.once("close", () =>
        fail(
          new SandboxSetupError(
            "worker_exit",
            "沙盒执行器已退出，命令未执行。",
          ),
        ),
      );
      broker.on(
        "message",
        (message: {
          type?: string;
          command?: string;
          error?: string;
          code?: SandboxSetupFailure;
          id?: number;
          host?: string;
          port?: number;
        }) => {
          if (message.type === "ready" && typeof message.command === "string") {
            clearTimeout(timer);
            resolve(message.command);
          } else if (message.type === "error")
            fail(
              new SandboxSetupError(
                message.code ?? "initialization",
                `沙盒初始化失败，命令未执行：${message.error}`,
              ),
            );
          else if (
            message.type === "network" &&
            typeof message.host === "string" &&
            typeof message.id === "number"
          ) {
            const id = message.id;
            try {
              const host =
                message.host.includes(":") && !message.host.startsWith("[")
                  ? `[${message.host}]`
                  : message.host;
              webUrl(`https://${host}:${message.port ?? 443}/`);
            } catch {
              if (broker.connected)
                broker.send(
                  { type: "permission", id, allowed: false },
                  () => {},
                );
              return;
            }
            void (
              requestNetwork?.(
                {
                  host: message.host,
                  port: message.port,
                  command,
                  workingDirectory: root,
                },
                signal,
              ) ?? Promise.resolve(false)
            )
              .catch(() => false)
              .then((allowed) => {
                if (broker.connected)
                  broker.send({ type: "permission", id, allowed }, () => {});
              });
          }
        },
      );
      broker.send({ type: "prepare", command, config }, (error) => {
        if (error) fail(new SandboxSetupError("initialization", error.message));
      });
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const wrapped = await ready;
    signal?.throwIfAborted();
    return {
      command: wrapped,
      temporary,
      close,
      alive: () =>
        broker.exitCode === null && broker.signalCode === null && !closing,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export type PreparedSandbox = Awaited<ReturnType<typeof prepareSandbox>>;
export type SandboxPreparation = typeof prepareSandbox;
export interface SandboxCheck {
  attempts: number;
  error?: SandboxSetupError;
}

/** A retry only rebuilds setup resources; it never replays a user command. */
export async function prepareSandboxWithRetry(
  prepare: SandboxPreparation,
  command: string,
  root: string,
  signal?: AbortSignal,
  requestNetwork?: NetworkPermission,
  onAttempt?: () => void,
) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    onAttempt?.();
    try {
      const sandbox = await prepare(command, root, signal, requestNetwork);
      if (!sandbox.alive()) {
        await sandbox.close();
        throw new SandboxSetupError(
          "worker_exit",
          "沙盒执行器已退出，命令未执行。",
        );
      }
      return sandbox;
    } catch (error) {
      signal?.throwIfAborted();
      if (
        !(error instanceof SandboxSetupError) ||
        !error.retryable ||
        attempt >= 1
      )
        throw error;
    }
  }
}

/** Inspect dependencies, policy and broker setup without executing a shell. */
export async function checkSandbox(
  root: string,
  signal?: AbortSignal,
  prepare: SandboxPreparation = prepareSandbox,
): Promise<SandboxCheck> {
  let attempts = 0;
  try {
    const sandbox = await prepareSandboxWithRetry(
      prepare,
      "true",
      root,
      signal,
      undefined,
      () => attempts++,
    );
    await sandbox.close();
    return { attempts };
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof SandboxSetupError)) throw error;
    return { attempts, error };
  }
}

export async function closeSandboxes() {
  await Promise.allSettled([...active].map((close) => close()));
}
