export type CuaTarget =
  | { kind: "window"; pid: number; windowId: number | string }
  | {
      kind: "page";
      pid: number;
      windowId: number | string;
      tabId: number | string;
    };

export type CuaOperationMode = "background" | "exclusive";
export type CuaWaitObserver = (reason?: string) => void;

function validId(value: unknown): value is number | string {
  return (
    (typeof value === "string" && value.trim().length > 0) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function copyTarget(target: CuaTarget): CuaTarget {
  if (
    !target ||
    !["window", "page"].includes(target.kind) ||
    !Number.isSafeInteger(target.pid) ||
    target.pid <= 0 ||
    !validId(target.windowId) ||
    (target.kind === "page" && !validId(target.tabId))
  ) {
    throw new Error(
      "CUA target requires a valid process, window and page identity.",
    );
  }
  return Object.freeze(
    target.kind === "window"
      ? { kind: "window", pid: target.pid, windowId: String(target.windowId) }
      : {
          kind: "page",
          pid: target.pid,
          windowId: String(target.windowId),
          tabId: String(target.tabId),
        },
  );
}

/** Page leases are safe only for exact, background CDP operations. */
export function cuaTargetsConflict(a: CuaTarget, b: CuaTarget): boolean {
  return (
    a.pid === b.pid &&
    String(a.windowId) === String(b.windowId) &&
    (a.kind === "window" ||
      b.kind === "window" ||
      String(a.tabId) === String(b.tabId))
  );
}

function sameTarget(a: CuaTarget, b: CuaTarget): boolean {
  return a.kind === b.kind && cuaTargetsConflict(a, b);
}

interface Owner {
  id: string;
  target?: CuaTarget;
  pendingTarget?: TargetRequest;
  activeOperation?: OperationRequest;
  closing: boolean;
}

interface WaitRequest {
  owner: Owner;
  reject: (reason: unknown) => void;
  cleanup: () => void;
  observer?: CuaWaitObserver;
  notified: boolean;
}

interface TargetRequest extends WaitRequest {
  target: CuaTarget;
  grant: () => void;
}

interface OperationRequest extends WaitRequest {
  mode: CuaOperationMode;
  grant: (release: () => void) => void;
}

function notify(request: WaitRequest, reason?: string): void {
  // UI observers cannot affect scheduling or strand a lease if they throw.
  try {
    request.observer?.(reason);
  } catch {
    // The observer's owner handles its UI errors.
  }
}

function finishWaiting(request: WaitRequest): void {
  request.cleanup();
  if (request.notified) {
    request.notified = false;
    notify(request);
  }
}

/**
 * Run-scoped target leases protect observe → reason → act across tool calls.
 * Operation permits separately protect the shared foreground/desktop state.
 *
 * A run owns at most one target. Switching releases its previous target before
 * waiting, so two runs switching windows cannot deadlock. Switching/releasing
 * is forbidden while that run has queued or running operations.
 *
 * FIFO applies among conflicting requests; unrelated targets can pass waiters.
 * Callers must acquire a concrete target before operating on it, even when an
 * exclusive permit is needed. An exclusive permit serializes tool execution;
 * it does not override another run's retained target lease.
 *
 * Abort signals cancel queued requests only. Always release operation permits
 * in finally AFTER the driver operation settles, even if it ignores abort.
 * Call releaseOwner when a run ends/cancels to release its retained target.
 */
export class CuaLocks {
  private readonly owners = new Map<string, Owner>();
  private readonly targetQueue: TargetRequest[] = [];
  private readonly operationQueue: OperationRequest[] = [];
  private readonly activeOperations = new Set<OperationRequest>();
  private draining = false;
  private drainAgain = false;

  async acquireTarget(
    ownerId: string,
    target: CuaTarget,
    signal?: AbortSignal,
    onWait?: CuaWaitObserver,
  ): Promise<void> {
    signal?.throwIfAborted();
    const copied = copyTarget(target);
    const owner = this.owner(ownerId);
    if (owner.closing) throw new Error("CUA owner is being released.");
    if (owner.target && sameTarget(owner.target, copied)) return;
    if (owner.pendingTarget || this.hasOperations(owner)) {
      throw new Error(
        "CUA target cannot change while this owner has pending or active work.",
      );
    }
    // Never hold one resource while waiting for another one.
    owner.target = undefined;
    return new Promise<void>((grant, reject) => {
      const request: TargetRequest = {
        owner,
        target: copied,
        grant,
        reject,
        observer: onWait,
        notified: false,
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      const abort = () => this.cancelTarget(request, signal?.reason);
      owner.pendingTarget = request;
      this.targetQueue.push(request);
      signal?.addEventListener("abort", abort, { once: true });
      this.drain();
      if (this.targetQueue.includes(request)) {
        request.notified = true;
        notify(request, "等待其他任务释放此窗口或页面。");
      }
    });
  }

  async acquireOperation(
    ownerId: string,
    mode: CuaOperationMode,
    signal?: AbortSignal,
    onWait?: CuaWaitObserver,
  ): Promise<() => void> {
    signal?.throwIfAborted();
    if (mode !== "background" && mode !== "exclusive") {
      throw new Error("Unknown CUA operation mode.");
    }
    // Untargeted discovery/global operations may take an exclusive permit.
    const owner =
      mode === "exclusive" ? this.owner(ownerId) : this.owners.get(ownerId);
    if (!owner || (mode === "background" && !owner.target)) {
      throw new Error(
        "CUA background operation requires an acquired target lease.",
      );
    }
    if (owner.closing || owner.pendingTarget) {
      throw new Error(
        "CUA owner is being released or is still waiting for its target.",
      );
    }
    return new Promise<() => void>((grant, reject) => {
      const request: OperationRequest = {
        owner,
        mode,
        grant,
        reject,
        observer: onWait,
        notified: false,
        cleanup: () => signal?.removeEventListener("abort", abort),
      };
      const abort = () => this.cancelOperation(request, signal?.reason);
      this.operationQueue.push(request);
      signal?.addEventListener("abort", abort, { once: true });
      this.drain();
      if (this.operationQueue.includes(request)) {
        request.notified = true;
        notify(request, "等待其他电脑操作完成。");
      }
    });
  }

  getTarget(ownerId: string): CuaTarget | undefined {
    const target = this.owners.get(ownerId)?.target;
    return target ? { ...target } : undefined;
  }

  releaseTarget(ownerId: string): void {
    const owner = this.owners.get(ownerId);
    if (!owner) return;
    if (owner.pendingTarget || this.hasOperations(owner)) {
      throw new Error(
        "CUA target cannot release while this owner has pending or active work.",
      );
    }
    owner.target = undefined;
    this.removeIdleOwner(owner);
    this.drain();
  }

  releaseOwner(ownerId: string): void {
    const owner = this.owners.get(ownerId);
    if (!owner) return;
    owner.closing = true;
    const error = new Error("CUA owner was released.");
    error.name = "AbortError";
    // Mutate all queues before notifying/rejecting, so callbacks cannot start
    // another queued operation while this owner is being torn down.
    const targets = this.targetQueue.filter(
      (request) => request.owner === owner,
    );
    const operations = this.operationQueue.filter(
      (request) => request.owner === owner,
    );
    for (const request of targets) this.removeTarget(request);
    for (const request of operations) this.removeOperation(request);
    if (!owner.activeOperation) owner.target = undefined;
    for (const request of [...targets, ...operations]) {
      finishWaiting(request);
      request.reject(error);
    }
    this.removeIdleOwner(owner);
    this.drain();
  }

  private owner(id: string): Owner {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("CUA operations require a nonempty run owner ID.");
    }
    let owner = this.owners.get(id);
    if (!owner) {
      owner = { id, closing: false };
      this.owners.set(id, owner);
    }
    return owner;
  }

  private hasOperations(owner: Owner): boolean {
    return (
      !!owner.activeOperation ||
      this.operationQueue.some((request) => request.owner === owner)
    );
  }

  private removeIdleOwner(owner: Owner): void {
    if (
      this.owners.get(owner.id) === owner &&
      !owner.target &&
      !owner.pendingTarget &&
      !this.hasOperations(owner)
    ) {
      this.owners.delete(owner.id);
    }
  }

  private removeTarget(request: TargetRequest): boolean {
    const index = this.targetQueue.indexOf(request);
    if (index < 0) return false;
    this.targetQueue.splice(index, 1);
    request.owner.pendingTarget = undefined;
    return true;
  }

  private removeOperation(request: OperationRequest): boolean {
    const index = this.operationQueue.indexOf(request);
    if (index < 0) return false;
    this.operationQueue.splice(index, 1);
    return true;
  }

  private cancelTarget(request: TargetRequest, reason: unknown): void {
    if (!this.removeTarget(request)) return;
    finishWaiting(request);
    request.reject(reason);
    this.removeIdleOwner(request.owner);
    this.drain();
  }

  private cancelOperation(request: OperationRequest, reason: unknown): void {
    if (!this.removeOperation(request)) return;
    finishWaiting(request);
    request.reject(reason);
    this.removeIdleOwner(request.owner);
    this.drain();
  }

  private operationsConflict(
    a: OperationRequest,
    b: OperationRequest,
  ): boolean {
    return (
      a.owner === b.owner || a.mode === "exclusive" || b.mode === "exclusive"
    );
  }

  private drain(): void {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.drainAgain = false;
        const earlierTargets: TargetRequest[] = [];
        for (const request of [...this.targetQueue]) {
          if (!this.targetQueue.includes(request)) continue;
          const occupied = [...this.owners.values()].some(
            (owner) =>
              owner.target && cuaTargetsConflict(owner.target, request.target),
          );
          if (
            occupied ||
            earlierTargets.some((other) =>
              cuaTargetsConflict(other.target, request.target),
            )
          ) {
            earlierTargets.push(request);
            continue;
          }
          this.removeTarget(request);
          request.owner.target = request.target;
          finishWaiting(request);
          request.grant();
        }

        const earlierOperations: OperationRequest[] = [];
        for (const request of [...this.operationQueue]) {
          if (!this.operationQueue.includes(request)) continue;
          if (
            [...this.activeOperations, ...earlierOperations].some((other) =>
              this.operationsConflict(request, other),
            )
          ) {
            earlierOperations.push(request);
            continue;
          }
          this.removeOperation(request);
          this.activeOperations.add(request);
          request.owner.activeOperation = request;
          finishWaiting(request);
          let released = false;
          request.grant(() => {
            if (released) return;
            released = true;
            this.activeOperations.delete(request);
            request.owner.activeOperation = undefined;
            if (request.owner.closing) request.owner.target = undefined;
            this.removeIdleOwner(request.owner);
            this.drain();
          });
        }
      } while (this.drainAgain);
    } finally {
      this.draining = false;
    }
  }
}
