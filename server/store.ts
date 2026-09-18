import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type {
  AppState,
  GitHistoryEntry,
  TurnNode,
  Workspace,
} from "../shared/types.ts";
import { GitSnapshots, type GitBaseline } from "./git-snapshots.ts";
import { exampleWorkspace } from "./seed.ts";
import {
  prepareTemporaryDirectory,
  temporaryWorkspaceDirectory,
} from "./directories.ts";

export interface StoredNode extends TurnNode {
  messages?: Message[];
  previousRuns?: StoredRun[];
}
export interface StoredRun extends TurnNode {
  messages?: Message[];
  archivedAt: number;
}
export interface StoredWorkspace extends Omit<Workspace, "nodes"> {
  nodes: StoredNode[];
  pendingGitSnapshots?: { historyId: string; baseline: GitBaseline }[];
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
          if (node.status === "running" || node.status === "queued") {
            node.status = "failed";
            node.error = "运行被服务重启中断。请从父节点重新生成。";
            node.finishedAt = Date.now();
          }
          for (const call of node.toolCalls ?? []) {
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
        ({ pendingGitSnapshots: _pending, ...workspace }) => ({
          ...workspace,
          temporaryDirectory: this.temporaryDirectory(workspace),
          nodes: workspace.nodes.map(
            ({ messages: _messages, previousRuns: _previousRuns, ...node }) =>
              node,
          ),
        }),
      ),
    };
  }

  get gitSnapshots(): GitSnapshots {
    return (this.snapshots ??= new GitSnapshots(this.directory));
  }

  async finishGitSnapshot(
    workspace: StoredWorkspace,
    entry: GitHistoryEntry,
    baseline?: GitBaseline,
  ) {
    try {
      if (!baseline) {
        entry.status = "failed";
        entry.error ??= "未能创建操作前快照，文件更新可能已执行。";
        return;
      }
      const result = await this.gitSnapshots.capture(
        baseline,
        `Panel ${entry.toolName}: ${entry.nodeId} (revision ${entry.nodeRevision}, tool ${entry.toolCallId})`,
      );
      if (!result) {
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
    } catch (error) {
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

  touch(workspace?: StoredWorkspace) {
    this.data.revision++;
    if (workspace) workspace.updatedAt = Date.now();
    this.emit("change");
  }

  async save(settings?: {
    workspace: StoredWorkspace;
    values: Partial<
      Pick<
        StoredWorkspace,
        "workingDirectory" | "approvalMode" | "safetyModel" | "nodes"
      >
    >;
  }) {
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
              workspaces: this.data.workspaces.map((workspace) =>
                workspace === settings.workspace
                  ? { ...workspace, ...settings.values, updatedAt: Date.now() }
                  : workspace,
              ),
            }
          : this.data;
        const serialized = JSON.stringify(data);
        const temp = join(this.directory, "state.json.tmp");
        await writeFile(temp, serialized, { mode: 0o600 });
        await rename(temp, join(this.directory, "state.json"));
        if (settings) {
          Object.assign(settings.workspace, settings.values);
          this.touch(settings.workspace);
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
