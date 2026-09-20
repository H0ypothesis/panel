import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type {
  AppState,
  ContextCheckpoint,
  GitHistoryEntry,
  TurnNode,
  Workspace,
} from "../shared/types.ts";
import {
  GitSnapshots,
  type GitBaseline,
  type GitRestorePlan,
} from "./git-snapshots.ts";
import { exampleWorkspace } from "./seed.ts";
import { snapshotRequestUsage } from "./request-context-usage.ts";
import { preparedContextCheckpoints } from "./context.ts";
import type { StoredAttachment } from "./attachments.ts";
import {
  prepareTemporaryDirectory,
  existingTemporaryDirectory,
  removeTemporaryDirectory,
  temporaryWorkspaceDirectory,
} from "./directories.ts";

export interface StoredNode extends TurnNode {
  attachmentData?: StoredAttachment[];
  attachmentInputHash?: string;
  messages?: Message[];
  previousRuns?: StoredRun[];
  requestKind?: "retry";
  contextSelectionRequest?: {
    contextCheckpointId?: string;
    contextMode?: "raw";
  };
  preparationRequest?: {
    requestId: string;
    config: TurnNode["config"];
    revision: number;
  };
  preparationRequests?: ContextPreparationRequest[];
}
export interface ContextPreparationRequest {
  requestId: string;
  config: TurnNode["config"];
  revision: number;
  status: "compacting" | "completed" | "failed" | "cancelled";
  checkpoint?: ContextCheckpoint;
  error?: string;
}
export interface StoredRun extends TurnNode {
  attachmentData?: StoredAttachment[];
  attachmentInputHash?: string;
  messages?: Message[];
  archivedAt: number;
  requestKind?: "retry";
  contextSelectionRequest?: {
    contextCheckpointId?: string;
    contextMode?: "raw";
  };
  preparationRequests?: ContextPreparationRequest[];
}
export interface PendingNodeRetry {
  nodeId: string;
  expectedRevision: number;
  requestId: string;
  workingDirectory: string;
  plan: GitRestorePlan;
  historyIds: string[];
  status: "restoring" | "restored" | "failed";
  createdAt: number;
  restoredAt?: number;
  error?: string;
}
export interface StoredWorkspace extends Omit<Workspace, "nodes"> {
  nodes: StoredNode[];
  pendingGitSnapshots?: { historyId: string; baseline: GitBaseline }[];
  pendingNodeRetry?: PendingNodeRetry;
  pendingWorkspaceDeletion?: { deleteTemporaryDirectory: true };
}
interface Database {
  version: 1;
  revision: number;
  workspaces: StoredWorkspace[];
}

export class Store extends EventEmitter {
  readonly instanceId = randomUUID();
  data: Database = { version: 1, revision: 0, workspaces: [] };
  storageError?: string;
  private writes: Promise<void> = Promise.resolve();
  private directory: string;
  private snapshots?: GitSnapshots;

  constructor(directory: string) {
    super();
    this.directory = resolve(directory);
  }

  async init(seed = true) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.directory = await realpath(this.directory);
    try {
      const parsed: Database = JSON.parse(
        await readFile(join(this.directory, "state.json"), "utf8"),
      );
      if (parsed.version !== 1 || !Array.isArray(parsed.workspaces))
        throw new Error("不支持的数据文件格式。");
      this.data = parsed;
      for (const workspace of this.data.workspaces) {
        for (const node of workspace.nodes) {
          for (const request of node.preparationRequests ?? []) {
            if (request.status === "compacting") {
              request.status = "failed";
              request.error = "上下文压缩被服务重启中断，未自动重新调用模型。";
            }
          }
          for (const state of [node.contextState, node.preparedContextState]) {
            if (state?.status === "compacting") {
              state.status = "failed";
              state.error = "上下文压缩被服务重启中断，未自动重新调用模型。";
              state.updatedAt = Date.now();
            }
          }
          if (node.status === "running" || node.status === "queued") {
            node.status = "failed";
            node.error = "运行被服务重启中断。可以在新节点继续，或在当前卡片原地重试。";
            node.finishedAt = Date.now();
          }
          for (const call of node.toolCalls ?? []) {
            call.waitingFor = undefined;
            if (
              call.status === "awaiting_approval" ||
              call.status === "reviewing" ||
              call.status === "running"
            ) {
              call.status = "cancelled";
              call.error = "服务重启中断了操作，未自动重新执行。";
              call.finishedAt = Date.now();
              if (call.authorization && !call.authorization.consumedAt) {
                call.authorization.invalidatedAt = Date.now();
                call.authorization.invalidationReason =
                  "服务已重启，旧授权不可恢复或重放。";
              }
              if (call.safetyReview?.decision === "reviewing") {
                call.safetyReview.decision = "cancelled";
                call.safetyReview.reason =
                  "安全审核被服务重启中断，未执行工具。";
                call.safetyReview.finishedAt = Date.now();
              }
            }
          }
        }
        for (const pending of workspace.pendingGitSnapshots ?? []) {
          const entry = workspace.gitHistory?.find(
            (item) => item.id === pending.historyId,
          );
          if (!entry) continue;
          entry.interrupted = true;
          await this.finishGitSnapshot(workspace, entry, pending.baseline);
        }
        workspace.pendingGitSnapshots = [];
        for (const entry of workspace.gitHistory ?? []) {
          if (entry.status === "recording") {
            entry.status = "failed";
            entry.error =
              "服务重启中断了快照保存，缺少可恢复的基线；文件操作未重放。";
            entry.interrupted = true;
          }
        }
      }
      // Finish only a journaled filesystem restoration. Never replay a model or
      // tool on startup; the failed card waits for an explicit retry request.
      for (const workspace of this.data.workspaces) {
        const pending = workspace.pendingNodeRetry;
        if (!pending) continue;
        try {
          await this.gitSnapshots.applyRestore(pending.plan);
          pending.status = "restored";
          pending.error = undefined;
          pending.restoredAt ??= Date.now();
          this.markGitHistoryRestored(workspace, pending);
        } catch (error) {
          pending.status = "failed";
          pending.error = `文件回溯未完成：${error instanceof Error ? error.message : String(error)}；未启动原地重试。`;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (seed) this.data.workspaces = [exampleWorkspace()];
    }
    await this.save();
  }

  snapshot(): AppState {
    return {
      instanceId: this.instanceId,
      revision: this.data.revision,
      storageError: this.storageError,
      workspaces: this.data.workspaces.map(
        ({
          pendingGitSnapshots: _pending,
          pendingNodeRetry,
          pendingWorkspaceDeletion: _deletion,
          ...workspace
        }) => ({
          ...workspace,
          temporaryDirectory: this.temporaryDirectory(workspace),
          nodes: workspace.nodes.map(
            ({
              messages: _messages,
              attachmentData: _attachmentData,
              attachmentInputHash: _attachmentInputHash,
              previousRuns: _previousRuns,
              requestKind: _requestKind,
              contextSelectionRequest: _contextSelectionRequest,
              preparationRequest: _preparationRequest,
              preparationRequests: _preparationRequests,
              ...node
            }) => ({
              ...node,
              preparedCompactions: preparedContextCheckpoints({
                ...node,
                preparationRequests: _preparationRequests,
              }),
              lastRequestUsage: snapshotRequestUsage(node, _messages),
              ...(pendingNodeRetry?.nodeId === node.id
                ? {
                    retryRestore: {
                      requestId: pendingNodeRetry.requestId,
                      status: pendingNodeRetry.status,
                      error: pendingNodeRetry.error,
                    },
                  }
                : {}),
            }),
          ),
        }),
      ),
    };
  }

  get gitSnapshots(): GitSnapshots {
    return (this.snapshots ??= new GitSnapshots(this.directory));
  }

  markGitHistoryRestored(
    workspace: StoredWorkspace,
    pending: PendingNodeRetry,
  ) {
    const ids = new Set(pending.historyIds);
    for (const entry of workspace.gitHistory ?? []) {
      if (!ids.has(entry.id)) continue;
      entry.restoredAt = pending.restoredAt ?? Date.now();
      entry.restoredByRequestId = pending.requestId;
    }
  }

  async finishGitSnapshot(
    workspace: StoredWorkspace,
    entry: GitHistoryEntry,
    baseline?: GitBaseline,
  ) {
    const node = workspace.nodes.find((item) => item.id === entry.nodeId);
    const run =
      (node?.revision ?? 0) === entry.nodeRevision
        ? node
        : node?.previousRuns?.find(
            (item) => (item.revision ?? 0) === entry.nodeRevision,
          );
    const call = run?.toolCalls?.find((item) => item.id === entry.toolCallId);
    try {
      if (!baseline) {
        if (call) call.fileSnapshot = "failed";
        entry.status = "failed";
        entry.error ??= "未能创建操作前快照，文件更新可能已执行。";
        return;
      }
      const result = await this.gitSnapshots.capture(
        baseline,
        `Panel ${entry.toolName}: ${entry.nodeId} (revision ${entry.nodeRevision}, tool ${entry.toolCallId})`,
      );
      if (!result) {
        if (call) call.fileSnapshot = "unchanged";
        workspace.gitHistory = workspace.gitHistory?.filter(
          (item) => item.id !== entry.id,
        );
        return;
      }
      Object.assign(entry, result, {
        status: "completed",
        summary: entry.interrupted
          ? `服务中断后恢复 · ${result.files.length} 个文件`
          : `${entry.toolName === "write" ? "写入" : entry.toolName === "edit" ? "编辑" : "命令更新"} · ${result.files.length} 个文件`,
      });
      if (call) call.fileSnapshot = "recorded";
    } catch (error) {
      if (call) call.fileSnapshot = "failed";
      entry.status = "failed";
      entry.error = `Git 快照保存失败，文件更新可能已执行：${error instanceof Error ? error.message : "未知错误"}`;
    } finally {
      workspace.pendingGitSnapshots = workspace.pendingGitSnapshots?.filter(
        (item) => item.historyId !== entry.id,
      );
    }
  }

  workspace(id: string) {
    const workspace = this.data.workspaces.find((item) => item.id === id);
    if (!workspace) throw new Error("探索不存在。");
    return workspace;
  }

  temporaryDirectory(workspace: StoredWorkspace): string {
    return temporaryWorkspaceDirectory(this.directory, workspace.id);
  }

  effectiveWorkingDirectory(workspace: StoredWorkspace): string {
    return workspace.workingDirectory ?? this.temporaryDirectory(workspace);
  }

  async prepareWorkingDirectory(workspace: StoredWorkspace): Promise<string> {
    // Explicit directories are validated again at execution and never silently
    // replaced. Legacy nodes retain their original execution snapshots.
    return (
      workspace.workingDirectory ??
      (await prepareTemporaryDirectory(this.directory, workspace.id))
    );
  }

  existingTemporaryDirectory(workspace: StoredWorkspace) {
    return existingTemporaryDirectory(this.directory, workspace.id);
  }

  removeTemporaryDirectory(workspace: StoredWorkspace) {
    return removeTemporaryDirectory(this.directory, workspace.id);
  }

  touch(workspace?: StoredWorkspace) {
    this.data.revision++;
    if (workspace) workspace.updatedAt = Date.now();
    this.emit("change");
  }

  async save(
    settings?:
      | {
          workspace: StoredWorkspace;
          values: Partial<
            Pick<
              StoredWorkspace,
              | "workingDirectory"
              | "approvalMode"
              | "safetyModel"
              | "autoCompact"
              | "nodes"
              | "pendingNodeRetry"
              | "gitHistory"
              | "pendingWorkspaceDeletion"
            >
          >;
        }
      | { workspace: StoredWorkspace; deleteWorkspace: true; values?: never }
      | { workspace: StoredWorkspace; createWorkspace: true; values?: never },
  ) {
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        // Serialize inside the queue so a later save cannot overwrite a committed
        // settings change with a stale snapshot. Settings become live only after
        // the atomic rename succeeds, so a failed auto-approval toggle grants nothing.
        const data = settings
          ? {
              ...this.data,
              revision: this.data.revision + 1,
              workspaces:
                "deleteWorkspace" in settings
                  ? this.data.workspaces.filter(
                      (workspace) => workspace !== settings.workspace,
                    )
                  : "createWorkspace" in settings
                    ? [settings.workspace, ...this.data.workspaces]
                    : this.data.workspaces.map((workspace) =>
                        workspace === settings.workspace
                          ? {
                              ...workspace,
                              ...settings.values,
                              updatedAt: Date.now(),
                            }
                          : workspace,
                      ),
            }
          : this.data;
        const serialized = JSON.stringify(data);
        const temp = join(this.directory, "state.json.tmp");
        await writeFile(temp, serialized, { mode: 0o600 });
        await rename(temp, join(this.directory, "state.json"));
        if (settings) {
          if ("deleteWorkspace" in settings) {
            this.data.workspaces = this.data.workspaces.filter(
              (workspace) => workspace !== settings.workspace,
            );
            this.touch();
          } else if ("createWorkspace" in settings) {
            this.data.workspaces.unshift(settings.workspace);
            this.touch();
          } else {
            Object.assign(settings.workspace, settings.values);
            this.touch(settings.workspace);
          }
        }
      });
    this.writes = write;
    try {
      await write;
      if (this.storageError) {
        this.storageError = undefined;
        this.touch();
      }
    } catch (error) {
      this.storageError = "本地保存失败，请检查数据目录权限或剩余磁盘空间。";
      this.touch();
      throw error;
    }
  }
}
