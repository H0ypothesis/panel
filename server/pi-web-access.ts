export const PI_WEB_VERSION = "0.34.0";
export interface PiWebResult {
  text: string;
  sources: Array<{ title: string; url: string }>;
  details?: Record<string, unknown>;
}
// Each native session gets an isolated config and cache.
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

export function piWebEnvironment(directory: string): NodeJS.ProcessEnv {
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
    ...(process.env.EXA_API_KEY?.trim()
      ? { EXA_API_KEY: process.env.EXA_API_KEY.trim() }
      : {}),
  };
}
