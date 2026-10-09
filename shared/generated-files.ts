import { directParentIds, type TurnNode, type Workspace } from "./types";

export interface GeneratedFile {
  id: string;
  name: string;
  /** Display path relative to the recorded working directory. */
  path: string;
  size?: number;
  mediaType: string;
  previewable: boolean;
  nativeOpenable: boolean;
  status: "available" | "missing" | "unavailable";
}

export interface GeneratedFileTarget {
  workspaceId: string;
  nodeId: string;
  revision: number;
  fileId: string;
}

function ownFileSources(workspace: Workspace, node: TurnNode) {
  const base =
    node.execution?.workingDirectory ??
    workspace.workingDirectory ??
    workspace.temporaryDirectory;
  const sources: { path: string; workingDirectory?: string; nodeId: string }[] =
    [];
  for (const call of node.toolCalls ?? []) {
    if (call.status !== "completed" || !["write", "edit"].includes(call.name))
      continue;
    const path = call.arguments.path ?? call.arguments.file_path;
    if (typeof path === "string" && path.trim())
      sources.push({
        path,
        nodeId: node.id,
        workingDirectory:
          call.workingDirectory ?? call.sandbox?.workingDirectory ?? base,
      });
  }
  for (const entry of workspace.gitHistory ?? []) {
    if (
      entry.nodeId !== node.id ||
      entry.nodeRevision !== (node.revision ?? 0) ||
      entry.status !== "completed"
    )
      continue;
    for (const file of entry.files)
      if (file.status !== "deleted")
        sources.push({
          path: file.path,
          nodeId: node.id,
          workingDirectory: entry.workingDirectory,
        });
  }
  return sources;
}

/** Existing files can also be delivered by later replies that explicitly mention them. */
export function generatedFileSources(workspace: Workspace, node: TurnNode) {
  const sources = ownFileSources(workspace, node);
  const byId = new Map(workspace.nodes.map((item) => [item.id, item]));
  const visited = new Set([node.id]);
  const pending = directParentIds(node);
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const ancestor = byId.get(id);
    if (!ancestor) continue;
    pending.push(...directParentIds(ancestor));
    for (const source of ownFileSources(workspace, ancestor)) {
      const name = source.path.split("/").at(-1)!;
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (
        name.includes(".") &&
        new RegExp(
          `(?:^|[\\s/\u0060\"'<>()[\\]：:])${escaped}(?=$|[\\s\u0060\"'<>()[\\]，。,;：:])`,
        ).test(node.response)
      )
        sources.push(source);
    }
  }
  return sources;
}

export function generatedFilesBase(workspaceId: string, nodeId: string) {
  return `/workspaces/${encodeURIComponent(workspaceId)}/nodes/${encodeURIComponent(nodeId)}/generated-files`;
}

export function generatedFileUrl(
  target: GeneratedFileTarget,
  download = false,
) {
  return `/api${generatedFilesBase(target.workspaceId, target.nodeId)}/${encodeURIComponent(target.fileId)}/content?revision=${target.revision}${download ? "&download=1" : ""}`;
}
