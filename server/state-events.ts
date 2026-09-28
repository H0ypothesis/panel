import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppState, Workspace } from "../shared/types.ts";
import type { AppStatePatch } from "../shared/state-events.ts";
import type { Store } from "./store.ts";

interface WorkspaceFrame {
  metadata: string;
  nodeIds: string[];
  nodes: Map<string, string>;
}
export interface StateFrame {
  instanceId: string;
  revision: number;
  storageError?: string;
  workspaceIds: string[];
  workspaces: Map<string, WorkspaceFrame>;
}

/** Store.snapshot shares nested tool/summary objects with the live store. Keep
 * serialized fingerprints so later in-place updates cannot rewrite the baseline. */
export function captureStateFrame(state: AppState): StateFrame {
  return {
    instanceId: state.instanceId,
    revision: state.revision,
    storageError: state.storageError,
    workspaceIds: state.workspaces.map((workspace) => workspace.id),
    workspaces: new Map(
      state.workspaces.map(({ nodes, ...workspace }) => [
        workspace.id,
        {
          metadata: JSON.stringify(workspace),
          nodeIds: nodes.map((node) => node.id),
          nodes: new Map(nodes.map((node) => [node.id, JSON.stringify(node)])),
        },
      ]),
    ),
  };
}

export function serializeStateFrame(frame: StateFrame): string {
  const metadata = JSON.stringify({
    instanceId: frame.instanceId,
    revision: frame.revision,
    storageError: frame.storageError,
  });
  const workspaces = frame.workspaceIds.map((id) => {
    const workspace = frame.workspaces.get(id)!;
    return `${workspace.metadata.slice(0, -1)},"nodes":[${workspace.nodeIds.map((nodeId) => workspace.nodes.get(nodeId)!).join(",")}]}`;
  });
  return `${metadata.slice(0, -1)},"workspaces":[${workspaces.join(",")}]}`;
}

export function statePatch(
  previous: StateFrame,
  next: StateFrame,
): AppStatePatch | undefined {
  if (
    previous.instanceId !== next.instanceId ||
    previous.revision > next.revision
  )
    return undefined;
  const workspaces: AppStatePatch["workspaces"] = [];
  for (const id of next.workspaceIds) {
    const workspace = next.workspaces.get(id)!;
    const before = previous.workspaces.get(id);
    const changedIds = workspace.nodeIds.filter(
      (nodeId) => before?.nodes.get(nodeId) !== workspace.nodes.get(nodeId),
    );
    const removedNodeIds =
      before?.nodeIds.filter((nodeId) => !workspace.nodes.has(nodeId)) ?? [];
    if (
      before?.metadata === workspace.metadata &&
      !changedIds.length &&
      !removedNodeIds.length &&
      before.nodeIds.every(
        (nodeId, index) => nodeId === workspace.nodeIds[index],
      )
    )
      continue;
    workspaces.push({
      workspace: JSON.parse(workspace.metadata) as Omit<Workspace, "nodes">,
      nodes: changedIds.map((nodeId) =>
        JSON.parse(workspace.nodes.get(nodeId)!),
      ),
      nodeIds: workspace.nodeIds,
      removedNodeIds,
    });
  }
  return {
    instanceId: next.instanceId,
    baseRevision: previous.revision,
    revision: next.revision,
    storageError: next.storageError,
    workspaceIds: next.workspaceIds,
    removedWorkspaceIds: previous.workspaceIds.filter(
      (id) => !next.workspaces.has(id),
    ),
    workspaces,
  };
}

interface EventClient {
  response: ServerResponse;
  patches: boolean;
  blocked: boolean;
  frame?: StateFrame;
  close: () => void;
}

/** Coalesce live updates and replace superseded state while a client drains.
 * Backpressure is normal for a large initial snapshot, not a reconnect signal. */
export class StateEvents {
  private clients = new Set<EventClient>();
  private pending?: ReturnType<typeof setTimeout>;
  private frame?: StateFrame;
  private dirty = true;

  constructor(
    private readonly store: Store,
    private readonly intervalMs = 150,
  ) {
    store.on("change", () => {
      this.dirty = true;
      if (!this.clients.size || this.pending) return;
      this.pending = setTimeout(() => {
        this.pending = undefined;
        if ([...this.clients].every((client) => client.blocked)) return;
        const frame = this.currentFrame();
        for (const client of this.clients) this.send(client, frame);
      }, intervalMs);
      this.pending.unref();
    });
  }

  private currentFrame() {
    if (this.dirty || !this.frame) {
      this.frame = captureStateFrame(this.store.snapshot());
      this.dirty = false;
    }
    return this.frame;
  }

  private send(client: EventClient, frame: StateFrame) {
    if (client.blocked || client.frame === frame) return;
    if (client.response.destroyed || client.response.writableEnded) {
      client.close();
      return;
    }
    const patch =
      client.patches && client.frame
        ? statePatch(client.frame, frame)
        : undefined;
    const payload = patch
      ? `event: state-patch\ndata: ${JSON.stringify(patch)}\n\n`
      : `data: ${serializeStateFrame(frame)}\n\n`;
    try {
      client.blocked = !client.response.write(payload);
      client.frame = frame;
    } catch {
      client.close();
    }
  }

  subscribe(
    request: IncomingMessage,
    response: ServerResponse,
    patches: boolean,
  ) {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const client: EventClient = {
      response,
      patches,
      blocked: false,
      close: () => {
        this.clients.delete(client);
        response.off("drain", drain);
        if (heartbeat) clearInterval(heartbeat);
        if (!this.clients.size && this.pending) {
          clearTimeout(this.pending);
          this.pending = undefined;
        }
      },
    };
    const drain = () => {
      client.blocked = false;
      this.send(client, this.currentFrame());
    };
    response.on("drain", drain);
    request.once("close", client.close);
    response.once("close", client.close);
    this.clients.add(client);
    this.send(client, this.currentFrame());
    if (!this.clients.has(client)) return;
    heartbeat = setInterval(() => {
      if (!client.blocked) {
        try {
          client.blocked = !response.write(": keepalive\n\n");
        } catch {
          client.close();
        }
      }
    }, 15000);
    heartbeat.unref();
  }
}
