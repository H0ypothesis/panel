import { fork } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PI_WEB_VERSION = "0.29.0";
export type PiWebJob =
  | {
      kind: "search";
      query: string;
      count: number;
      freshness?: "pd" | "pw" | "pm" | "py";
    }
  | { kind: "fetch"; url: string };
export interface PiWebResult {
  text: string;
  sources: Array<{ title: string; url: string }>;
}
export type PiWebRunner = (
  job: PiWebJob,
  signal?: AbortSignal,
) => Promise<PiWebResult>;

// Only the headless search/extraction engines are loaded. Each invocation gets
// its own config and temporary PDF cache; the user's Pi config is never read.
export const PI_WEB_CONFIG = {
  workflow: "none",
  autoOpenBrowser: false,
  fetchRouting: { providers: ["http"], allowRemoteHostedProviders: false },
  ssrf: { allowRanges: [], trustEnvProxy: false },
  githubClone: { enabled: false },
  githubPrIssue: { enabled: false },
  youtube: { enabled: false },
  video: { enabled: false },
  image: { enabled: false },
  // Leave extraction size/page limits to the plugin defaults.
  pdf: { enabled: true, provider: "unpdf" },
  allowBrowserCookies: false,
};

export function piWebEnvironment(
  directory: string,
  job: PiWebJob,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LANG: "en_US.UTF-8",
    HOME: directory,
    USERPROFILE: directory,
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    PI_CODING_AGENT_DIR: directory,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(job.kind === "search" && process.env.EXA_API_KEY?.trim()
      ? { EXA_API_KEY: process.env.EXA_API_KEY.trim() }
      : {}),
  };
}

/** Called inside the runtime's one-use execution grant, never before approval. */
const runInWorker: PiWebRunner = async (job, signal) => {
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "panel-pi-web-"));
  try {
    await writeFile(
      join(directory, "web-search.json"),
      JSON.stringify(PI_WEB_CONFIG),
      { mode: 0o600 },
    );
    signal?.throwIfAborted();
    return await new Promise<PiWebResult>((resolve, reject) => {
      const worker = import.meta.url.endsWith(".mjs")
        ? "./pi-web-worker.mjs"
        : "./pi-web-worker.ts";
      const child = fork(new URL(worker, import.meta.url), [], {
        cwd: directory,
        env: piWebEnvironment(directory, job),
        execArgv: ["--import", import.meta.resolve("tsx")],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let result: PiWebResult | undefined;
      let error: Error | undefined;
      const stop = (message: string) => {
        error = new Error(message);
        child.kill("SIGKILL");
      };
      const abort = () => stop("网页操作已取消。");
      const timer = setTimeout(
        () => stop("pi-web-access 请求超时，请重试或使用其他来源。"),
        60_000,
      );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.once(
        "message",
        (message: { result?: PiWebResult; error?: string }) => {
          if (error) return;
          if (message.error) error = new Error(message.error);
          else if (
            message.result &&
            typeof message.result.text === "string" &&
            Array.isArray(message.result.sources)
          )
            result = message.result;
          else stop("pi-web-access 返回了无效结果。");
        },
      );
      child.once("error", (cause) => {
        error = cause;
      });
      // Wait for process exit before removing its temp files, including on abort.
      child.once("close", () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else if (result) resolve(result);
        else reject(new Error("pi-web-access 未能完成请求。"));
      });
      child.send(job, (cause) => {
        if (cause && !error) stop("无法启动 pi-web-access 请求。");
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const active = new Set<Promise<PiWebResult>>();
export const runPiWeb: PiWebRunner = (job, signal) => {
  const pending = runInWorker(job, signal);
  active.add(pending);
  void pending.then(
    () => active.delete(pending),
    () => active.delete(pending),
  );
  return pending;
};

/** Scheduler aborts first; server shutdown then waits for workers and cleanup. */
export async function waitForPiWebShutdown() {
  await Promise.allSettled([...active]);
}
