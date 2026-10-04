import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import release from "../scripts/cua-release.json";

export const CUA_DRIVER_VERSION = release.version;
const execFileAsync = promisify(execFile);
export type CuaTool = Tool;
export type CuaToolResult = CallToolResult;
export interface CuaDriverLayout {
  binaryPath: string;
  appPath?: string;
  target: string;
}
export interface CuaDriverStatus {
  installed: boolean;
  version: string;
  binaryPath: string;
  platform: string;
  state: "not_installed" | "idle" | "starting" | "ready" | "failed" | "closed";
  message?: string;
}
interface DaemonHandle {
  socket: string;
  pid?: number;
  close(): Promise<void>;
}
export interface CuaDriverOptions {
  rootDir?: string;
  binaryPath?: string;
  platform?: NodeJS.Platform;
  requestTimeoutMs?: number;
  /** Injection points for lifecycle/transport tests; production uses the signed driver. */
  startDaemon?: (
    layout: CuaDriverLayout,
    signal: AbortSignal,
  ) => Promise<DaemonHandle>;
  createTransport?: (layout: CuaDriverLayout, socket: string) => Transport;
}

export function resolveCuaDriverLayout(
  options: CuaDriverOptions = {},
): CuaDriverLayout {
  const platform = options.platform ?? process.platform;
  const target =
    platform === "darwin" ? "darwin-universal" : `${platform}-${process.arch}`;
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const configured = options.binaryPath ?? process.env.PANEL_CUA_DRIVER_PATH;
  if (configured) {
    if (!isAbsolute(configured))
      throw new Error(
        "PANEL_CUA_DRIVER_PATH must be an absolute executable or .app path.",
      );
    const binaryPath = configured.endsWith(".app")
      ? join(configured, "Contents/MacOS/cua-driver")
      : configured;
    const marker = binaryPath.indexOf(".app/Contents/MacOS/");
    return {
      binaryPath,
      target,
      ...(marker >= 0 ? { appPath: binaryPath.slice(0, marker + 4) } : {}),
    };
  }
  const bundled = join(rootDir, "cua-driver", CUA_DRIVER_VERSION, target);
  const runtime = existsSync(bundled)
    ? bundled
    : join(rootDir, ".panel/cua-driver", CUA_DRIVER_VERSION, target);
  return platform === "darwin"
    ? {
        target,
        appPath: join(runtime, "CuaDriver.app"),
        binaryPath: join(runtime, "CuaDriver.app/Contents/MacOS/cua-driver"),
      }
    : {
        target,
        binaryPath: join(
          runtime,
          platform === "win32" ? "cua-driver.exe" : "cua-driver",
        ),
      };
}

export function cuaDriverEnvironment(): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
    CUA_DRIVER_RS_UPDATE_CHECK: "false",
  };
}

function reason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Cua Driver operation cancelled.");
}
async function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise<T>((resolvePromise, reject) => {
    const abort = () => reject(reason(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolvePromise, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

// stdin is a lease. If Panel dies (including SIGKILL), EOF makes this short-lived
// watchdog stop only the private daemon. It does not register any auto-start job.
const LEASE_SCRIPT = `
if IFS= read -r _; then exit 0; fi
i=0
while [ "$i" -lt 150 ]; do
  if [ -S "$2" ]; then "$1" stop --socket "$2" >/dev/null 2>&1; exit 0; fi
  i=$((i + 1))
  sleep 0.1
done
`;

export function cuaDaemonLaunchArgs(
  layout: CuaDriverLayout,
  socket: string,
  pidFile: string,
  platform = process.platform,
) {
  const serve = [
    "serve",
    "--socket",
    socket,
    "--pid-file",
    pidFile,
    "--no-permissions-gate",
    "--permission-mode",
    "standard",
  ];
  if (platform === "darwin") {
    if (!layout.appPath)
      throw new Error(
        "macOS Cua Driver requires the official signed CuaDriver.app. Point PANEL_CUA_DRIVER_PATH at the app bundle.",
      );
    return {
      command: "/usr/bin/open",
      args: [
        "-n",
        "-g",
        "--env",
        "CUA_DRIVER_RS_TELEMETRY_ENABLED=false",
        "--env",
        "CUA_DRIVER_RS_UPDATE_CHECK=false",
        layout.appPath,
        "--args",
        ...serve,
      ],
    };
  }
  return { command: layout.binaryPath, args: serve };
}

async function launchDaemon(
  layout: CuaDriverLayout,
  signal: AbortSignal,
  platform: NodeJS.Platform,
): Promise<DaemonHandle> {
  if (platform === "win32")
    throw new Error(
      "Panel Cua Driver currently supports macOS and Linux; Windows daemon supervision is not configured.",
    );
  const directory = await mkdtemp(join(tmpdir(), "panel-cua-"));
  // macOS Unix socket paths have a 104-byte ceiling; temp roots can be long.
  const socket =
    Buffer.byteLength(join(directory, "driver.sock")) < 100
      ? join(directory, "driver.sock")
      : join("/tmp", `panel-cua-${randomUUID()}.sock`);
  const pidFile = join(directory, "driver.pid");
  let lease: ChildProcess | undefined;
  let daemon: ChildProcess | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    let pid: number | undefined;
    try {
      const value = Number((await readFile(pidFile, "utf8")).trim());
      if (Number.isInteger(value) && value > 1) pid = value;
    } catch {
      /* startup may not have reached pid write */
    }
    try {
      await execFileAsync(layout.binaryPath, ["stop", "--socket", socket], {
        env: cuaDriverEnvironment(),
        timeout: 3_000,
        maxBuffer: 32_768,
      });
    } catch {
      /* Daemon may have failed before binding. */
    }
    daemon?.kill();
    if (pid) {
      // A missing response must never leave native actions running after the
      // caller releases its window lease. The pid file is in our private dir.
      const alive = () => {
        try {
          process.kill(pid!, 0);
          return true;
        } catch {
          return false;
        }
      };
      const deadline = Date.now() + 2_000;
      while (alive() && Date.now() < deadline) await delay(25);
      if (alive()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already exited */
        }
      }
      const killedDeadline = Date.now() + 2_000;
      while (alive() && Date.now() < killedDeadline) await delay(25);
      if (alive())
        throw new Error(
          "Cua Driver could not be stopped; desktop actions remain blocked.",
        );
    }
    // With no pid, LaunchServices may still be creating the process. Leave the
    // EOF watchdog armed so a late bind is stopped instead of orphaned.
    if (pid) lease?.stdin?.end("closed\n");
    else lease?.stdin?.end();
    await rm(socket, { force: true });
    await rm(directory, { recursive: true, force: true });
  };
  try {
    signal.throwIfAborted();
    lease = spawn(
      "/bin/sh",
      ["-c", LEASE_SCRIPT, "panel-cua-lease", layout.binaryPath, socket],
      { env: cuaDriverEnvironment(), stdio: ["pipe", "ignore", "ignore"] },
    );
    await new Promise<void>((resolvePromise, reject) => {
      lease!.once("spawn", resolvePromise);
      lease!.once("error", reject);
    });
    lease.unref();
    (lease.stdin as typeof lease.stdin & { unref?: () => void })?.unref?.();
    const launch = cuaDaemonLaunchArgs(layout, socket, pidFile, platform);
    let daemonError: Error | undefined;
    if (platform === "darwin") {
      await execFileAsync(launch.command, launch.args, {
        env: cuaDriverEnvironment(),
        signal,
        timeout: 10_000,
        maxBuffer: 32_768,
      });
    } else {
      daemon = spawn(launch.command, launch.args, {
        env: cuaDriverEnvironment(),
        stdio: "ignore",
      });
      daemon.once("error", (error) => {
        daemonError = error;
      });
      daemon.once("exit", (code) => {
        daemonError = new Error(`Cua Driver exited (${code}).`);
      });
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (daemonError) throw daemonError;
      if (existsSync(socket)) {
        const pid = Number(await readFile(pidFile, "utf8").catch(() => ""));
        if (Number.isSafeInteger(pid) && pid > 1) return { socket, pid, close };
      }
      await delay(50, undefined, { signal });
    }
    throw new Error(
      "Cua Driver did not start within 15 seconds. Check the signed app and macOS permissions.",
    );
  } catch (error) {
    await close();
    throw error;
  }
}

/** One Panel host owns one daemon. Each run owns a separate MCP transport/session. */
export class CuaDriverService {
  readonly layout: CuaDriverLayout;
  readonly requestTimeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly lifecycle = new AbortController();
  private daemon?: DaemonHandle;
  private starting?: Promise<DaemonHandle>;
  private readonly sessions = new Set<CuaDriverSession>();
  private state: CuaDriverStatus["state"] = "idle";
  private message?: string;
  private closing?: Promise<void>;
  private invalidating?: Promise<void>;
  private readonly permissionRequests = new Set<Promise<CuaToolResult>>();

  constructor(private readonly options: CuaDriverOptions = {}) {
    this.layout = resolveCuaDriverLayout(options);
    this.platform = options.platform ?? process.platform;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  }
  previewOverlay(): { pid: number; bundlePath: string } | undefined {
    const pid = this.daemon?.pid;
    if (
      this.platform === "darwin" &&
      this.state === "ready" &&
      !this.closing &&
      pid &&
      this.layout.appPath
    )
      return { pid, bundlePath: this.layout.appPath };
  }
  getStatus(): CuaDriverStatus {
    let installed = false;
    try {
      accessSync(this.layout.binaryPath, constants.X_OK);
      installed = true;
    } catch {
      /* no startup or prompting */
    }
    return {
      installed,
      version: CUA_DRIVER_VERSION,
      binaryPath: this.layout.binaryPath,
      platform: this.platform,
      state: installed ? this.state : "not_installed",
      ...(this.message
        ? { message: this.message }
        : !installed
          ? {
              message:
                "Run npm run setup:cua in the Panel project to download the verified official runtime.",
            }
          : {}),
    };
  }
  private async ensureDaemon(signal?: AbortSignal): Promise<DaemonHandle> {
    await this.waitUntilUsable(signal);
    if (this.daemon) return this.daemon;
    if (!this.starting) {
      if (!this.options.startDaemon && !this.getStatus().installed)
        throw new Error(this.getStatus().message);
      this.state = "starting";
      this.starting = (
        this.options.startDaemon ??
        ((layout, lifecycle) => launchDaemon(layout, lifecycle, this.platform))
      )(this.layout, this.lifecycle.signal)
        .then((daemon) => {
          this.daemon = daemon;
          this.state = "ready";
          this.message = undefined;
          return daemon;
        })
        .catch((error: unknown) => {
          this.state = "failed";
          this.message = error instanceof Error ? error.message : String(error);
          throw error;
        })
        .finally(() => {
          this.starting = undefined;
        });
    }
    return abortable(this.starting, signal);
  }
  /** Existing transports must honor the same stop barrier as new connections. */
  async waitUntilUsable(signal?: AbortSignal): Promise<void> {
    this.lifecycle.signal.throwIfAborted();
    signal?.throwIfAborted();
    if (this.invalidating) await abortable(this.invalidating, signal);
    this.lifecycle.signal.throwIfAborted();
    signal?.throwIfAborted();
  }
  /** No await between this check and dispatch: invalidation may have begun meanwhile. */
  assertDispatchAllowed(): void {
    this.lifecycle.signal.throwIfAborted();
    if (this.invalidating)
      throw new Error(
        this.message ??
          "Cua Driver is stopping; desktop actions remain blocked.",
      );
  }
  async openSession(signal?: AbortSignal): Promise<CuaDriverSession> {
    return this.newSession(signal, false);
  }
  async openPreviewSession(signal?: AbortSignal): Promise<CuaDriverSession> {
    return this.newSession(signal, true);
  }
  private async newSession(
    signal: AbortSignal | undefined,
    readOnly: boolean,
  ): Promise<CuaDriverSession> {
    signal?.throwIfAborted();
    const session = new CuaDriverSession(
      this,
      () => this.sessions.delete(session),
      readOnly,
    );
    this.sessions.add(session);
    try {
      await session.connect(signal);
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }
  async createClient(signal: AbortSignal): Promise<Client> {
    const daemon = await this.ensureDaemon(signal);
    const transport =
      this.options.createTransport?.(this.layout, daemon.socket) ??
      new StdioClientTransport({
        command: this.layout.binaryPath,
        args: ["mcp", "--socket", daemon.socket],
        env: cuaDriverEnvironment(),
        stderr: "ignore",
        maxBufferSize: 24 * 1024 * 1024,
      });
    const client = new Client(
      { name: "panel-computer-use", version: "0.1.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport, {
        signal,
        timeout: this.requestTimeoutMs,
      });
      return client;
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }
  /** Unknown dispatch outcome: stop the native owner before permits are freed. */
  invalidateConnection(): Promise<void> {
    if (this.invalidating) return this.invalidating;
    const daemon = this.daemon;
    this.daemon = undefined;
    this.invalidating = (async () => {
      try {
        await daemon?.close();
      } finally {
        // Even a failed native stop must retire every existing MCP transport.
        await Promise.allSettled(
          [...this.sessions].map((session) => session.disconnect()),
        );
      }
      this.state = "idle";
    })();
    void this.invalidating.then(
      () => {
        this.invalidating = undefined;
      },
      (error) => {
        this.state = "failed";
        this.message = error instanceof Error ? error.message : String(error);
        // Retain the rejected barrier; a failed stop blocks future dispatch.
      },
    );
    return this.invalidating;
  }
  /** Trusted UI setup only. Never register this method as an agent tool. */
  requestPermissions(signal?: AbortSignal): Promise<CuaToolResult> {
    const combined = signal
      ? AbortSignal.any([signal, this.lifecycle.signal])
      : this.lifecycle.signal;
    const pending = this.runPermissionRequest(combined);
    this.permissionRequests.add(pending);
    void pending.then(
      () => this.permissionRequests.delete(pending),
      () => this.permissionRequests.delete(pending),
    );
    return pending;
  }
  private async runPermissionRequest(
    signal: AbortSignal,
  ): Promise<CuaToolResult> {
    signal.throwIfAborted();
    if (this.platform !== "darwin" || !this.layout.appPath)
      throw new Error(
        "Permission setup requires the official macOS CuaDriver.app.",
      );
    if (!this.getStatus().installed) throw new Error(this.getStatus().message);
    // The public `permissions grant` command hardcodes /Applications. This is
    // its exact pinned 0.30.4 LaunchServices helper, pointed at our signed app.
    const resultFile = join(
      tmpdir(),
      `cua-driver-permissions-${process.pid}-${randomUUID()}.json`,
    );
    await writeFile(resultFile, "", { flag: "wx", mode: 0o600 });
    try {
      await execFileAsync(
        "/usr/bin/open",
        [
          "-n",
          "-W",
          "-g",
          this.layout.appPath,
          "--args",
          "__permissions-host-request",
          "--result-file",
          resultFile,
          "--probe-direct-capture",
        ],
        {
          env: cuaDriverEnvironment(),
          signal,
          timeout: 180_000,
          maxBuffer: 32_768,
        },
      );
      const result = JSON.parse(
        await readFile(resultFile, "utf8"),
      ) as CuaToolResult;
      signal.throwIfAborted();
      // macOS may cache a negative permission preflight in an older process.
      await this.invalidateConnection();
      return result;
    } finally {
      await rm(resultFile, { force: true });
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.lifecycle.abort(new Error("Panel Cua Driver is shutting down."));
      await Promise.allSettled([...this.permissionRequests]);
      await Promise.allSettled(
        [...this.sessions].map((session) => session.close()),
      );
      await this.starting?.catch(() => {});
      // Do not report successful shutdown when native termination is unproven.
      await this.invalidating;
      await this.daemon?.close();
      this.daemon = undefined;
      this.state = "closed";
    })();
    return this.closing;
  }
}

export class CuaDriverSession {
  readonly id = `panel-${randomUUID()}`;
  private connectionGeneration = 0;
  /** Changes on reconnect/invalidation. Browser capability caches must match it. */
  get generation(): number {
    return this.connectionGeneration;
  }
  private client?: Client;
  private connecting?: Promise<void>;
  private readonly lifecycle = new AbortController();
  private tools: Tool[] = [];
  private closing?: Promise<void>;
  private readonly inFlight = new Set<Promise<unknown>>();
  private cursorBounds?: {
    client: Client;
    key: string;
    at: number;
    pending: Promise<unknown>;
  };
  constructor(
    private readonly service: CuaDriverService,
    private readonly onClose: () => void,
    private readonly previewOnly = false,
  ) {}
  async connect(signal?: AbortSignal): Promise<void> {
    this.lifecycle.signal.throwIfAborted();
    signal?.throwIfAborted();
    await this.service.waitUntilUsable(signal);
    if (this.client) return;
    if (!this.connecting) {
      this.connecting = this.openConnection(this.lifecycle.signal).finally(
        () => {
          this.connecting = undefined;
        },
      );
    }
    await abortable(this.connecting, signal);
  }
  private async openConnection(signal: AbortSignal) {
    const client = await this.service.createClient(signal);
    try {
      const tools: Tool[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          signal,
          timeout: this.service.requestTimeoutMs,
        });
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor))
          throw new Error("Cua Driver repeated its tool-list cursor.");
        if (cursor) cursors.add(cursor);
        if (tools.length > 256)
          throw new Error(
            "Cua Driver returned an unexpectedly large tool list.",
          );
      } while (cursor);
      const opts = { signal, timeout: this.service.requestTimeoutMs };
      for (const [name, args] of [
        ["start_session", { session: this.id }],
        [
          "set_agent_cursor_enabled",
          { session: this.id, enabled: !this.previewOnly },
        ],
      ] as const) {
        const result = await client.callTool(
          { name, arguments: args },
          undefined,
          opts,
        );
        if (result.isError)
          throw new Error(
            `Cua Driver could not initialize ${name}: ${JSON.stringify(result.content).slice(0, 1000)}`,
          );
      }
      this.tools = tools;
      this.client = client;
      this.connectionGeneration++;
      client.onclose = () => {
        if (this.client === client) {
          this.client = undefined;
          this.connectionGeneration++;
        }
      };
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }
  async listTools(signal?: AbortSignal): Promise<Tool[]> {
    await this.connect(signal);
    return structuredClone(this.tools);
  }
  /** Content-free preview reads must never reconnect, rotate refs or stop an input daemon. */
  async readCursorState(
    signal?: AbortSignal,
    window?: { pid: number; windowId: number },
  ): Promise<Record<string, unknown> | undefined> {
    if (
      this.previewOnly ||
      !this.client ||
      this.closing ||
      !this.tools.some((tool) => tool.name === "get_agent_cursor_state")
    )
      return;
    const client = this.client;
    const generation = this.generation;
    const pending = (async () => {
      try {
        const read = async (
          name: "get_agent_cursor_state" | "list_windows",
          args: Record<string, unknown>,
        ) => {
          const result = await client.callTool(
            { name, arguments: args },
            undefined,
            { timeout: Math.min(750, this.service.requestTimeoutMs), signal },
          );
          const data = result.structuredContent;
          return !result.isError &&
            data &&
            typeof data === "object" &&
            !Array.isArray(data)
            ? (data as Record<string, unknown>)
            : undefined;
        };
        let bounds: Promise<unknown> = Promise.resolve(undefined);
        if (window && this.tools.some((tool) => tool.name === "list_windows")) {
          const key = `${window.pid}:${window.windowId}`;
          // Geometry does not depend on the model requesting a screenshot. This
          // read neither walks AX nor replaces the model's screenshot/element refs.
          if (
            this.cursorBounds?.client !== client ||
            this.cursorBounds.key !== key ||
            Date.now() - this.cursorBounds.at >= 500
          ) {
            this.cursorBounds = {
              client,
              key,
              at: Date.now(),
              pending: read("list_windows", { pid: window.pid })
                .then((data) => {
                  if (!Array.isArray(data?.windows)) return;
                  const exact = data.windows.filter(
                    (item) =>
                      item &&
                      item.pid === window.pid &&
                      item.window_id === window.windowId,
                  );
                  return exact.length === 1 ? exact[0].bounds : undefined;
                })
                .catch(() => undefined),
            };
          }
          bounds = this.cursorBounds.pending;
        }
        const [data, windowBounds] = await Promise.all([
          read("get_agent_cursor_state", { session: this.id }).catch(
            () => undefined,
          ),
          bounds,
        ]);
        if (
          !data ||
          signal?.aborted ||
          this.client !== client ||
          this.generation !== generation
        )
          return;
        return window ? { ...data, window_bounds: windowBounds } : data;
      } catch {
        return undefined;
      }
    })();
    this.inFlight.add(pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(pending);
    }
  }
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<CuaToolResult> {
    if (
      this.previewOnly &&
      (name !== "get_window_state" ||
        args.include_accessibility_tree !== false ||
        args.include_screenshot !== true)
    )
      throw new Error("Preview sessions only accept window image capture.");
    await this.connect(signal);
    const tool = this.tools.find((tool) => tool.name === name);
    if (!tool) throw new Error(`Unknown Cua Driver tool: ${name}`);
    if ("session" in args && args.session !== this.id)
      throw new Error("A Cua Driver call cannot select another run's session.");
    const scoped =
      tool.inputSchema.properties && "session" in tool.inputSchema.properties
        ? { ...args, session: this.id }
        : args;
    const client = this.client!;
    const combined = signal
      ? AbortSignal.any([signal, this.lifecycle.signal])
      : this.lifecycle.signal;
    combined.throwIfAborted();
    const pending = this.dispatch(client, name, scoped, combined);
    this.inFlight.add(pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(pending);
    }
  }
  private async dispatch(
    client: Client,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CuaToolResult> {
    this.service.assertDispatchAllowed();
    try {
      // SDK AbortSignal rejects as soon as cancellation is sent; that does not
      // prove the native action stopped. Drain the result before releasing the
      // caller's scheduling permit. A timeout tears down the native owner.
      const result = (await client.callTool(
        { name, arguments: args },
        undefined,
        {
          timeout: this.previewOnly
            ? Math.min(this.service.requestTimeoutMs, 2000)
            : this.service.requestTimeoutMs,
        },
      )) as CuaToolResult;
      if (signal.aborted) throw reason(signal);
      const refusal = result.structuredContent?.refusal as
        | { code?: unknown }
        | undefined;
      if (
        result.isError &&
        [refusal?.code, result.structuredContent?.code].some(
          (code) => code === "session_ended" || code === "session_not_started",
        )
      ) {
        // Named sessions expire after idle TTL. Do not replay the refused call;
        // reconnect next time and invalidate every old snapshot/tab capability.
        await this.disconnect();
      }
      return result;
    } catch (error) {
      if (signal.aborted && error === signal.reason) throw error;
      // Image-only reads cannot have delivered input. Losing a preview must
      // never terminate the daemon which owns an unrelated model action.
      if (this.previewOnly) {
        await this.disconnect();
        throw new Error("Window preview capture failed.", { cause: error });
      }
      // Never replay a dispatched action. A transport timeout/failure gives no
      // completion proof, so stop the shared daemon before settling this call.
      await this.service.invalidateConnection();
      if (signal.aborted) throw reason(signal);
      throw new Error(
        "Cua Driver call failed. Its action may have occurred; inspect the target again before retrying.",
        { cause: error },
      );
    }
  }
  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connectionGeneration++;
    await client?.close().catch(() => {});
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      this.lifecycle.abort(new Error("Cua Driver session closed."));
      await this.connecting?.catch(() => {});
      await Promise.allSettled([...this.inFlight]);
      const client = this.client;
      this.client = undefined;
      try {
        if (client) {
          await client
            .callTool(
              { name: "end_session", arguments: { session: this.id } },
              undefined,
              { timeout: 2_000 },
            )
            .catch(() => {});
          await client.close();
        }
      } finally {
        this.onClose();
      }
    })();
    return this.closing;
  }
}
