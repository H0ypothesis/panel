import type { TurnNode, Workspace } from "./types.ts";

/** Incremental SSE updates; unchanged workspace/card objects can retain identity. */
export interface AppStatePatch {
  instanceId: string;
  baseRevision: number;
  revision: number;
  storageError?: string;
  workspaceIds: string[];
  removedWorkspaceIds: string[];
  workspaces: {
    workspace: Omit<Workspace, "nodes">;
    nodes: TurnNode[];
    removedNodeIds: string[];
    nodeIds: string[];
  }[];
}
