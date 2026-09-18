// Preserve the host's installed toolchain, user paths and locale without passing
// Panel's model-provider credentials or arbitrary service settings to commands.
// This only controls inherited environment variables; HOME/PATH and filesystem
// access still belong to the host user, so it is not an operating-system sandbox.
export const SHELL_ENVIRONMENT_POLICY_VERSION = "panel-shell-env-v1";

const DEVELOPMENT_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  // Needed by Windows programs and Git Bash, without credential-bearing
  // application configuration such as APPDATA or arbitrary *_HOME variables.
  "SystemRoot",
  "WINDIR",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
] as const;

export function createShellEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of DEVELOPMENT_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  // In particular, never inherit BASH_ENV/ENV, exported shell functions,
  // NODE_OPTIONS/PYTHON* or loader options that execute code before the command.
  return environment;
}
