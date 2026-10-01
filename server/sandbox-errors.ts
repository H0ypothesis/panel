export type SandboxSetupFailure =
  | "unsupported"
  | "dependencies"
  | "initialization"
  | "timeout"
  | "worker_exit";

/** Only failures before a user command is dispatched may enter recovery. */
export class SandboxSetupError extends Error {
  readonly code: SandboxSetupFailure;
  constructor(code: SandboxSetupFailure, message: string) {
    super(message);
    this.name = "SandboxSetupError";
    this.code = code;
  }

  get retryable() {
    return ["initialization", "timeout", "worker_exit"].includes(this.code);
  }
}

export interface SandboxRecoveryRequest {
  toolCallId: string;
  subagentId?: string;
  command: string;
  workingDirectory: string;
  timeoutSeconds: number;
  reason: string;
  attempts: number;
  stage: "preflight" | "initialization";
}

export type SandboxRecoveryAction = "retry" | "host";
export type SandboxRecovery = <T>(
  request: SandboxRecoveryRequest,
  execute: (
    action: SandboxRecoveryAction,
    assertAuthorized: () => void,
  ) => Promise<T>,
  signal?: AbortSignal,
) => Promise<T>;
