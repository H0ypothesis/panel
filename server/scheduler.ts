import { ancestorPath, directParentIds } from "../shared/types.ts";
import { subagentThreads } from "../shared/subagent-runs.ts";
import { contextParentInput, contextParentsMatch } from "./context-parents.ts";
import { randomUUID } from "node:crypto";
import type { AttachmentUpload } from "../shared/attachments.ts";
import {
  attachmentInputHash,
  attachmentPrompt,
  prepareAttachments,
} from "./attachments.ts";
import {
  contextReferencePrompt,
  referenceNodeIds,
  referenceSelectionMatches,
  resolveContextReferences,
} from "./context-references.ts";
import { realpath } from "node:fs/promises";
import type {
  ApprovalMode,
  ComputerUseScope,
  ComputerUseTakeoverOptions,
  ContextCheckpoint,
  ContextParent,
  ContextState,
  GitHistoryEntry,
  RunConfig,
  ToolApprovalDecision,
  ToolCall,
  ToolRequest,
  ModelOption,
  RunInput,
  RunInputMode,
} from "../shared/types.ts";
import type { GitBaseline } from "./git-snapshots.ts";
import {
  buildContext,
  contextCheckpoints,
  preparedContextCheckpoints,
} from "./context.ts";
import { checkpointMatches } from "./compaction.ts";
import { safeError, type Runtime, type RunEnvironment } from "./runtime.ts";
import type {
  PendingNodeRetry,
  StoredNode,
  StoredRun,
  StoredWorkspace,
} from "./store.ts";
import { Store } from "./store.ts";
import { directoriesOverlap, workingDirectory } from "./directories.ts";
import { validateApprovalSettings } from "./approval-settings.ts";
import { isWebTool } from "./web-tools.ts";
import {
  SANDBOX_POLICY_VERSION,
  SANDBOX_TOOL_NAMES,
} from "./sandbox-policy.ts";
import { computerUseMetadata } from "./computer-use.ts";
import type {
  SandboxRecoveryAction,
  SandboxRecoveryRequest,
} from "./sandbox-errors.ts";
import { isCuaTakeoverOperation } from "./cua-takeover.ts";
import { sameTarget, type CuaPreparedApproval } from "./cua-task-control.ts";
import { toolRequestPrompt, validateToolRequests } from "./tool-requests.ts";
import { runConfigsMatch, validateLongTask } from "./run-config.ts";
import {
  FileOperationLocks,
  fileOperationsConflict,
  resolveFileOperationResource,
  resolveRestoreFileResource,
  validateFileOperationResource,
  type FileOperationResource,
} from "./file-operation-locks.ts";
import {
  ToolAuthorizationRegistry,
  type ToolAuthorizationScope,
} from "./tool-authorization.ts";

interface Job {
  workspace: StoredWorkspace;
  node: StoredNode;
  continuationRevision?: number;
}
interface ContextSelectionInput {
  contextCheckpointId?: string;
  contextMode?: "raw";
}
interface ComputerUseTakeoverGrant {
  workspace: StoredWorkspace;
  node: StoredNode;
  revision: number;
  scope?: ComputerUseScope;
}
export class NodeMutationConflict extends Error {}

function safetyUserRequest(node: StoredNode) {
  return [
    attachmentPrompt(
      toolRequestPrompt(
        contextReferencePrompt(node.prompt, node.contextReferences),
        node.toolRequests,
      ),
      node.attachmentData ?? [],
    ),
    ...(node.runInputs ?? [])
      .filter((input) => input.status === "delivered")
      .map(
        (input) =>
          `用户追加消息（${input.mode === "steer" ? "引导当前任务" : "完成后继续"}）：\n${input.text}`,
      ),
  ].join("\n\n");
}

export class Scheduler {
  private queue: Job[] = [];
  private active = new Map<string, AbortController>();
  private runInputControls = new Map<
    string,
    {
      node: StoredNode;
      controller: AbortController;
      revision: number;
      accepting: boolean;
      pending: RunInput[];
      send?: (input: RunInput) => void;
    }
  >();
  private contextJobs = new Map<
    string,
    {
      requestId: string;
      controller: AbortController;
      promise: Promise<ContextCheckpoint | undefined>;
    }
  >();
  private mergeContextJobs = new Map<
    string,
    {
      workspaceId: string;
      sourceIds: string[];
      controller: AbortController;
      promise: Promise<ContextCheckpoint>;
    }
  >();
  private activeDirectories = new Map<string, string>();
  private deletingDirectories = new Map<string, string>();
  private configuringDirectories = new Map<string, string>();
  private approvals = new Map<string, (allow: boolean) => void>();
  // Live grants only: one exact tool name, one card run, one approval configuration.
  private approvedTools = new Map<string, Map<string, string>>();
  private settingsChanges = new Map<string, Promise<void>>();
  private mutations = new Map<string, Promise<unknown>>();
  private approvalVersions = new Map<string, number>();
  private sandboxPermissionVersions = new WeakMap<StoredNode, number>();
  private sandboxRecoveries = new Map<
    string,
    {
      workspace: StoredWorkspace;
      node: StoredNode;
      parent: ToolCall;
      request: SandboxRecoveryRequest;
      arguments: Record<string, unknown>;
    }
  >();
  private authorizations = new ToolAuthorizationRegistry();
  private computerUseTakeovers = new Map<string, ComputerUseTakeoverGrant>();
  private computerUseScopes = new Map<
    string,
    { node: StoredNode; revision: number; scope: ComputerUseScope }
  >();
  private computerUseContexts = new WeakMap<ToolCall, CuaPreparedApproval>();
  private computerUseTakeoverChanges = new Map<string, number>();
  private computerUseTakeoverTokens = new WeakMap<
    ToolCall,
    ComputerUseTakeoverGrant
  >();
  private fileOperations = new FileOperationLocks();
  private dispatchingTools = new Set<string>();
  private maintenanceController = new AbortController();
  private store: Store;
  private runtime: Runtime;
  private concurrency: number;
  private closed = false;
  private readonly subagentControls = new Set<string>();
  private readonly subagentWakes = new Map<string, unknown[]>();
  private readonly suppressedSubagentWakes = new Set<string>();

  private subagentOwner(node: StoredNode) {
    return `${node.id}:${node.revision ?? 0}`;
  }

  private closeSubagentHost(node: StoredNode) {
    const owner = this.subagentOwner(node);
    // Disposal can itself publish a completion. Fence delivery before awaiting it.
    this.suppressedSubagentWakes.add(owner);
    this.subagentWakes.delete(owner);
    return this.runtime.closeSubagentHost?.(owner);
  }

  private queueSubagentWake(workspace: StoredWorkspace, node: StoredNode) {
    const owner = this.subagentOwner(node);
    if (
      this.closed ||
      this.suppressedSubagentWakes.has(owner) ||
      !workspace.nodes.includes(node) ||
      this.active.has(node.id) ||
      !this.subagentWakes.get(owner)?.length
    )
      return;
    if (node.status === "queued") return;
    if (node.status !== "completed") {
      this.subagentWakes.delete(owner);
      return;
    }
    node.status = "queued";
    node.finishedAt = undefined;
    this.queue.push({
      workspace,
      node,
      continuationRevision: node.revision ?? 0,
    });
    this.store.touch(workspace);
    this.pump();
  }

  private toolIsLive(
    node: StoredNode,
    call?: Pick<ToolCall, "id" | "subagentId">,
  ): boolean {
    if (this.closed) return false;
    if (node.status === "running") return true;
    if (call && this.subagentControls.has(`${node.id}:${call.id}`)) return true;
    return (
      !!call?.subagentId &&
      !!this.runtime.hasSubagentWork?.(this.subagentOwner(node)) &&
      !!node.subagents?.some(
        (run) =>
          run.id === call.subagentId &&
          ["queued", "running"].includes(run.status),
      )
    );
  }

  private subagentEnvironment(
    workspace: StoredWorkspace,
    node: StoredNode,
  ): RunEnvironment {
    node.subagentsNative = this.runtime.usesNativeSubagents?.() ?? false;
    const revision = node.revision ?? 0;
    const current = () =>
      !this.closed &&
      workspace.nodes.includes(node) &&
      (node.revision ?? 0) === revision;
    const assertCurrent = () => {
      if (!current()) throw new Error("子代理所属卡片已改变。");
    };
    return {
      subagentWakeManaged: true,
      recoverSandbox: (request, execute, signal) => {
        assertCurrent();
        return this.recoverSandbox(
          workspace,
          node,
          request,
          execute,
          signal ?? this.maintenanceController.signal,
        );
      },
      sandboxPermissionScope: () =>
        JSON.stringify([
          this.toolApprovalScope(workspace, node),
          this.sandboxPermissionVersions.get(node) ?? 0,
        ]),
      subagentOwner: this.subagentOwner(node),
      subagentRecords: node.subagents,
      subagentsEnabled: node.subagentsEnabled,
      workingDirectory: node.execution?.workingDirectory,
      onSubagentsEnabled: () => {
        if (current()) {
          node.subagentsEnabled = true;
          node.subagentsNative = true;
          this.store.touch(workspace);
        }
      },
      onSubagentUpdate: (run) => {
        if (!current()) return;
        const runs = (node.subagents ??= []);
        const index = runs.findIndex(
          (item) =>
            item.id === run.id ||
            (item.id.startsWith("native:") &&
              item.agent !== "workflow" &&
              item.nativeRunId === run.nativeRunId),
        );
        const record = {
          ...run,
          error: run.error ? safeError(run.error) : undefined,
        };
        if (index >= 0 && runs[index].stopReason === "user") {
          record.status = "cancelled";
          record.stopReason = "user";
          record.error = undefined;
        }
        if (index < 0) runs.push(record);
        else runs[index] = record;
        if (
          !["queued", "running"].includes(node.status) &&
          !runs.some((run) => ["queued", "running"].includes(run.status))
        )
          this.sandboxPermissionVersions.set(
            node,
            (this.sandboxPermissionVersions.get(node) ?? 0) + 1,
          );
        this.store.touch(workspace);
        if (!["queued", "running"].includes(run.status))
          void this.store.save().catch(() => {});
      },
      onSubagentNotice: (notice) => {
        if (!current()) return;
        if (notice.kind === "schedule-owner") node.subagentSchedules = true;
        (node.subagentNotices ??= []).push(notice);
        node.subagentNotices = node.subagentNotices.slice(-100);
        // Only the plugin's explicit completion/request wake signal starts a
        // parent turn. Incremental child updates and async-complete duplicates
        // remain records. Never replay stored notices when opening a card.
        const value = notice.value as { options?: { triggerTurn?: boolean } };
        const owner = this.subagentOwner(node);
        if (
          (notice.kind === "message" || notice.kind === "user-message") &&
          value?.options?.triggerTurn === true &&
          !this.suppressedSubagentWakes.has(owner) &&
          ["running", "queued", "completed"].includes(node.status)
        ) {
          const pending = this.subagentWakes.get(owner) ?? [];
          pending.push(structuredClone(notice.value));
          this.subagentWakes.set(owner, pending);
          this.queueSubagentWake(workspace, node);
        }
        this.store.touch(workspace);
        void this.store.save().catch(() => {});
      },
      beforeToolCall: (call, prepare, signal) => {
        assertCurrent();
        return this.beforeToolCall(
          workspace,
          node,
          call,
          signal ?? this.maintenanceController.signal,
          prepare,
        );
      },
      executeTool: (call, execute, signal) => {
        assertCurrent();
        return this.executeAuthorizedTool(
          workspace,
          node,
          call,
          signal ?? this.maintenanceController.signal,
          execute,
        );
      },
      onToolUpdate: (id, update) => {
        if (!current()) return;
        const call = node.toolCalls?.find((item) => item.id === id);
        if (
          !call ||
          call.status === "denied" ||
          (call.status === "cancelled" && update.stopReason !== "timeout") ||
          (call.stopReason === "timeout" && update.stopReason !== "timeout")
        )
          return;
        Object.assign(call, update, {
          output:
            update.output === undefined
              ? call.output
              : safeError(
                  update.output,
                  isWebTool(call.name) ? Infinity : 20000,
                ),
          error: update.error ? safeError(update.error) : undefined,
          finishedAt: ["completed", "failed", "cancelled"].includes(
            update.status,
          )
            ? Date.now()
            : undefined,
        });
        this.store.touch(workspace);
        if (call.finishedAt) void this.store.save().catch(() => {});
      },
    };
  }

  async subagentCommand(
    workspaceId: string,
    nodeId: string,
    revision: number,
    input: Record<string, unknown>,
    name = "subagent",
  ) {
    const workspace = this.store.workspace(workspaceId);
    const node = workspace.nodes.find((item) => item.id === nodeId);
    if (!node || (node.revision ?? 0) !== revision)
      throw new Error("卡片已改变，请刷新。");
    if (!this.runtime.subagentHost || !node.execution?.workingDirectory)
      throw new Error("此卡片不能启动原生子代理宿主。");
    const environment = this.subagentEnvironment(workspace, node);
    const host = this.runtime.subagentHost(node.config, environment);
    if (!(await host.tools()).some((tool) => tool.name === name))
      throw new Error("未知的原生子代理工具。");
    host.setHistory([
      ...buildContext(workspace, node.parentId!, node.contextParents).messages,
      ...(node.messages ?? []),
    ]);
    const id = randomUUID();
    const call = { id, name, arguments: structuredClone(input) };
    this.subagentControls.add(`${node.id}:${id}`);
    try {
      if (!(await environment.beforeToolCall(call)))
        throw new Error("子代理操作已拒绝。");
      this.suppressedSubagentWakes.delete(this.subagentOwner(node));
      const result = await environment.executeTool(call, () =>
        host.execute(name, input, this.maintenanceController.signal),
      );
      const output = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      environment.onToolUpdate(id, { status: "completed", output });
      return result;
    } catch (error) {
      environment.onToolUpdate(id, {
        status: "failed",
        error: safeError(error),
      });
      throw error;
    } finally {
      this.subagentControls.delete(`${node.id}:${id}`);
      await this.store.save();
    }
  }

  answerSubagentQuestion(
    workspaceId: string,
    nodeId: string,
    revision: number,
    id: string,
    answer: unknown,
  ) {
    const workspace = this.store.workspace(workspaceId);
    const node = workspace.nodes.find((item) => item.id === nodeId);
    if (
      !node ||
      (node.revision ?? 0) !== revision ||
      !this.runtime.subagentHost
    )
      throw new Error("卡片已改变，请刷新。");
    this.runtime
      .subagentHost(node.config, this.subagentEnvironment(workspace, node))
      .answer(id, answer);
  }

  constructor(store: Store, runtime: Runtime, concurrency = Infinity) {
    this.store = store;
    this.runtime = runtime;
    this.concurrency = concurrency;
  }

  async restoreSubagentSchedules() {
    if (!this.runtime.subagentHost) return;
    for (const workspace of this.store.data.workspaces)
      for (const node of workspace.nodes) {
        if (
          !node.subagentsNative ||
          !(
            node.subagentSchedules ||
            node.subagentNotices?.some(
              (notice) => notice.kind === "schedule-owner",
            )
          ) ||
          !node.execution?.workingDirectory
        )
          continue;
        try {
          await realpath(node.execution.workingDirectory);
          await this.runtime
            .subagentHost(
              node.config,
              this.subagentEnvironment(workspace, node),
            )
            .tools();
        } catch (error) {
          (node.subagentNotices ??= []).push({
            kind: "recovery-error",
            value: safeError(error),
            createdAt: Date.now(),
          });
          this.store.touch(workspace);
        }
      }
  }

  private validateRequestedTools(
    requests: ToolRequest[] | undefined,
    model: ModelOption,
  ) {
    if (!requests?.length) return;
    if (model.demo)
      throw new Error("演示模型不能主动调用工具，请先选择已连接的真实模型。");
    if (requests.includes("computer_use")) {
      if (!this.runtime.computerUseStatus?.().available)
        throw new Error("电脑控制尚未安装，请先在「电脑控制」中完成驱动设置。");
      if (model.supportsImages === false)
        throw new Error("电脑控制需要支持图片的模型。");
    }
  }

  submit(
    workspaceId: string,
    input: {
      parentId: string;
      contextParents?: ContextParent[];
      mergedContextCheckpointId?: string;
      prompt: string;
      attachments?: AttachmentUpload[];
      referenceNodeIds?: string[];
      toolRequests?: ToolRequest[];
      config: RunConfig;
      requestId: string;
      contextCheckpointId?: string;
      contextMode?: "raw";
    },
  ) {
    return this.serializeMutation(workspaceId, () =>
      this.submitUnlocked(workspaceId, input),
    );
  }

  private async submitUnlocked(
    workspaceId: string,
    input: {
      parentId: string;
      contextParents?: ContextParent[];
      mergedContextCheckpointId?: string;
      prompt: string;
      attachments?: AttachmentUpload[];
      referenceNodeIds?: string[];
      toolRequests?: ToolRequest[];
      config: RunConfig;
      requestId: string;
      contextCheckpointId?: string;
      contextMode?: "raw";
    },
  ) {
    if (input.toolRequests?.length && !input.prompt.trim())
      throw new Error("请选择工具后输入具体任务。");
    validateLongTask(input.config.longTask);
    if (!input.prompt.trim() && input.attachments?.length)
      input = { ...input, prompt: "请分析上传的附件。" };
    const workspace = this.store.workspace(workspaceId);
    this.validateContextSelection(input);
    this.assertWorkspaceNotDeleting(workspace);
    if (workspace.pendingNodeRetry?.requestId === input.requestId)
      throw new NodeMutationConflict("请求 ID 已用于原地重试，请继续原请求。");
    if (this.preparationRequestExists(workspace, input.requestId))
      throw new NodeMutationConflict(
        "请求 ID 已用于摘要任务，请使用新的请求 ID。",
      );
    const duplicate = this.findRequest(workspace, input.requestId);
    const attachmentHash = attachmentInputHash(input.attachments);
    const references = referenceNodeIds(input.referenceNodeIds);
    const toolRequests = validateToolRequests(input.toolRequests);
    const requestedParents = contextParentInput(input.contextParents);
    if (requestedParents && requestedParents[0].nodeId !== input.parentId)
      throw new NodeMutationConflict("主分支必须是第一个接入节点。");
    if (duplicate) {
      if (
        duplicate.run.requestKind === "retry" ||
        (duplicate.run.revision ?? 0) !== 0 ||
        duplicate.run.parentId !== input.parentId ||
        duplicate.run.mergedContextCheckpointId !==
          input.mergedContextCheckpointId ||
        !contextParentsMatch(
          duplicate.run.contextParentsRequest ?? duplicate.run.contextParents,
          requestedParents,
        ) ||
        duplicate.run.prompt !== input.prompt ||
        JSON.stringify(duplicate.run.toolRequests ?? []) !==
          JSON.stringify(toolRequests ?? []) ||
        duplicate.run.attachmentInputHash !== attachmentHash ||
        !referenceSelectionMatches(
          duplicate.run.contextReferences,
          references,
        ) ||
        !runConfigsMatch(duplicate.run.config, input.config) ||
        (duplicate.run.contextParentsRequest
          ? duplicate.run.contextParentsRequest[0].contextCheckpointId
          : duplicate.run.requestedContextCheckpointId) !==
          (input.contextCheckpointId ??
            requestedParents?.[0]?.contextCheckpointId) ||
        (duplicate.run.contextParentsRequest
          ? duplicate.run.contextParentsRequest[0].contextMode
          : duplicate.run.contextMode) !==
          (input.contextMode ?? requestedParents?.[0]?.contextMode)
      ) {
        throw new Error("请求 ID 已用于其他内容，请重新发送。");
      }
      return duplicate.node;
    }
    if (this.closed) throw new Error("服务正在关闭，请稍后重试。");
    if (this.store.storageError) throw new Error(this.store.storageError);
    if (workspace.pendingNodeRetry)
      throw new NodeMutationConflict(
        "此画布还有未完成的文件回溯，请先完成对应卡片的原地重试。",
      );
    const model = this.runtime
      .models()
      .find((item) => item.id === input.config.model);
    if (!model?.available)
      throw new Error(
        `模型未配置。请设置 ${model?.envVar ?? "相应的 API Key"} 后重启服务。`,
      );
    if (!model.thinkingLevels.includes(input.config.thinking))
      throw new Error("该模型不支持所选思考强度。");
    this.validateRequestedTools(toolRequests, model);
    if (!model.demo)
      this.assertDirectoryAvailable(
        this.store.effectiveWorkingDirectory(workspace),
      );
    const contextParents = this.resolveContextParents(
      workspace,
      input.parentId,
      requestedParents,
      input,
    );
    const context = buildContext(workspace, input.parentId, contextParents);
    // Cancellation exposes its terminal status before the runtime flushes its
    // transcript. Completed turns already have their final messages assigned.
    if (
      context.ids.some((id) => {
        const ancestor = workspace.nodes.find((node) => node.id === id)!;
        return (
          (ancestor.status === "failed" || ancestor.status === "cancelled") &&
          this.active.has(id)
        );
      })
    )
      throw new NodeMutationConflict("此路径仍在收尾，请等待结束后继续。");
    const contextReferences = resolveContextReferences(workspace, references);
    const parent = workspace.nodes.find((node) => node.id === input.parentId)!;
    const selection = this.contextSelection(
      workspace,
      parent,
      input,
      undefined,
      requestedParents,
    );
    const mergedCheckpoint = this.mergedPreparationCheckpoint(
      workspace,
      input.mergedContextCheckpointId,
      input.parentId,
      requestedParents,
      contextParents,
      input.config,
      context,
    );
    if (mergedCheckpoint) {
      selection.requestedContextCheckpointId = mergedCheckpoint.id;
      selection.effectiveContextCheckpointId = mergedCheckpoint.id;
    }
    this.validateRequestedContext(
      workspace,
      selection.effectiveContextCheckpointId,
      context,
      mergedCheckpoint ? [mergedCheckpoint] : [],
    );
    const siblings = workspace.nodes.filter(
      (node) => node.parentId === input.parentId,
    );
    const colors = ["sage", "violet", "blue", "amber"] as const;
    const x =
      (contextParents?.length ?? 0) > 1
        ? Math.max(
            ...contextParents!.map(
              (input) =>
                workspace.nodes.find((node) => node.id === input.nodeId)!
                  .position.x,
            ),
          ) + 500
        : parent.position.x +
          ((input.contextCheckpointId ??
          contextParents?.[0]?.contextCheckpointId)
            ? 500
            : 360);
    let y = parent.position.y;
    while (
      workspace.nodes.some(
        (node) =>
          Math.abs(node.position.x - x) < 290 &&
          Math.abs(node.position.y - y) < 235,
      )
    )
      y += 250;
    const attachments = await prepareAttachments(input.attachments);
    if (
      !model.demo &&
      model.supportsImages === false &&
      attachments.some((file) => file.metadata.kind === "image")
    )
      throw new Error("当前模型不支持图片输入，请选择支持图片的模型。");
    const node: StoredNode = {
      id: randomUUID(),
      parentId: parent.id,
      contextParents,
      contextParentsRequest: requestedParents?.map((parent, i) => ({
        ...parent,
        revision: contextParents![i].revision,
      })),
      prompt: input.prompt,
      contextReferences,
      toolRequests,
      attachments: attachments.length
        ? attachments.map((file) => file.metadata)
        : undefined,
      attachmentData: attachments.length ? attachments : undefined,
      attachmentInputHash: attachmentHash,
      response: "",
      status: "queued",
      config: { ...input.config },
      contextIds: context.ids,
      contextSources: context.sources,
      ...selection,
      mergedContextCheckpointId: input.mergedContextCheckpointId,
      compactions: mergedCheckpoint
        ? [structuredClone(mergedCheckpoint)]
        : undefined,
      requestId: input.requestId,
      color:
        parent.status === "root"
          ? colors[siblings.length % colors.length]
          : parent.color,
      position: { x, y },
      createdAt: Date.now(),
      execution: !model.demo
        ? {
            workingDirectory:
              await this.store.prepareWorkingDirectory(workspace),
            approvalMode: workspace.approvalMode ?? "ask",
            safetyModel: workspace.safetyModel,
          }
        : undefined,
    };
    if (this.closed) throw new Error("服务正在关闭，请稍后重试。");
    if (node.execution?.workingDirectory)
      this.assertNoPendingRestore(node.execution.workingDirectory);
    this.assertDirectoryAvailable(node.execution?.workingDirectory);
    workspace.nodes.push(node);
    this.store.touch(workspace);
    try {
      await this.store.save();
    } catch (error) {
      node.status = "failed";
      node.error = "保存失败，未启动模型调用。";
      this.store.touch(workspace);
      throw error;
    }
    this.queue.push({ workspace, node });
    this.pump();
    return node;
  }

  private resolveContextParents(
    workspace: StoredWorkspace,
    parentId: string,
    input: ContextParent[] | undefined,
    selection: ContextSelectionInput,
    refresh = false,
  ): ContextParent[] | undefined {
    if (!input) return undefined;
    const parents = contextParentInput(input)!;
    if (parents[0].nodeId !== parentId)
      throw new NodeMutationConflict("主分支必须是第一个接入节点。");
    if (
      (selection.contextMode &&
        selection.contextMode !== parents[0].contextMode) ||
      (selection.contextCheckpointId &&
        selection.contextCheckpointId !== parents[0].contextCheckpointId)
    )
      throw new NodeMutationConflict("主分支上下文选择不一致。");
    return parents.map((input) => {
      const source = workspace.nodes.find((node) => node.id === input.nodeId);
      if (!source) throw new NodeMutationConflict("上下文分支节点不存在。");
      if (
        !refresh &&
        input.revision !== undefined &&
        input.revision !== (source.revision ?? 0)
      )
        throw new NodeMutationConflict("接入分支已更新，请重新选择。");
      const context = buildContext(workspace, source.id);
      let resolved = this.contextSelection(workspace, source, input);
      if (refresh && resolved.effectiveContextCheckpointId) {
        try {
          this.validateRequestedContext(
            workspace,
            resolved.effectiveContextCheckpointId,
            context,
          );
        } catch {
          resolved = this.contextSelection(workspace, source, {
            contextMode: "raw",
          });
        }
      }
      this.validateRequestedContext(
        workspace,
        resolved.effectiveContextCheckpointId,
        context,
      );
      return {
        nodeId: input.nodeId,
        revision: source.revision ?? 0,
        contextMode: resolved.effectiveContextMode,
        contextCheckpointId: resolved.effectiveContextCheckpointId,
      };
    });
  }

  private contextBranches(workspace: StoredWorkspace, node: StoredNode) {
    const branches = new Map<
      string,
      { nodeId: string; sourceIds: string[]; contextMode?: "raw" }
    >();
    const pending = [node];
    const visited = new Set<string>();
    while (pending.length) {
      const owner = pending.pop()!;
      if (visited.has(owner.id)) continue;
      visited.add(owner.id);
      if ((owner.effectiveContextMode ?? owner.contextMode) === "raw") continue;
      const parents =
        owner.contextParents ??
        (owner.parentId ? [{ nodeId: owner.parentId }] : []);
      for (const parent of parents) {
        const source = workspace.nodes.find(
          (item) => item.id === parent.nodeId,
        )!;
        if (parents.length > 1)
          branches.set(`${owner.id}:${source.id}`, {
            nodeId: source.id,
            sourceIds: ancestorPath(workspace.nodes, source.id).map(
              (item) => item.id,
            ),
            contextMode: parent.contextMode,
          });
        if (!parent.contextCheckpointId && parent.contextMode !== "raw")
          pending.push(source);
      }
    }
    return [...branches.values()];
  }

  private branchCheckpoints(
    workspace: StoredWorkspace,
    node: StoredNode,
    _ids: string[],
  ): ContextCheckpoint[] {
    if ((node.effectiveContextMode ?? node.contextMode) === "raw") return [];
    const checkpoints = new Map<string, ContextCheckpoint>();
    const visited = new Set<string>();
    const pending: ContextParent[] = [
      ...(node.contextParents ??
        (node.parentId ? [{ nodeId: node.parentId }] : [])),
    ];
    while (pending.length) {
      const parent = pending.pop()!;
      if (parent.contextMode === "raw") continue;
      const source = workspace.nodes.find((item) => item.id === parent.nodeId)!;
      const checkpointId =
        parent.contextCheckpointId ??
        source.effectiveContextCheckpointId ??
        source.requestedContextCheckpointId;
      if (checkpointId) {
        const context = buildContext(workspace, parent.nodeId);
        const checkpoint = contextCheckpoints(workspace, context.ids).find(
          (item) => item.id === checkpointId,
        );
        if (
          !checkpoint ||
          !checkpointMatches(checkpoint, context.messages, context.sources)
        )
          throw new NodeMutationConflict("接入分支摘要已失效，请重新选择。");
        checkpoints.set(checkpoint.id, checkpoint);
        continue;
      }
      if (
        visited.has(source.id) ||
        (source.effectiveContextMode ?? source.contextMode) === "raw"
      )
        continue;
      visited.add(source.id);
      pending.push(
        ...(source.contextParents ??
          (source.parentId ? [{ nodeId: source.parentId }] : [])),
      );
    }
    return [...checkpoints.values()];
  }

  private validateRequestedContext(
    workspace: StoredWorkspace,
    checkpointId: string | undefined,
    context: ReturnType<typeof buildContext>,
    additional: ContextCheckpoint[] = [],
  ) {
    if (!checkpointId) return;
    const checkpoint = [
      ...contextCheckpoints(workspace, context.ids),
      ...additional,
    ].find((item) => item.id === checkpointId);
    if (
      !checkpoint ||
      !checkpointMatches(checkpoint, context.messages, context.sources)
    )
      throw new NodeMutationConflict(
        "所选摘要已失效或不属于这条路径，请重新生成摘要。",
      );
  }

  private validateContextSelection(input: ContextSelectionInput) {
    if (input.contextMode !== undefined && input.contextMode !== "raw")
      throw new NodeMutationConflict("上下文选择无效。");
    if (input.contextMode && input.contextCheckpointId !== undefined)
      throw new NodeMutationConflict("原文和压缩摘要不能同时选择。");
  }

  private contextSelection(
    workspace: StoredWorkspace,
    parent: StoredNode,
    input: ContextSelectionInput,
    previous?: StoredNode | StoredRun,
    contextParents = previous?.contextParents,
  ) {
    this.validateContextSelection(input);
    if ((contextParents?.length ?? 0) > 1) {
      const aggregateId =
        previous?.effectiveContextCheckpointId ??
        previous?.requestedContextCheckpointId;
      const aggregate = previous?.compactions?.find(
        (checkpoint) =>
          checkpoint.id === aggregateId && checkpoint.purpose === "merge",
      );
      const context =
        previous && buildContext(workspace, parent.id, contextParents);
      const checkpointId =
        !input.contextMode &&
        !input.contextCheckpointId &&
        aggregate &&
        context &&
        contextParentsMatch(previous?.contextParents, contextParents) &&
        checkpointMatches(aggregate, context.messages, context.sources)
          ? aggregate.id
          : undefined;
      return {
        contextMode: undefined,
        effectiveContextMode: undefined,
        requestedContextCheckpointId: checkpointId,
        effectiveContextCheckpointId: checkpointId,
        contextAutoCompact: true,
      };
    }
    if (contextParents?.length === 1 && !previous)
      input = {
        ...contextParents[0],
        ...input,
        contextMode: input.contextMode ?? contextParents[0].contextMode,
        contextCheckpointId:
          input.contextCheckpointId ?? contextParents[0].contextCheckpointId,
      };
    if (
      previous?.contextStale &&
      !input.contextMode &&
      !input.contextCheckpointId
    ) {
      const checkpointId =
        previous.effectiveContextCheckpointId ??
        previous.requestedContextCheckpointId;
      if (checkpointId) {
        const context = buildContext(workspace, parent.id);
        const checkpoint = contextCheckpoints(workspace, context.ids).find(
          (item) => item.id === checkpointId,
        );
        if (
          !checkpoint ||
          !checkpointMatches(checkpoint, context.messages, context.sources)
        )
          previous = undefined;
      }
    }
    if (previous && !input.contextMode && !input.contextCheckpointId)
      return {
        contextMode: previous.contextMode,
        effectiveContextMode:
          previous.effectiveContextMode ?? previous.contextMode,
        requestedContextCheckpointId: previous.requestedContextCheckpointId,
        effectiveContextCheckpointId:
          previous.effectiveContextCheckpointId ??
          previous.requestedContextCheckpointId,
        contextAutoCompact:
          previous.contextAutoCompact ?? workspace.autoCompact !== false,
      };
    const raw =
      input.contextMode === "raw" ||
      (!input.contextCheckpointId &&
        (parent.effectiveContextMode ?? parent.contextMode) === "raw");
    const mergeCheckpoint = [...(parent.compactions ?? [])]
      .reverse()
      .find((checkpoint) => checkpoint.purpose === "merge");
    const previousCheckpoint =
      parent.effectiveContextCheckpointId ??
      parent.requestedContextCheckpointId ??
      mergeCheckpoint?.id;
    const latestCheckpoint =
      previousCheckpoint &&
      parent.contextState?.status === "compacted" &&
      parent.compactions?.some(
        (checkpoint) => checkpoint.id === parent.contextState?.checkpointId,
      )
        ? parent.contextState.checkpointId
        : previousCheckpoint;
    return {
      contextMode: input.contextMode,
      effectiveContextMode: raw ? ("raw" as const) : undefined,
      requestedContextCheckpointId: input.contextCheckpointId,
      effectiveContextCheckpointId: raw
        ? undefined
        : (input.contextCheckpointId ?? latestCheckpoint),
      contextAutoCompact: raw
        ? false
        : ancestorPath(workspace.nodes, parent.id).some(
            (node) => (node.contextParents?.length ?? 0) > 1,
          ) || workspace.autoCompact !== false,
    };
  }

  private preparationRequestExists(
    workspace: StoredWorkspace,
    requestId: string,
  ): boolean {
    return (
      Boolean(workspace.cancelledMergePreparationIds?.includes(requestId)) ||
      Boolean(
        workspace.mergePreparationRequests?.some(
          (request) => request.requestId === requestId,
        ),
      ) ||
      workspace.nodes.some((node) =>
        [node, ...(node.previousRuns ?? [])].some((run) =>
          run.preparationRequests?.some(
            (request) => request.requestId === requestId,
          ),
        ),
      )
    );
  }

  private mergedPreparationCheckpoint(
    workspace: StoredWorkspace,
    checkpointId: string | undefined,
    parentId: string,
    requestedParents: ContextParent[] | undefined,
    resolvedParents: ContextParent[] | undefined,
    config: RunConfig,
    context: ReturnType<typeof buildContext>,
  ) {
    if (!checkpointId) return undefined;
    const preparation = workspace.mergePreparationRequests?.find(
      (request) =>
        request.status === "completed" &&
        request.checkpoint?.id === checkpointId,
    );
    if (
      !preparation ||
      !requestedParents ||
      !resolvedParents ||
      resolvedParents.length < 2 ||
      preparation.parentId !== parentId ||
      !contextParentsMatch(
        preparation.contextParentsRequest,
        requestedParents,
      ) ||
      !contextParentsMatch(preparation.contextParents, resolvedParents) ||
      preparation.config.model !== config.model ||
      preparation.config.thinking !== config.thinking ||
      !checkpointMatches(
        preparation.checkpoint!,
        context.messages,
        context.sources,
      )
    )
      throw new NodeMutationConflict(
        "整体摘要已失效或分支选择已改变，请重新整体压缩。",
      );
    return preparation.checkpoint!;
  }

  /** A draft aggregate is private until an answer adopts it; no source card owns it. */
  async compactMergeContext(
    workspaceId: string,
    input: {
      parentId: string;
      contextParents: ContextParent[];
      config: RunConfig;
      requestId: string;
    },
  ): Promise<ContextCheckpoint> {
    validateLongTask(input.config.longTask);
    const task = await this.serializeMutation(workspaceId, async () => {
      const workspace = this.store.workspace(workspaceId);
      this.assertWorkspaceNotDeleting(workspace);
      if (this.closed) throw new Error("服务正在关闭，请稍后重试。");
      if (this.store.storageError) throw new Error(this.store.storageError);
      if (workspace.cancelledMergePreparationIds?.includes(input.requestId))
        throw new NodeMutationConflict("整体压缩已停止，请使用新的请求重试。");
      const requestedParents = contextParentInput(input.contextParents)!;
      if (requestedParents.length < 2)
        throw new NodeMutationConflict("整体压缩需要接入至少两个分支。");
      const contextParents = this.resolveContextParents(
        workspace,
        input.parentId,
        requestedParents,
        {},
      )!;
      const context = buildContext(workspace, input.parentId, contextParents);
      if (context.ids.some((id) => this.active.has(id)))
        throw new NodeMutationConflict("接入分支仍在收尾，请稍后重试。");
      const key = `${workspace.id}:${input.requestId}`;
      const previous = workspace.mergePreparationRequests?.find(
        (request) => request.requestId === input.requestId,
      );
      if (previous) {
        if (
          previous.parentId !== input.parentId ||
          !contextParentsMatch(
            previous.contextParentsRequest,
            requestedParents,
          ) ||
          !contextParentsMatch(previous.contextParents, contextParents) ||
          !runConfigsMatch(previous.config, input.config)
        )
          throw new NodeMutationConflict("请求 ID 已用于其他整体压缩内容。");
        const job = this.mergeContextJobs.get(key);
        if (job) return { promise: job.promise };
        if (previous.status !== "completed")
          throw new NodeMutationConflict(
            previous.error ?? "整体压缩已中断，请使用新的请求重试。",
          );
        const checkpoint = this.mergedPreparationCheckpoint(
          workspace,
          previous.checkpoint?.id,
          input.parentId,
          requestedParents,
          contextParents,
          input.config,
          context,
        );
        if (!checkpoint)
          throw new NodeMutationConflict("整体摘要不存在，请重新压缩。");
        return { promise: Promise.resolve(checkpoint) };
      }
      if (
        workspace.pendingNodeRetry ||
        this.findRequest(workspace, input.requestId) ||
        this.preparationRequestExists(workspace, input.requestId)
      )
        throw new NodeMutationConflict(
          "已有未完成的文件回溯，或请求 ID 已用于其他任务。",
        );
      if (this.contextJobs.size + this.mergeContextJobs.size >= 3)
        throw new Error("已有 3 条路径正在生成摘要，请稍后重试。");
      const model = this.runtime
        .models()
        .find((item) => item.id === input.config.model);
      if (!model?.available || model.demo)
        throw new Error("生成摘要需要选择已配置的真实模型。");
      if (!model.thinkingLevels.includes(input.config.thinking))
        throw new Error("该模型不支持所选思考强度。");
      if (!this.runtime.prepareContext)
        throw new Error("当前运行时不支持上下文压缩。");
      const controller = new AbortController();
      const request: NonNullable<
        StoredWorkspace["mergePreparationRequests"]
      >[number] = {
        requestId: input.requestId,
        parentId: input.parentId,
        contextParentsRequest: requestedParents.map((parent, i) => ({
          ...parent,
          revision: contextParents[i].revision,
        })),
        contextParents: structuredClone(contextParents),
        config: { ...input.config },
        status: "compacting",
      };
      const job = {
        workspaceId,
        sourceIds: [...context.ids],
        controller,
        promise: Promise.resolve(undefined as unknown as ContextCheckpoint),
      };
      this.mergeContextJobs.set(key, job);
      (workspace.mergePreparationRequests ??= []).push(request);
      this.store.touch(workspace);
      try {
        await this.store.save();
      } catch (error) {
        request.status = "failed";
        request.error = safeError(error);
        this.mergeContextJobs.delete(key);
        this.store.touch(workspace);
        throw error;
      }
      const assertCurrent = () => {
        controller.signal.throwIfAborted();
        const current = buildContext(workspace, input.parentId, contextParents);
        const parents = this.resolveContextParents(
          workspace,
          input.parentId,
          request.contextParentsRequest,
          {},
        );
        if (
          this.closed ||
          !this.store.data.workspaces.includes(workspace) ||
          !contextParentsMatch(contextParents, parents) ||
          JSON.stringify(current.sources) !== JSON.stringify(context.sources) ||
          JSON.stringify(current.messages) !== JSON.stringify(context.messages)
        )
          throw new NodeMutationConflict(
            "接入分支已改变，未采用过期的整体摘要。",
          );
      };
      const parent = workspace.nodes.find(
        (node) => node.id === input.parentId,
      )!;
      const draft: StoredNode = {
        ...parent,
        id: `merge-preparation:${input.requestId}`,
        parentId: input.parentId,
        contextParents,
        contextMode: undefined,
        effectiveContextMode: undefined,
      };
      job.promise = (async () => {
        try {
          assertCurrent();
          const prepared = await this.runtime.prepareContext!(
            request.config,
            structuredClone(context.messages),
            controller.signal,
            {
              autoCompact: true,
              mergeContext: true,
              sources: context.sources,
              checkpoints: contextCheckpoints(workspace, context.ids),
              branchCheckpoints: this.branchCheckpoints(
                workspace,
                draft,
                context.ids,
              ),
              contextBranches: this.contextBranches(workspace, draft),
            },
          );
          assertCurrent();
          if (
            !prepared ||
            prepared.messageCount !== context.messages.length ||
            !checkpointMatches(prepared, context.messages, context.sources)
          )
            throw new Error("整体摘要来源校验失败，未保存压缩结果。");
          const checkpoint: ContextCheckpoint = {
            ...structuredClone(prepared),
            purpose: "merge",
          };
          request.checkpoint = checkpoint;
          request.status = "completed";
          this.store.touch(workspace);
          await this.store.save();
          assertCurrent();
          return checkpoint;
        } catch (error) {
          request.status = controller.signal.aborted ? "cancelled" : "failed";
          request.checkpoint = undefined;
          request.error = controller.signal.aborted
            ? "整体压缩已停止，原始分支保持完整。"
            : safeError(error);
          this.store.touch(workspace);
          await this.store.save().catch(() => {});
          throw error;
        } finally {
          this.mergeContextJobs.delete(key);
        }
      })();
      void job.promise.catch(() => {});
      return { promise: job.promise };
    });
    return task.promise;
  }

  async cancelMergeContext(workspaceId: string, requestId: string) {
    return this.serializeMutation(workspaceId, async () => {
      const workspace = this.store.workspace(workspaceId);
      const request = workspace.mergePreparationRequests?.find(
        (item) => item.requestId === requestId,
      );
      if (
        !request &&
        (this.findRequest(workspace, requestId) ||
          this.preparationRequestExists(workspace, requestId))
      ) {
        if (workspace.cancelledMergePreparationIds?.includes(requestId)) return;
        throw new NodeMutationConflict(
          "请求 ID 属于其他任务，不能停止整体压缩。",
        );
      }
      if (!workspace.cancelledMergePreparationIds?.includes(requestId))
        (workspace.cancelledMergePreparationIds ??= []).push(requestId);
      this.mergeContextJobs
        .get(`${workspaceId}:${requestId}`)
        ?.controller.abort(new Error("整体压缩已停止。"));
      if (request) {
        request.status = "cancelled";
        request.checkpoint = undefined;
        request.error = "整体压缩已停止，原始分支保持完整。";
      }
      this.store.touch(workspace);
      await this.store.save();
    });
  }

  /** Manual preparation is an explicit request, not a mutation of the completed answer. */
  async compactContext(
    workspaceId: string,
    nodeId: string,
    input: { config: RunConfig; expectedRevision: number; requestId: string },
  ): Promise<ContextCheckpoint | undefined> {
    validateLongTask(input.config.longTask);
    const task = await this.serializeMutation(workspaceId, async () => {
      const workspace = this.store.workspace(workspaceId);
      this.assertWorkspaceNotDeleting(workspace);
      if (this.closed) throw new Error("服务正在关闭，请稍后重试。");
      if (this.store.storageError) throw new Error(this.store.storageError);
      const node = workspace.nodes.find((item) => item.id === nodeId);
      if (!node || node.status !== "completed" || node.contextStale)
        throw new NodeMutationConflict(
          "请在已完成且上下文有效的节点上生成摘要。",
        );
      if ((node.revision ?? 0) !== input.expectedRevision)
        throw new NodeMutationConflict(
          "节点版本已改变，请刷新后重新生成摘要。",
        );
      const previousRequest = node.preparationRequests?.find(
        (request) => request.requestId === input.requestId,
      );
      if (previousRequest?.requestId === input.requestId) {
        if (
          previousRequest.revision !== input.expectedRevision ||
          !runConfigsMatch(previousRequest.config, input.config)
        )
          throw new NodeMutationConflict("请求 ID 已用于其他摘要内容。");
        const active = this.contextJobs.get(node.id);
        if (active?.requestId === input.requestId)
          return { promise: active.promise };
        if (previousRequest.status !== "completed")
          throw new Error(
            previousRequest.error ?? "摘要任务已中断，请使用新的请求重试。",
          );
        return { promise: Promise.resolve(previousRequest.checkpoint) };
      }
      if (
        this.findRequest(workspace, input.requestId) ||
        this.preparationRequestExists(workspace, input.requestId)
      )
        throw new NodeMutationConflict("请求 ID 已用于其他任务。");
      if (this.contextJobs.has(node.id))
        throw new NodeMutationConflict(
          "此路径正在生成摘要，请等待或停止后再试。",
        );
      if (this.contextJobs.size + this.mergeContextJobs.size >= 3)
        throw new Error("已有 3 条路径正在生成摘要，请稍后重试。");
      const model = this.runtime
        .models()
        .find((item) => item.id === input.config.model);
      if (!model?.available || model.demo)
        throw new Error("生成摘要需要选择已配置的真实模型。");
      if (!model.thinkingLevels.includes(input.config.thinking))
        throw new Error("该模型不支持所选思考强度。");
      if (!this.runtime.prepareContext)
        throw new Error("当前运行时不支持上下文压缩。");
      const context = buildContext(workspace, node.id);
      const previousCheckpoint = node.preparedCompaction;
      const controller = new AbortController();
      const job = {
        requestId: input.requestId,
        controller,
        promise: Promise.resolve<ContextCheckpoint | undefined>(undefined),
      };
      this.contextJobs.set(node.id, job);
      const request: NonNullable<StoredNode["preparationRequests"]>[number] = {
        requestId: input.requestId,
        config: { ...input.config },
        revision: input.expectedRevision,
        status: "compacting",
      };
      (node.preparationRequests ??= []).push(request);
      node.preparedContextState = {
        status: "compacting",
        updatedAt: Date.now(),
      };
      this.store.touch(workspace);
      try {
        await this.store.save();
      } catch (error) {
        node.preparedContextState = {
          status: "failed",
          updatedAt: Date.now(),
          error: safeError(error),
        };
        request.status = "failed";
        request.error = safeError(error);
        this.contextJobs.delete(node.id);
        this.store.touch(workspace);
        throw error;
      }
      const assertCurrent = () => {
        controller.signal.throwIfAborted();
        if (
          this.closed ||
          !workspace.nodes.includes(node) ||
          node.contextStale ||
          (node.revision ?? 0) !== input.expectedRevision ||
          JSON.stringify(buildContext(workspace, node.id).sources) !==
            JSON.stringify(context.sources)
        )
          throw new NodeMutationConflict(
            "摘要来源已改变，未采用过期的压缩结果。",
          );
      };
      job.promise = (async () => {
        let terminalState: ContextState | undefined;
        try {
          assertCurrent();
          const checkpoint = await this.runtime.prepareContext!(
            input.config,
            context.messages,
            controller.signal,
            {
              autoCompact: true,
              mergeContext: context.ids.some(
                (id) =>
                  (workspace.nodes.find((item) => item.id === id)
                    ?.contextParents?.length ?? 0) > 1,
              ),
              branchCheckpoints: this.branchCheckpoints(
                workspace,
                node,
                context.ids,
              ),
              contextBranches: this.contextBranches(workspace, node),
              sources: context.sources,
              checkpoints: contextCheckpoints(workspace, context.ids),
              onState: async (state) => {
                // Cancellation is terminal for this request, even if a provider replies late.
                if (controller.signal.aborted && state.status !== "cancelled")
                  return;
                if (state.status === "compacted" || state.status === "full") {
                  terminalState = state;
                  return;
                }
                node.preparedContextState = {
                  ...state,
                  error: state.error ? safeError(state.error) : undefined,
                };
                this.store.touch(workspace);
                await this.store.save();
              },
            },
          );
          assertCurrent();
          if (
            checkpoint &&
            !checkpointMatches(checkpoint, context.messages, context.sources)
          )
            throw new Error("摘要来源校验失败，未保存压缩结果。");
          node.preparedCompaction = checkpoint ?? previousCheckpoint;
          node.preparedContextState = terminalState ?? {
            status: checkpoint ? "compacted" : "full",
            updatedAt: Date.now(),
          };
          request.status = "completed";
          request.checkpoint = checkpoint;
          this.store.touch(workspace);
          await this.store.save();
          assertCurrent();
          return checkpoint;
        } catch (error) {
          node.preparedCompaction = previousCheckpoint;
          request.status = controller.signal.aborted ? "cancelled" : "failed";
          request.checkpoint = undefined;
          request.error = controller.signal.aborted
            ? "摘要生成已停止，原始历史保持完整。"
            : safeError(error);
          node.preparedContextState = {
            ...node.preparedContextState,
            status: controller.signal.aborted ? "cancelled" : "failed",
            updatedAt: Date.now(),
            error: controller.signal.aborted
              ? "摘要生成已停止，原始历史保持完整。"
              : safeError(error),
          };
          this.store.touch(workspace);
          await this.store.save().catch(() => {});
          throw error;
        } finally {
          this.contextJobs.delete(node.id);
        }
      })();
      // The caller awaits the same promise outside the workspace mutation lock.
      void job.promise.catch(() => {});
      return { promise: job.promise };
    });
    return task.promise;
  }

  private serializeMutation<T>(
    workspaceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.mutations.get(workspaceId) ?? Promise.resolve();
    const mutation = previous.catch(() => {}).then(operation);
    this.mutations.set(workspaceId, mutation);
    const clear = () => {
      if (this.mutations.get(workspaceId) === mutation)
        this.mutations.delete(workspaceId);
    };
    void mutation.then(clear, clear);
    return mutation;
  }

  private findRequest(
    workspace: StoredWorkspace,
    requestId: string,
  ): { node: StoredNode; run: StoredNode | StoredRun } | undefined {
    for (const node of workspace.nodes) {
      if (node.requestId === requestId) return { node, run: node };
      const run = node.previousRuns?.find(
        (previous) => previous.requestId === requestId,
      );
      if (run) return { node, run };
    }
  }

  private subtree(workspace: StoredWorkspace, nodeId: string): StoredNode[] {
    const ids = new Set([nodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of workspace.nodes) {
        if (
          directParentIds(node).some((id) => ids.has(id)) &&
          !ids.has(node.id)
        ) {
          ids.add(node.id);
          changed = true;
        }
      }
    }
    return workspace.nodes.filter((node) => ids.has(node.id));
  }

  private assertMutable(
    workspace: StoredWorkspace,
    nodeId: string,
    expectedRevision: number,
    allowPendingRetry = false,
  ) {
    this.assertWorkspaceNotDeleting(workspace);
    if (this.closed) throw new Error("服务正在关闭，请稍后重试。");
    if (this.store.storageError) throw new Error(this.store.storageError);
    if (workspace.pendingNodeRetry && !allowPendingRetry)
      throw new NodeMutationConflict(
        "此画布还有未完成的文件回溯，请先完成对应卡片的原地重试。",
      );
    const node = workspace.nodes.find((item) => item.id === nodeId);
    if (!node) throw new NodeMutationConflict("节点已不存在，请刷新后重试。");
    if (node.status === "root" || node.parentId === null)
      throw new Error("探索根节点不能重新生成或删除。");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error("节点版本无效。");
    if ((node.revision ?? 0) !== expectedRevision)
      throw new NodeMutationConflict(
        "节点已被修改，请重新打开当前节点后再操作。",
      );
    const subtree = this.subtree(workspace, nodeId);
    if (
      subtree.some(
        (item) =>
          item.status === "running" ||
          item.status === "queued" ||
          this.active.has(item.id) ||
          this.runtime.hasSubagentWork?.(this.subagentOwner(item)) ||
          this.contextJobs.has(item.id) ||
          [...this.mergeContextJobs.values()].some(
            (job) =>
              job.workspaceId === workspace.id &&
              job.sourceIds.includes(item.id),
          ),
      )
    )
      throw new NodeMutationConflict(
        "此节点或其后代仍在运行、排队或收尾，请等待结束后再操作。",
      );
    return { node, subtree };
  }

  regenerate(
    workspaceId: string,
    nodeId: string,
    input: {
      prompt: string;
      referenceNodeIds?: string[];
      toolRequests?: ToolRequest[];
      config: RunConfig;
      requestId: string;
      expectedRevision: number;
      contextCheckpointId?: string;
      contextMode?: "raw";
    },
  ) {
    return this.serializeMutation(workspaceId, async () => {
      const workspace = this.store.workspace(workspaceId);
      this.validateContextSelection(input);
      validateLongTask(input.config.longTask);
      const references = referenceNodeIds(input.referenceNodeIds);
      const requestedTools = validateToolRequests(input.toolRequests);
      if (this.preparationRequestExists(workspace, input.requestId))
        throw new NodeMutationConflict(
          "请求 ID 已用于摘要任务，请使用新的请求 ID。",
        );
      if (workspace.pendingNodeRetry?.requestId === input.requestId)
        throw new NodeMutationConflict(
          "请求 ID 已用于原地重试，请继续原请求。",
        );
      if (
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0
      )
        throw new Error("节点版本无效。");
      const duplicate = this.findRequest(workspace, input.requestId);
      if (duplicate) {
        const previous = [
          duplicate.node,
          ...(duplicate.node.previousRuns ?? []),
        ].find((run) => (run.revision ?? 0) === input.expectedRevision);
        const requestedCheckpointId =
          input.contextCheckpointId ??
          (input.contextMode
            ? undefined
            : previous?.requestedContextCheckpointId);
        const contextMode =
          input.contextMode ??
          (input.contextCheckpointId ? undefined : previous?.contextMode);
        const selectionRequest = duplicate.run.contextSelectionRequest;
        const selectionMatches = selectionRequest
          ? selectionRequest.contextCheckpointId ===
              input.contextCheckpointId &&
            selectionRequest.contextMode === input.contextMode
          : duplicate.run.requestedContextCheckpointId ===
              requestedCheckpointId &&
            duplicate.run.contextMode === contextMode;
        if (
          duplicate.run.requestKind === "retry" ||
          duplicate.node.id !== nodeId ||
          (duplicate.run.revision ?? 0) !== input.expectedRevision + 1 ||
          duplicate.run.prompt !== input.prompt ||
          JSON.stringify(duplicate.run.toolRequests ?? []) !==
            JSON.stringify(requestedTools ?? previous?.toolRequests ?? []) ||
          !referenceSelectionMatches(
            duplicate.run.contextReferences,
            references,
            previous?.contextReferences,
          ) ||
          !runConfigsMatch(duplicate.run.config, input.config) ||
          !selectionMatches
        )
          throw new NodeMutationConflict(
            "请求 ID 已用于其他内容，请重新发送。",
          );
        return duplicate.node;
      }
      const { node, subtree } = this.assertMutable(
        workspace,
        nodeId,
        input.expectedRevision,
      );
      if (input.expectedRevision === Number.MAX_SAFE_INTEGER)
        throw new Error("节点版本已超过可支持范围。");
      const model = this.runtime
        .models()
        .find((item) => item.id === input.config.model);
      if (!model?.available)
        throw new Error(
          `模型未配置。请设置 ${model?.envVar ?? "相应的 API Key"} 后重启服务。`,
        );
      if (!model.thinkingLevels.includes(input.config.thinking))
        throw new Error("该模型不支持所选思考强度。");
      const toolRequests = requestedTools ?? node.toolRequests;
      this.validateRequestedTools(toolRequests, model);
      if (
        !model.demo &&
        model.supportsImages === false &&
        node.attachmentData?.some((file) => file.metadata.kind === "image")
      )
        throw new Error("当前模型不支持图片输入，请选择支持图片的模型。");
      if (!model.demo)
        this.assertDirectoryAvailable(
          this.store.effectiveWorkingDirectory(workspace),
        );
      // Re-select current revisions when intentionally regenerating a stale answer.
      const contextParents = this.resolveContextParents(
        workspace,
        node.parentId!,
        node.contextParents,
        {},
        true,
      );
      // Build from the parent; the old question, answer and transcript are never replayed.
      const context = buildContext(workspace, node.parentId!, contextParents);
      const contextReferences = resolveContextReferences(
        workspace,
        references,
        node.contextReferences,
      );
      const selection = this.contextSelection(
        workspace,
        workspace.nodes.find((item) => item.id === node.parentId)!,
        input,
        node,
        contextParents,
      );
      this.validateRequestedContext(
        workspace,
        selection.effectiveContextCheckpointId,
        context,
        node.compactions,
      );
      const { previousRuns = [], ...previous } = node;
      const archived: StoredRun = {
        ...structuredClone(previous),
        archivedAt: Date.now(),
      };
      for (const call of archived.toolCalls ?? []) {
        if (call.authorization && !call.authorization.consumedAt) {
          call.authorization.invalidatedAt = Date.now();
          call.authorization.invalidationReason =
            "节点已重新生成，旧运行授权失效。";
        }
      }
      const regenerated: StoredNode = {
        id: node.id,
        parentId: node.parentId,
        contextParents,
        position: { ...node.position },
        color: node.color,
        createdAt: node.createdAt,
        revision: input.expectedRevision + 1,
        prompt: input.prompt,
        contextReferences,
        toolRequests: structuredClone(toolRequests),
        attachments: structuredClone(node.attachments),
        attachmentData: structuredClone(node.attachmentData),
        attachmentInputHash: node.attachmentInputHash,
        response: "",
        status: "queued",
        config: { ...input.config },
        contextIds: context.ids,
        contextSources: context.sources,
        ...selection,
        compactions: structuredClone(
          node.compactions?.filter(
            (checkpoint) =>
              checkpoint.id === selection.effectiveContextCheckpointId,
          ),
        ),
        preparedCompactions: structuredClone(preparedContextCheckpoints(node)),
        contextSelectionRequest: {
          contextCheckpointId: input.contextCheckpointId,
          contextMode: input.contextMode,
        },
        contextStale: false,
        requestId: input.requestId,
        previousRuns: [...previousRuns, archived],
        execution: !model.demo
          ? {
              workingDirectory:
                await this.store.prepareWorkingDirectory(workspace),
              approvalMode: workspace.approvalMode ?? "ask",
              safetyModel: workspace.safetyModel,
            }
          : undefined,
      };
      if (this.closed) throw new Error("服务正在关闭，请稍后重试。");
      this.assertDirectoryAvailable(regenerated.execution?.workingDirectory);
      await Promise.all(subtree.map((node) => this.closeSubagentHost(node)));
      const ids = new Set(subtree.map((item) => item.id));
      const nodes = workspace.nodes.map((item) =>
        item.id === nodeId
          ? regenerated
          : ids.has(item.id)
            ? { ...item, contextStale: true }
            : item,
      );
      // Stage the replacement until atomic persistence succeeds. Active sibling
      // objects are retained so their concurrent streaming updates remain live.
      await this.store.save({ workspace, values: { nodes } });
      for (const item of subtree) this.authorizations.revokeNode(item.id);
      this.queue.push({ workspace, node: regenerated });
      this.pump();
      return regenerated;
    });
  }

  retry(
    workspaceId: string,
    nodeId: string,
    input: { requestId: string; expectedRevision: number },
  ) {
    return this.serializeMutation(workspaceId, async () => {
      const workspace = this.store.workspace(workspaceId);
      if (this.preparationRequestExists(workspace, input.requestId))
        throw new NodeMutationConflict(
          "请求 ID 已用于摘要任务，请使用新的请求 ID。",
        );
      if (
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0
      )
        throw new Error("节点版本无效。");
      const duplicate = this.findRequest(workspace, input.requestId);
      if (duplicate) {
        if (
          duplicate.run.requestKind !== "retry" ||
          duplicate.node.id !== nodeId ||
          (duplicate.run.revision ?? 0) !== input.expectedRevision + 1
        )
          throw new NodeMutationConflict(
            "请求 ID 已用于其他内容，请重新发送。",
          );
        return duplicate.node;
      }
      const pending = workspace.pendingNodeRetry;
      if (
        pending &&
        (pending.nodeId !== nodeId ||
          pending.expectedRevision !== input.expectedRevision ||
          pending.requestId !== input.requestId)
      )
        throw new NodeMutationConflict(
          "此画布已有未完成的文件回溯，请继续原卡片的同一重试请求。",
        );
      // A failed disk write must not permanently strand an already journaled
      // restoration. Revalidate persistence before any attempt to continue it.
      if (this.store.storageError) await this.store.save();
      const { node, subtree } = this.assertMutable(
        workspace,
        nodeId,
        input.expectedRevision,
        true,
      );
      if (node.status !== "failed" && node.status !== "cancelled")
        throw new NodeMutationConflict("只有失败或已停止的卡片可以原地重试。");
      validateLongTask(node.config.longTask);
      if (input.expectedRevision === Number.MAX_SAFE_INTEGER)
        throw new Error("节点版本已超过可支持范围。");
      const model = this.runtime
        .models()
        .find((item) => item.id === node.config.model);
      if (!model?.available)
        throw new Error(
          `模型未配置。请设置 ${model?.envVar ?? "相应的 API Key"} 后重启服务。`,
        );
      if (!model.thinkingLevels.includes(node.config.thinking))
        throw new Error("该模型不支持所选思考强度。");
      this.validateRequestedTools(node.toolRequests, model);
      const contextParents = this.resolveContextParents(
        workspace,
        node.parentId!,
        node.contextParents,
        {},
        true,
      );
      const context = buildContext(workspace, node.parentId!, contextParents);
      const selection = this.contextSelection(
        workspace,
        workspace.nodes.find((item) => item.id === node.parentId)!,
        {},
        node,
        contextParents,
      );
      this.validateRequestedContext(
        workspace,
        selection.effectiveContextCheckpointId,
        context,
        node.compactions,
      );

      const directory = node.execution?.workingDirectory;
      const history = (workspace.gitHistory ?? []).filter(
        (entry) =>
          entry.nodeId === nodeId &&
          entry.nodeRevision === input.expectedRevision,
      );
      for (const entry of history) {
        if (
          entry.status !== "completed" ||
          !entry.commit ||
          !entry.parentCommit
        )
          throw new NodeMutationConflict(
            "本次运行有不完整的 Git 快照，无法确认文件原状态，未启动原地重试。",
          );
        if (!directory || entry.workingDirectory !== directory)
          throw new NodeMutationConflict(
            "Git 快照与本卡片原工作目录不一致，未启动原地重试。",
          );
      }
      for (const call of node.toolCalls ?? []) {
        if (!["write", "edit", "bash"].includes(call.name)) continue;
        if (
          call.status === "denied" ||
          call.status === "awaiting_approval" ||
          call.status === "reviewing" ||
          (call.authorization && !call.authorization.consumedAt)
        )
          continue;
        if (call.fileSnapshot === "unchanged") continue;
        if (
          call.fileSnapshot === "failed" ||
          !history.some((entry) => entry.toolCallId === call.id)
        )
          throw new NodeMutationConflict(
            "本次文件操作缺少完整 Git 快照，无法安全回溯；请先检查文件后再从父节点重试。",
          );
      }
      if (directory) {
        // Canonicalize again before taking the lock; never switch an old card to
        // a newly selected project or follow a replaced directory symlink.
        let canonical: string;
        try {
          canonical = await workingDirectory(directory);
        } catch (error) {
          throw new NodeMutationConflict(
            `本卡片原工作目录不可访问：${safeError(error)}`,
          );
        }
        if (canonical !== directory)
          throw new NodeMutationConflict(
            "本卡片原工作目录的实际路径已改变，未启动原地重试。",
          );
        this.assertDirectoryAvailable(directory);
        this.assertNoPendingRestore(directory, workspace.id);
      }
      if (
        pending &&
        (pending.workingDirectory !== directory ||
          pending.plan.workingDirectory !== directory ||
          pending.plan.workspaceId !== workspaceId)
      )
        throw new NodeMutationConflict(
          "文件回溯计划与本卡片原工作目录不一致。",
        );
      const toRestore = history.filter((entry) => !entry.restoredAt);
      const restorePaths = pending
        ? pending.plan.files.map((file) => file.path)
        : toRestore.flatMap((entry) => entry.files.map((file) => file.path));
      const lock = `retry:${workspaceId}:${input.requestId}`;
      if (directory) this.activeDirectories.set(lock, directory);
      let releaseFiles: (() => void) | undefined;
      try {
        if (directory && restorePaths.length) {
          // Completed history lists are checked against the actual Git trees by
          // prepareRestore before any write. No changes means no file lock.
          const resource = await resolveRestoreFileResource(
            directory,
            restorePaths,
          );
          releaseFiles = await this.fileOperations.acquire(
            resource,
            this.maintenanceController.signal,
          );
          const current = await resolveRestoreFileResource(
            directory,
            restorePaths,
          );
          if (
            resource?.workingDirectory !== directory ||
            JSON.stringify(resource) !== JSON.stringify(current)
          )
            throw new NodeMutationConflict(
              "等待期间回溯文件路径或工作目录已变化，请重新原地重试。",
            );
        }
        if (this.closed) throw new Error("服务正在关闭，未启动文件回溯。");
        let journal: PendingNodeRetry | undefined = pending;
        if (!journal && toRestore.length) {
          try {
            const plan = await this.store.gitSnapshots.prepareRestore(
              workspaceId,
              directory!,
              toRestore,
            );
            journal = {
              nodeId,
              expectedRevision: input.expectedRevision,
              requestId: input.requestId,
              workingDirectory: directory!,
              plan,
              historyIds: toRestore.map((entry) => entry.id),
              status: "restoring",
              createdAt: Date.now(),
            };
          } catch (error) {
            throw new NodeMutationConflict(
              `无法回溯本卡片的文件修改：${safeError(error)}`,
            );
          }
          // Write ahead: no filesystem mutation can precede the durable plan.
          await this.store.save({
            workspace,
            values: { pendingNodeRetry: journal },
          });
        }
        if (journal) {
          try {
            // Recheck even an already-restored journal after a lost HTTP response
            // or failed save. applyRestore accepts both expected and target states.
            await this.store.gitSnapshots.applyRestore(journal.plan);
          } catch (error) {
            journal.status = "failed";
            journal.error = `文件回溯未完成：${safeError(error)}；未启动原地重试。`;
            this.store.touch(workspace);
            await this.store.save();
            throw new NodeMutationConflict(journal.error);
          }
          journal.status = "restored";
          journal.restoredAt ??= Date.now();
          journal.error = undefined;
          this.store.markGitHistoryRestored(workspace, journal);
          this.store.touch(workspace);
          await this.store.save();
        }
        if (this.closed)
          throw new Error("服务正在关闭；已回溯的文件已保留，请稍后原地重试。");
        const { previousRuns = [], ...previous } = node;
        const archived: StoredRun = {
          ...structuredClone(previous),
          archivedAt: Date.now(),
        };
        for (const call of archived.toolCalls ?? []) {
          if (call.authorization && !call.authorization.consumedAt) {
            call.authorization.invalidatedAt = Date.now();
            call.authorization.invalidationReason =
              "节点已原地重试，旧运行授权失效。";
          }
        }
        const retried: StoredNode = {
          id: node.id,
          parentId: node.parentId,
          contextParents,
          position: { ...node.position },
          color: node.color,
          createdAt: node.createdAt,
          revision: input.expectedRevision + 1,
          prompt: node.prompt,
          contextReferences: structuredClone(node.contextReferences),
          toolRequests: structuredClone(node.toolRequests),
          attachments: structuredClone(node.attachments),
          attachmentData: structuredClone(node.attachmentData),
          attachmentInputHash: node.attachmentInputHash,
          response: "",
          status: "queued",
          config: { ...node.config },
          contextIds: context.ids,
          contextSources: context.sources,
          ...selection,
          compactions: structuredClone(
            node.compactions?.filter(
              (checkpoint) =>
                checkpoint.id === selection.effectiveContextCheckpointId,
            ),
          ),
          preparedCompactions: structuredClone(
            preparedContextCheckpoints(node),
          ),
          contextStale: false,
          requestId: input.requestId,
          requestKind: "retry",
          previousRuns: [...previousRuns, archived],
          execution: node.execution
            ? {
                ...node.execution,
                approvalMode: workspace.approvalMode ?? "ask",
                safetyModel: workspace.safetyModel,
              }
            : undefined,
        };
        await Promise.all(subtree.map((node) => this.closeSubagentHost(node)));
        const ids = new Set(subtree.map((item) => item.id));
        const nodes = workspace.nodes.map((item) =>
          item.id === nodeId
            ? retried
            : ids.has(item.id)
              ? { ...item, contextStale: true }
              : item,
        );
        await this.store.save({
          workspace,
          values: { nodes, pendingNodeRetry: undefined },
        });
        for (const item of subtree) this.authorizations.revokeNode(item.id);
        // A restore reservation may have paused already-submitted jobs. Run its
        // owning card first, then release the other jobs through the normal pump.
        this.queue.unshift({ workspace, node: retried });
        return retried;
      } finally {
        releaseFiles?.();
        this.activeDirectories.delete(lock);
        this.pump();
      }
    });
  }

  private assertNoPendingRestore(directory: string, ownWorkspaceId?: string) {
    if (
      [...this.activeDirectories.entries()].some(
        ([id, active]) =>
          id.startsWith("retry:") && directoriesOverlap(directory, active),
      ) ||
      this.store.data.workspaces.some(
        (workspace) =>
          workspace.id !== ownWorkspaceId &&
          workspace.pendingNodeRetry &&
          directoriesOverlap(
            directory,
            workspace.pendingNodeRetry.workingDirectory,
          ),
      )
    )
      throw new NodeMutationConflict(
        "此工作目录正在等待原地重试完成文件回溯，请先完成对应卡片的重试。",
      );
  }

  private async assertNoPendingFileRestore(resource: FileOperationResource) {
    for (const workspace of this.store.data.workspaces) {
      const pending = workspace.pendingNodeRetry;
      if (!pending) continue;
      const restore = await resolveRestoreFileResource(
        pending.workingDirectory,
        pending.plan.files.map((file) => file.path),
      );
      if (
        workspace.pendingNodeRetry === pending &&
        restore &&
        fileOperationsConflict(resource, restore)
      )
        throw new NodeMutationConflict(
          "此文件还有未完成的回溯，请先完成对应卡片的原地重试。",
        );
    }
  }

  private directoryInUse(directory: string, ownWorkspaceId: string) {
    return (
      [...this.activeDirectories.values()].some((active) =>
        directoriesOverlap(directory, active),
      ) ||
      this.store.data.workspaces.some((workspace) =>
        workspace.nodes.some(
          (node) =>
            (node.status === "running" ||
              node.status === "queued" ||
              this.runtime.hasSubagentWork?.(this.subagentOwner(node))) &&
            node.execution?.workingDirectory &&
            directoriesOverlap(directory, node.execution.workingDirectory),
        ),
      ) ||
      this.queue.some(
        (job) =>
          job.node.execution?.workingDirectory &&
          directoriesOverlap(directory, job.node.execution.workingDirectory),
      ) ||
      this.store.data.workspaces.some(
        (workspace) =>
          workspace.id !== ownWorkspaceId &&
          workspace.pendingNodeRetry &&
          directoriesOverlap(
            directory,
            workspace.pendingNodeRetry.workingDirectory,
          ),
      )
    );
  }

  private assertWorkspaceNotDeleting(workspace: StoredWorkspace) {
    if (workspace.pendingWorkspaceDeletion)
      throw new NodeMutationConflict(
        "此探索的临时目录清理尚未完成，请重新打开删除面板，勾选清理临时目录后重试删除。",
      );
  }

  assertDirectoryAvailable(directory?: string) {
    if (!directory) return;
    const deleting = [
      ...this.deletingDirectories.values(),
      ...this.store.data.workspaces.flatMap((workspace) =>
        workspace.pendingWorkspaceDeletion
          ? [this.store.temporaryDirectory(workspace)]
          : [],
      ),
    ];
    if (deleting.some((target) => directoriesOverlap(target, directory)))
      throw new NodeMutationConflict(
        "此工作目录正在清理，请完成对应探索的删除后再使用。",
      );
  }

  deleteWorkspace(
    workspaceId: string,
    input: { deleteTemporaryDirectory?: boolean; expectedNodeIds: string[] },
  ) {
    return this.serializeMutation(workspaceId, async () => {
      const workspace = this.store.workspace(workspaceId);
      if (this.closed) throw new Error("服务正在关闭，请稍后重试。");
      const expected = new Set(input.expectedNodeIds);
      if (
        expected.size !== input.expectedNodeIds.length ||
        expected.size !== workspace.nodes.length ||
        workspace.nodes.some((node) => !expected.has(node.id))
      )
        throw new NodeMutationConflict(
          "探索中的节点已发生变化，请重新确认删除范围。",
        );
      if (
        workspace.nodes.some(
          (node) =>
            node.status === "running" ||
            node.status === "queued" ||
            this.active.has(node.id) ||
            this.runtime.hasSubagentWork?.(this.subagentOwner(node)) ||
            this.contextJobs.has(node.id) ||
            node.toolCalls?.some((call) =>
              ["running", "reviewing", "awaiting_approval"].includes(
                call.status,
              ),
            ),
        ) ||
        this.queue.some((job) => job.workspace.id === workspaceId) ||
        [...this.mergeContextJobs.values()].some(
          (job) => job.workspaceId === workspaceId,
        )
      )
        throw new NodeMutationConflict(
          "此探索仍有任务运行、排队或收尾，请等待结束后再删除。",
        );
      if (
        workspace.pendingNodeRetry ||
        workspace.pendingGitSnapshots?.length ||
        workspace.gitHistory?.some((entry) => entry.status === "recording")
      )
        throw new NodeMutationConflict(
          "此探索还有未完成的文件回溯或快照保存，请完成后再删除。",
        );
      if (workspace.pendingWorkspaceDeletion && !input.deleteTemporaryDirectory)
        throw new NodeMutationConflict(
          "临时目录清理已开始，部分文件可能已删除；请勾选清理临时目录后重试删除。",
        );

      // Retry failed persistence before continuing an explicitly confirmed cleanup.
      if (this.store.storageError) await this.store.save();
      const directory = this.store.temporaryDirectory(workspace);
      const lock = `delete:${workspaceId}`;
      if (input.deleteTemporaryDirectory) {
        if (
          this.directoryInUse(directory, workspaceId) ||
          [...this.configuringDirectories.values()].some((target) =>
            directoriesOverlap(directory, target),
          )
        )
          throw new NodeMutationConflict(
            "临时目录或其父子目录仍有任务运行、排队、回溯或正在绑定，请等待结束后再删除。",
          );
        // Reserve before asynchronous filesystem checks; new runs, bindings and
        // restorations cannot enter the directory during cleanup or persistence.
        this.deletingDirectories.set(workspaceId, directory);
        this.activeDirectories.set(lock, directory);
      }
      let releaseFiles: (() => void) | undefined;
      try {
        if (input.deleteTemporaryDirectory) {
          releaseFiles = await this.fileOperations.acquire(
            { global: true, mode: "write", workingDirectory: directory },
            this.maintenanceController.signal,
          );
          if (this.closed) throw new Error("服务正在关闭，未清理临时目录。");
          for (const other of this.store.data.workspaces) {
            const selected = other.workingDirectory;
            if (!selected) continue;
            let canonical = selected;
            try {
              canonical = await realpath(selected);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
            if (
              directoriesOverlap(directory, selected) ||
              directoriesOverlap(directory, canonical)
            )
              throw new NodeMutationConflict(
                other === workspace
                  ? "临时目录与自选项目目录重叠，不能清理；请取消勾选以保留目录文件。"
                  : "临时目录仍被其他探索绑定，请先更换该探索的工作目录，或取消勾选以保留目录文件。",
              );
          }
          await this.store.existingTemporaryDirectory(workspace);
          if (!workspace.pendingWorkspaceDeletion)
            await this.store.save({
              workspace,
              values: {
                pendingWorkspaceDeletion: { deleteTemporaryDirectory: true },
              },
            });
          try {
            await this.store.removeTemporaryDirectory(workspace);
          } catch (error) {
            throw new Error(
              `临时目录清理失败，部分文件可能已删除，探索已保留；请勾选清理临时目录后重试删除：${safeError(error)}`,
            );
          }
        }
        try {
          await Promise.all(
            workspace.nodes.map((node) => this.closeSubagentHost(node)),
          );
          await this.store.save({ workspace, deleteWorkspace: true });
        } catch (error) {
          throw new Error(
            input.deleteTemporaryDirectory
              ? "临时目录已清理，但探索删除保存失败；探索已保留，请勾选清理临时目录后重试删除。"
              : "探索删除保存失败，探索和目录文件均已保留，请重试。",
            { cause: error },
          );
        }
        for (const node of workspace.nodes)
          this.authorizations.revokeNode(node.id);
        this.approvalVersions.delete(workspaceId);
        return this.store.snapshot();
      } finally {
        releaseFiles?.();
        this.deletingDirectories.delete(workspaceId);
        this.activeDirectories.delete(lock);
        this.pump();
      }
    });
  }

  deleteNode(
    workspaceId: string,
    nodeId: string,
    input: { expectedRevision: number; expectedNodeIds: string[] },
  ) {
    return this.serializeMutation(workspaceId, async () => {
      const workspace = this.store.workspace(workspaceId);
      const { subtree } = this.assertMutable(
        workspace,
        nodeId,
        input.expectedRevision,
      );
      const expected = new Set(input.expectedNodeIds);
      if (
        expected.size !== input.expectedNodeIds.length ||
        expected.size !== subtree.length ||
        subtree.some((node) => !expected.has(node.id))
      )
        throw new NodeMutationConflict(
          "待删除的分支已发生变化，请重新确认删除范围。",
        );
      await Promise.all(subtree.map((node) => this.closeSubagentHost(node)));
      const ids = new Set(subtree.map((item) => item.id));
      await this.store.save({
        workspace,
        values: { nodes: workspace.nodes.filter((item) => !ids.has(item.id)) },
      });
      for (const item of subtree) this.authorizations.revokeNode(item.id);
      return this.store.snapshot();
    });
  }

  updatePositions(
    workspaceId: string,
    positions: Record<string, { x: number; y: number }>,
  ) {
    return this.serializeMutation(workspaceId, async () => {
      const workspace = this.store.workspace(workspaceId);
      this.assertWorkspaceNotDeleting(workspace);
      const updates = Object.entries(positions).map(([id, position]) => {
        const node = workspace.nodes.find((item) => item.id === id);
        if (!node)
          throw new NodeMutationConflict("节点已不存在，请刷新后重试。");
        return { node, position, previous: node.position };
      });
      for (const { node, position } of updates) node.position = position;
      this.store.touch(workspace);
      try {
        await this.store.save();
      } catch (error) {
        for (const { node, previous } of updates) node.position = previous;
        this.store.touch(workspace);
        throw error;
      }
    });
  }

  configureWorkspace(
    workspaceId: string,
    settings: {
      workingDirectory?: string | null;
      approvalMode?: ApprovalMode;
      safetyModel?: string | null;
      autoCompact?: boolean;
    },
  ) {
    const change = this.serializeMutation(workspaceId, async () => {
      const workspace = this.store.workspace(workspaceId);
      this.assertWorkspaceNotDeleting(workspace);
      const directory =
        settings.workingDirectory === undefined
          ? workspace.workingDirectory
          : (settings.workingDirectory ?? undefined);
      if (
        directory !== workspace.workingDirectory &&
        workspace.nodes.some(
          (node) =>
            node.status === "running" ||
            node.status === "queued" ||
            this.runtime.hasSubagentWork?.(this.subagentOwner(node)),
        )
      )
        throw new Error("请等待当前探索中的任务结束或取消后，再更换工作目录。");
      const mode = settings.approvalMode ?? workspace.approvalMode ?? "ask";
      const safetyModel =
        settings.safetyModel === undefined
          ? workspace.safetyModel
          : (settings.safetyModel ?? undefined);
      validateApprovalSettings(this.runtime, mode, safetyModel);
      const approvalChanged =
        mode !== (workspace.approvalMode ?? "ask") ||
        safetyModel !== workspace.safetyModel;
      this.assertDirectoryAvailable(
        directory ?? this.store.temporaryDirectory(workspace),
      );
      this.configuringDirectories.set(
        workspaceId,
        directory ?? this.store.temporaryDirectory(workspace),
      );
      try {
        await this.store.save({
          workspace,
          values: {
            workingDirectory: directory,
            approvalMode: mode,
            safetyModel,
            autoCompact: settings.autoCompact ?? workspace.autoCompact ?? true,
          },
        });
      } finally {
        this.configuringDirectories.delete(workspaceId);
      }
      if (approvalChanged)
        this.approvalVersions.set(
          workspaceId,
          (this.approvalVersions.get(workspaceId) ?? 0) + 1,
        );
    });
    this.settingsChanges.set(workspaceId, change);
    const clear = () => {
      if (this.settingsChanges.get(workspaceId) === change)
        this.settingsChanges.delete(workspaceId);
    };
    void change.then(clear, clear);
    return change;
  }

  private isLiveNode(workspace: StoredWorkspace, node: StoredNode) {
    if (this.closed || !workspace.nodes.includes(node)) return false;
    if (node.status === "queued")
      return this.queue.some(
        (job) => job.workspace === workspace && job.node === node,
      );
    const controller = this.active.get(node.id);
    return (
      node.status === "running" &&
      Boolean(controller && !controller.signal.aborted)
    );
  }

  private currentComputerUseTakeover(
    workspace: StoredWorkspace,
    node: StoredNode,
  ) {
    const grant = this.computerUseTakeovers.get(node.id);
    return grant &&
      grant.workspace === workspace &&
      grant.node === node &&
      grant.revision === (node.revision ?? 0) &&
      node.computerUseTakeover === true &&
      this.isLiveNode(workspace, node)
      ? grant
      : undefined;
  }

  private revokeComputerUseTakeover(node: StoredNode) {
    this.computerUseTakeovers.delete(node.id);
    delete node.computerUseTakeover;
    delete node.computerUseTaskScope;
    this.computerUseTakeoverChanges.set(
      node.id,
      (this.computerUseTakeoverChanges.get(node.id) ?? 0) + 1,
    );
    for (const call of node.toolCalls ?? []) {
      if (
        call.approval === "cua_takeover" &&
        call.authorization &&
        call.authorization.consumedAt === undefined
      )
        this.invalidateAuthorization(
          call,
          "CUA 接管已关闭，未执行的接管授权已失效。",
        );
    }
  }

  async setComputerUseTakeover(
    workspaceId: string,
    nodeId: string,
    enabled: boolean,
    expectedRevision: number,
    options: ComputerUseTakeoverOptions = {},
  ) {
    if (typeof enabled !== "boolean")
      throw new Error("CUA 接管开关必须是布尔值。");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new Error("请提供有效的节点版本。");
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      Object.keys(options).some((key) => !["mode", "scopeId"].includes(key)) ||
      (options.mode !== undefined &&
        options.mode !== "observe" &&
        options.mode !== "task") ||
      (options.scopeId !== undefined && typeof options.scopeId !== "string")
    )
      throw new Error("CUA 接管模式或范围无效。");
    if (enabled && options.mode === "task" && !options.scopeId)
      throw new Error("请先观察并选择本任务允许操作的窗口或页面。");
    const workspace = this.store.workspace(workspaceId);
    const node = workspace.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("节点不存在。");
    const assertCurrent = () => {
      if (
        (node.revision ?? 0) !== expectedRevision ||
        !workspace.nodes.includes(node)
      )
        throw new NodeMutationConflict(
          "节点已重新生成，CUA 接管设置已失效，请刷新后重试。",
        );
      if (!this.isLiveNode(workspace, node))
        throw new NodeMutationConflict(
          "只有正在运行或排队中的电脑控制卡片可以设置 CUA 接管。",
        );
      if (
        enabled &&
        !node.toolRequests?.includes("computer_use") &&
        !node.toolCalls?.some((call) =>
          [
            "computer_use_tools",
            "computer_use_call",
            "computer_use_release",
          ].includes(call.name),
        )
      )
        throw new Error("当前卡片尚未使用电脑控制，不能开启 CUA 接管。");
    };
    assertCurrent();
    const observed = this.computerUseScopes.get(node.id);
    const scope =
      enabled && options.mode === "task" ? observed?.scope : undefined;
    const assertScope = () => {
      if (
        enabled &&
        options.mode === "task" &&
        (!scope ||
          this.computerUseScopes.get(node.id)?.scope.id !== scope.id ||
          observed?.node !== node ||
          observed.revision !== expectedRevision ||
          scope.id !== options.scopeId)
      )
        throw new NodeMutationConflict(
          "观察目标已变化，请重新选择当前窗口或页面。",
        );
    };
    assertScope();
    const current = this.currentComputerUseTakeover(workspace, node);
    if (enabled && current && current.scope?.id === scope?.id) return;
    // Revocation is synchronous, including while an earlier enable/save is pending.
    this.revokeComputerUseTakeover(node);
    const change = this.computerUseTakeoverChanges.get(node.id)!;
    return this.serializeMutation(workspace.id, async () => {
      const assertUnchanged = () => {
        assertCurrent();
        assertScope();
        if (this.computerUseTakeoverChanges.get(node.id) !== change)
          throw new NodeMutationConflict(
            "CUA 接管设置已被更新，请以最新开关状态为准。",
          );
      };
      assertUnchanged();
      if (enabled) node.computerUseTakeover = true;
      else delete node.computerUseTakeover;
      if (scope) node.computerUseTaskScope = structuredClone(scope);
      this.store.touch(workspace);
      try {
        await this.store.save();
        assertUnchanged();
        if (this.store.storageError) throw new Error(this.store.storageError);
        if (enabled)
          this.computerUseTakeovers.set(node.id, {
            workspace,
            node,
            revision: expectedRevision,
            scope,
          });
      } catch (error) {
        if (this.computerUseTakeoverChanges.get(node.id) === change)
          this.revokeComputerUseTakeover(node);
        this.store.touch(workspace);
        throw error;
      }
    });
  }

  sendRunInput(
    workspaceId: string,
    nodeId: string,
    input: {
      text: string;
      mode: RunInputMode;
      requestId: string;
      expectedRevision: number;
    },
  ) {
    return this.serializeMutation(workspaceId, async () => {
      const workspace = this.store.workspace(workspaceId);
      const node = workspace.nodes.find((item) => item.id === nodeId);
      if (
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0
      )
        throw new Error("节点版本无效。");
      if (!input.requestId?.trim() || input.requestId.length > 80)
        throw new Error("追加消息请求 ID 无效。");
      if (!node || (node.revision ?? 0) !== input.expectedRevision)
        throw new NodeMutationConflict("卡片版本已改变，请重新选择当前卡片。");
      if (!input.text.trim() || input.text.length > 20000)
        throw new Error("追加消息不能为空且最多 20000 个字符。");
      if (input.mode !== "steer" && input.mode !== "followUp")
        throw new Error("请选择引导当前任务或完成后继续。");
      const duplicate = node.runInputs?.find(
        (message) => message.id === input.requestId,
      );
      if (duplicate) {
        if (duplicate.text !== input.text || duplicate.mode !== input.mode)
          throw new NodeMutationConflict("请求 ID 已用于另一条追加消息。");
        return duplicate;
      }
      const control = this.runInputControls.get(node.id);
      const live = () =>
        !!control &&
        control.node === node &&
        control.revision === input.expectedRevision &&
        control.accepting &&
        !control.controller.signal.aborted &&
        node.status === "running" &&
        workspace.nodes.includes(node);
      if (!live())
        throw new NodeMutationConflict(
          "当前任务尚未开始或已结束，消息未发送。请在新分支继续。",
        );
      if (
        (node.runInputs?.filter((message) => message.status === "queued")
          .length ?? 0) >= 20
      )
        throw new Error("已有 20 条消息等待接收，请稍后再发送。");
      const message: RunInput = {
        id: input.requestId,
        text: input.text,
        mode: input.mode,
        status: "queued",
        createdAt: Date.now(),
      };
      (node.runInputs ??= []).push(message);
      this.store.touch(workspace);
      try {
        // Persist acceptance before making the message available to Pi.
        await this.store.save();
        if (!live())
          throw new NodeMutationConflict(
            "当前任务已结束，消息未送达。请在新分支继续。",
          );
        if (control!.send) control!.send(message);
        else control!.pending.push(message);
      } catch (error) {
        message.status = "cancelled";
        this.store.touch(workspace);
        await this.store.save().catch(() => {});
        throw error;
      }
      return message;
    });
  }

  async cancel(workspaceId: string, nodeId: string) {
    const workspace = this.store.workspace(workspaceId);
    const node = workspace.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("节点不存在。");
    const owner = this.subagentOwner(node);
    this.suppressedSubagentWakes.add(owner);
    this.subagentWakes.delete(owner);
    const preparation = this.contextJobs.get(node.id);
    if (preparation) {
      preparation.controller.abort(new Error("摘要生成已停止。"));
      node.preparedContextState = {
        ...node.preparedContextState,
        status: "cancelled",
        updatedAt: Date.now(),
        error: "摘要生成已停止，原始历史保持完整。",
      };
      this.store.touch(workspace);
      await this.store.save();
    }
    const closingSubagents = this.runtime.closeSubagentHost?.(
      this.subagentOwner(node),
    );
    for (const child of node.subagents ?? [])
      if (["running", "queued"].includes(child.status)) {
        child.status = "cancelled";
        child.stopReason = "user";
        child.finishedAt = Date.now();
      }
    if (node.status !== "running" && node.status !== "queued") {
      this.interruptTools(node);
      await closingSubagents;
      this.store.touch(workspace);
      await this.store.save();
      return;
    }
    node.status = "cancelled";
    for (const input of node.runInputs ?? [])
      if (input.status === "queued") input.status = "cancelled";
    node.finishedAt = Date.now();
    this.interruptTools(node);
    this.queue = this.queue.filter((job) => job.node.id !== node.id);
    this.active.get(node.id)?.abort();
    await closingSubagents;
    for (const child of node.subagents ?? [])
      if (child.status === "failed" && !child.error) child.status = "cancelled";
    this.store.touch(workspace);
    await this.store.save();
  }

  shutdown() {
    this.closed = true;
    this.subagentWakes.clear();
    this.maintenanceController.abort();
    for (const job of [
      ...this.contextJobs.values(),
      ...this.mergeContextJobs.values(),
    ])
      job.controller.abort(new Error("服务关闭中断了摘要生成。"));
    for (const workspace of this.store.data.workspaces) {
      for (const node of workspace.nodes) {
        void this.closeSubagentHost(node);
        for (const child of node.subagents ?? [])
          if (["running", "queued"].includes(child.status)) {
            child.status = "cancelled";
            child.finishedAt = Date.now();
            child.error = "服务关闭中断了运行，可从已保存会话恢复。";
            if (child.thinking) child.thinking.active = false;
          }
        this.interruptTools(node);
        if (node.status === "running" || node.status === "queued") {
          for (const input of node.runInputs ?? [])
            if (input.status === "queued") input.status = "cancelled";
          node.status = "failed";
          node.error =
            "运行被服务关闭中断。可以在新节点继续，或在当前卡片原地重试。";
          node.finishedAt = Date.now();
          this.interruptTools(node);
          this.store.touch(workspace);
        }
      }
    }
    for (const controller of this.active.values()) controller.abort();
    this.queue = [];
  }

  private pump() {
    while (
      !this.closed &&
      this.active.size < this.concurrency &&
      this.queue.length
    ) {
      const index = this.queue.findIndex(
        (candidate) =>
          !this.active.has(candidate.node.id) &&
          (!candidate.node.execution?.workingDirectory ||
            ![
              // Runs may share a directory; only maintenance reserves the whole
              // directory. Actual file effects are coordinated at tool dispatch.
              ...[...this.activeDirectories.entries()]
                .filter(
                  ([id]) => id.startsWith("retry:") || id.startsWith("delete:"),
                )
                .map(([, directory]) => directory),
              ...this.store.data.workspaces.flatMap((workspace) =>
                workspace.pendingWorkspaceDeletion
                  ? [this.store.temporaryDirectory(workspace)]
                  : [],
              ),
              ...this.store.data.workspaces.flatMap((workspace) =>
                workspace.pendingNodeRetry
                  ? [workspace.pendingNodeRetry.workingDirectory]
                  : [],
              ),
            ].some((directory) =>
              directoriesOverlap(
                directory,
                candidate.node.execution!.workingDirectory!,
              ),
            )),
      );
      if (index < 0) break;
      const [job] = this.queue.splice(index, 1);
      if (
        job.node.status !== "queued" ||
        !this.store.data.workspaces.includes(job.workspace) ||
        !job.workspace.nodes.includes(job.node)
      )
        continue;
      if (
        job.continuationRevision !== undefined &&
        job.continuationRevision !== (job.node.revision ?? 0)
      )
        continue;
      const controller = new AbortController();
      this.active.set(job.node.id, controller);
      if (job.node.execution?.workingDirectory)
        this.activeDirectories.set(
          job.node.id,
          job.node.execution.workingDirectory,
        );
      void this.execute(job, controller).finally(() => {
        this.active.delete(job.node.id);
        this.activeDirectories.delete(job.node.id);
        this.queueSubagentWake(job.workspace, job.node);
        this.pump();
      });
    }
  }

  private interruptTools(node: StoredNode, preserveChildren = false) {
    if (
      !preserveChildren ||
      !node.subagents?.some((run) => ["queued", "running"].includes(run.status))
    )
      this.sandboxPermissionVersions.set(
        node,
        (this.sandboxPermissionVersions.get(node) ?? 0) + 1,
      );
    this.revokeComputerUseTakeover(node);
    this.computerUseScopes.delete(node.id);
    delete node.computerUseScope;
    if (!preserveChildren) {
      this.approvedTools.delete(node.id);
      this.authorizations.revokeNode(node.id);
    }
    for (const call of node.toolCalls ?? []) {
      if (preserveChildren && call.subagentId && this.toolIsLive(node, call))
        continue;
      if (call.authorization) this.authorizations.revoke(call.authorization.id);
      call.waitingFor = undefined;
      if (
        call.status === "awaiting_approval" ||
        call.status === "reviewing" ||
        call.status === "running"
      ) {
        call.status = "cancelled";
        call.finishedAt = Date.now();
        if (call.authorization && !call.authorization.consumedAt) {
          call.authorization.invalidatedAt = Date.now();
          call.authorization.invalidationReason =
            "运行已结束或取消，授权已失效。";
        }
        if (call.safetyReview?.decision === "reviewing") {
          call.safetyReview.decision = "cancelled";
          call.safetyReview.reason = "安全审核已停止，未执行工具。";
          call.safetyReview.finishedAt = Date.now();
        }
      }
    }
  }

  private authorizationScope(
    workspace: StoredWorkspace,
    node: StoredNode,
    call?: Pick<ToolCall, "workingDirectory" | "sandbox">,
  ): ToolAuthorizationScope {
    if (
      !node.execution ||
      (node.requestKind !== "retry" &&
        this.store.effectiveWorkingDirectory(workspace) !==
          node.execution.workingDirectory)
    )
      throw new Error("工作目录已改变，工具授权失效。");
    return {
      workspaceId: workspace.id,
      nodeId: node.id,
      workingDirectory:
        call?.workingDirectory ?? node.execution.workingDirectory ?? null,
      settingsVersion: this.approvalVersions.get(workspace.id) ?? 0,
      approvalMode: workspace.approvalMode ?? "ask",
      safetyModel: workspace.safetyModel,
      ...(call?.sandbox
        ? { sandboxPolicyVersion: call.sandbox.policyVersion }
        : {}),
    };
  }

  private issueAuthorization(
    workspace: StoredWorkspace,
    node: StoredNode,
    call: ToolCall,
  ) {
    if (call.authorization) this.authorizations.revoke(call.authorization.id);
    call.authorization = this.authorizations.issue(
      this.authorizationScope(workspace, node, call),
      { id: call.id, name: call.name, arguments: call.arguments },
    );
  }

  private toolApprovalScope(
    workspace: StoredWorkspace,
    node: StoredNode,
    call?: Pick<ToolCall, "workingDirectory">,
  ) {
    return JSON.stringify({
      ...this.authorizationScope(workspace, node, call),
      revision: node.revision ?? 0,
    });
  }

  private hasToolApproval(
    workspace: StoredWorkspace,
    node: StoredNode,
    call: Pick<ToolCall, "name" | "workingDirectory">,
  ) {
    const name = call.name;
    if (
      name === "computer_use_call" ||
      name === "sandbox_network" ||
      name === "sandbox_recovery"
    )
      return false;
    const grants = this.approvedTools.get(node.id);
    const scope = grants?.get(name);
    if (!scope) return false;
    if (scope === this.toolApprovalScope(workspace, node, call)) return true;
    grants!.delete(name);
    return false;
  }

  private invalidateAuthorization(call: ToolCall, reason: string) {
    if (!call.authorization) return;
    this.authorizations.revoke(call.authorization.id);
    call.authorization.invalidatedAt = Date.now();
    call.authorization.invalidationReason = reason;
  }

  private async recoverSandbox<T>(
    workspace: StoredWorkspace,
    node: StoredNode,
    request: SandboxRecoveryRequest,
    execute: (
      action: SandboxRecoveryAction,
      assertAuthorized: () => void,
    ) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const parent = node.toolCalls?.find(
      (call) => call.id === request.toolCallId,
    );
    const assertParent = () => {
      signal.throwIfAborted();
      if (
        !parent ||
        !this.toolIsLive(node, parent) ||
        parent.status !== "running" ||
        parent.name !== "bash" ||
        parent.authorization?.consumedAt === undefined ||
        parent.authorization.invalidatedAt ||
        !this.dispatchingTools.has(`${node.id}:${parent.id}`) ||
        parent.sandbox?.policyVersion !== SANDBOX_POLICY_VERSION ||
        parent.sandbox.workingDirectory !== request.workingDirectory ||
        parent.arguments.command !== request.command ||
        (parent.arguments.timeout ?? 120) !== request.timeoutSeconds ||
        parent.subagentId !== request.subagentId
      )
        throw new Error("沙盒恢复请求没有匹配的正在执行的编码命令。");
    };
    assertParent();
    const scope = this.toolApprovalScope(workspace, node, parent);
    const call = {
      id: `sandbox-recovery:${randomUUID()}`,
      name: "sandbox_recovery",
      arguments: {
        ...request,
        reason: safeError(request.reason),
        authorizationScope:
          "仅当前命令；宿主执行不受原沙盒的文件和网络限制，不授权后续命令。",
      },
      workingDirectory: request.workingDirectory,
      ...(request.subagentId ? { subagentId: request.subagentId } : {}),
    };
    this.sandboxRecoveries.set(call.id, {
      workspace,
      node,
      parent: parent!,
      request: structuredClone(request),
      arguments: structuredClone(call.arguments),
    });
    try {
      if (!(await this.beforeToolCall(workspace, node, call, signal)))
        throw new Error("你已拒绝沙盒恢复，原命令未执行。");
      const recorded = node.toolCalls!.find((item) => item.id === call.id)!;
      const action = recorded.arguments.recoveryAction;
      if (action !== "retry" && action !== "host")
        throw new Error("沙盒恢复缺少明确的单次选择。");
      return await this.executeAuthorizedTool(
        workspace,
        node,
        { ...call, arguments: structuredClone(recorded.arguments) },
        signal,
        async () => {
          const authorization = recorded.authorization;
          const expectedArguments = JSON.stringify({
            ...call.arguments,
            recoveryAction: action,
          });
          const assertAuthorized = () => {
            assertParent();
            if (
              recorded.status !== "running" ||
              recorded.approval !== "approved" ||
              recorded.authorization !== authorization ||
              authorization?.invalidatedAt ||
              authorization?.consumedAt === undefined ||
              Date.now() >= authorization.expiresAt ||
              recorded.arguments.recoveryAction !== action ||
              JSON.stringify(recorded.arguments) !== expectedArguments ||
              scope !== this.toolApprovalScope(workspace, node, parent)
            )
              throw new Error("沙盒恢复授权已失效，命令未执行。");
          };
          assertAuthorized();
          let shellDispatched = false;
          const result = await execute(action, () => {
            if (shellDispatched)
              throw new Error("这次沙盒恢复授权已用于执行命令，不能重复使用。");
            assertAuthorized();
            shellDispatched = true;
            if (action === "host") {
              parent!.executionMode = "host";
              this.store.touch(workspace);
            }
          });
          recorded.status = "completed";
          recorded.output =
            action === "host"
              ? "已按你的单次批准执行宿主命令。"
              : "已重试沙盒并执行原命令。";
          recorded.finishedAt = Date.now();
          this.store.touch(workspace);
          await this.store.save();
          return result;
        },
      );
    } catch (error) {
      const recorded = node.toolCalls?.find((item) => item.id === call.id);
      if (recorded && !["denied", "cancelled"].includes(recorded.status)) {
        recorded.status = signal.aborted ? "cancelled" : "failed";
        recorded.error = safeError(error);
        recorded.finishedAt = Date.now();
        this.store.touch(workspace);
      }
      throw error;
    } finally {
      this.sandboxRecoveries.delete(call.id);
    }
  }

  private async executeAuthorizedTool<T>(
    workspace: StoredWorkspace,
    node: StoredNode,
    input: Pick<
      ToolCall,
      | "id"
      | "name"
      | "arguments"
      | "subagentId"
      | "workingDirectory"
      | "sandbox"
    >,
    signal: AbortSignal,
    execute: () => Promise<T>,
  ): Promise<T> {
    const dispatchKey = `${node.id}:${input.id}`;
    if (this.dispatchingTools.has(dispatchKey))
      throw new Error("这次工具调用正在等待或执行，不能重复派发。");
    this.dispatchingTools.add(dispatchKey);
    const call = node.toolCalls?.find((item) => item.id === input.id);
    let consumedHere = false;
    let dispatched = false;
    let releaseFiles: (() => void) | undefined;
    let historyEntry: GitHistoryEntry | undefined;
    let baseline: GitBaseline | undefined;
    try {
      while (this.settingsChanges.has(workspace.id))
        await this.settingsChanges.get(workspace.id);
      signal.throwIfAborted();
      if (
        !this.toolIsLive(node, call) ||
        call?.status !== "running" ||
        !call.authorization ||
        call.authorization.invalidatedAt ||
        call.authorization.consumedAt !== undefined ||
        JSON.stringify(input.sandbox) !== JSON.stringify(call.sandbox) ||
        ![
          "policy",
          "sandbox",
          "safety_model",
          "approved",
          "approved_tool",
          "cua_takeover",
        ].includes(call.approval ?? "")
      )
        throw new Error("工具缺少有效的单次执行授权，未执行。");
      const directory =
        call?.workingDirectory ?? node.execution?.workingDirectory;
      const resource = directory
        ? await resolveFileOperationResource(
            directory,
            input.name,
            input.arguments,
          )
        : undefined;
      if (resource) {
        if (resource.workingDirectory !== directory)
          throw new Error("工作目录的实际路径已改变，未执行工具。");
        releaseFiles = await this.fileOperations.acquire(
          resource,
          signal,
          () => {
            call.waitingFor = resource.global
              ? "等待其他文件操作结束后执行命令或共享文件操作。"
              : `等待文件可用：${resource.canonicalPath}`;
            this.store.touch(workspace);
            void this.store.save().catch(() => {});
          },
        );
        call.waitingFor = undefined;
        await validateFileOperationResource(
          resource,
          directory!,
          input.name,
          input.arguments,
        );
        // A failed or interrupted restore releases its live lock, but the
        // durable journal must still protect those files from existing runs.
        await this.assertNoPendingFileRestore(resource);
      }
      while (this.settingsChanges.has(workspace.id))
        await this.settingsChanges.get(workspace.id);
      signal.throwIfAborted();
      if (!this.toolIsLive(node, call) || call.status !== "running")
        throw new Error("任务已停止，未执行等待中的工具。");
      if (this.store.storageError) throw new Error(this.store.storageError);
      this.assertComputerUseTakeoverAuthorization(workspace, node, call);
      const scope = this.authorizationScope(workspace, node, call);
      const authorization = this.authorizations.consume(
        call.authorization.id,
        scope,
        { id: input.id, name: input.name, arguments: input.arguments },
      );
      consumedHere = true;
      call.authorization = authorization;
      this.store.touch(workspace);
      // Consumption is synchronous and final. Failed persistence or interrupted
      // dispatch cannot restore/replay this grant, including after a restart.
      await this.store.save();
      if (directory && ["write", "edit", "bash"].includes(input.name)) {
        historyEntry = {
          id: randomUUID(),
          nodeId: node.id,
          nodeRevision: node.revision ?? 0,
          nodePrompt: node.prompt,
          toolCallId: input.id,
          toolName: input.name,
          workingDirectory: directory,
          createdAt: Date.now(),
          summary: "正在记录文件更新",
          status: "recording",
          files: [],
        };
        try {
          baseline = await this.store.gitSnapshots.prepare(
            workspace.id,
            directory,
            resource?.snapshotPaths,
          );
        } catch (error) {
          historyEntry.error = `操作前 Git 快照失败：${safeError(error)}`;
        }
        (workspace.gitHistory ??= []).push(historyEntry);
        call.fileSnapshot = undefined;
        if (baseline)
          (workspace.pendingGitSnapshots ??= []).push({
            historyId: historyEntry.id,
            baseline,
          });
        this.store.touch(workspace);
        await this.store.save();
      }
      while (this.settingsChanges.has(workspace.id))
        await this.settingsChanges.get(workspace.id);
      if (resource)
        await validateFileOperationResource(
          resource,
          directory!,
          input.name,
          input.arguments,
        );
      signal.throwIfAborted();
      this.assertComputerUseTakeoverAuthorization(workspace, node, call);
      if (
        !this.toolIsLive(node, call) ||
        call.status !== "running" ||
        call.authorization !== authorization ||
        call.authorization.invalidatedAt ||
        this.store.storageError ||
        JSON.stringify(scope) !==
          JSON.stringify(this.authorizationScope(workspace, node, call)) ||
        Date.now() >= authorization.expiresAt
      )
        throw new Error(
          "执行前审批设置已改变、授权过期或保存失败，未执行工具。",
        );
      // No await between the final check and dispatch into the Pi tool adapter.
      call.executionStartedAt = Date.now();
      dispatched = true;
      try {
        return await execute();
      } finally {
        if (historyEntry) {
          // Snapshot even when a command failed or was cancelled after writing.
          // Do not let a snapshot failure replace the original tool outcome.
          await this.store.finishGitSnapshot(workspace, historyEntry, baseline);
          this.store.touch(workspace);
          await this.store.save().catch(() => {});
        }
      }
    } catch (error) {
      // An executed tool may already have changed files. Preserve its snapshot
      // and error; only failures before dispatch can be recorded as unchanged.
      if (dispatched) throw error;
      if (
        call &&
        consumedHere &&
        ["write", "edit", "bash"].includes(input.name)
      )
        call.fileSnapshot = "unchanged";
      if (historyEntry) {
        const historyId = historyEntry.id;
        workspace.gitHistory = workspace.gitHistory?.filter(
          (entry) => entry.id !== historyId,
        );
        workspace.pendingGitSnapshots = workspace.pendingGitSnapshots?.filter(
          (entry) => entry.historyId !== historyId,
        );
      }
      // A duplicate dispatch must not overwrite the audit/status of the first
      // dispatch that already owns the consumed grant.
      if (
        call &&
        (consumedHere || call.authorization?.consumedAt === undefined)
      ) {
        this.invalidateAuthorization(call, safeError(error));
        if (call.status !== "cancelled" && call.status !== "denied") {
          call.status = "failed";
          call.error = safeError(error);
          call.finishedAt = Date.now();
        }
        this.store.touch(workspace);
        await this.store.save().catch(() => {});
      }
      throw error;
    } finally {
      if (call?.waitingFor) {
        call.waitingFor = undefined;
        this.store.touch(workspace);
      }
      releaseFiles?.();
      this.dispatchingTools.delete(dispatchKey);
    }
  }

  private assertComputerUseTakeoverAuthorization(
    workspace: StoredWorkspace,
    node: StoredNode,
    call: ToolCall,
  ) {
    if (call.approval !== "cua_takeover") return;
    const grant = this.computerUseTakeoverTokens.get(call);
    if (
      !grant ||
      this.currentComputerUseTakeover(workspace, node) !== grant ||
      !this.isComputerUseGranted(call, grant)
    )
      throw new Error("CUA 接管已关闭或本轮授权已改变，未执行工具。");
  }

  private isComputerUseGranted(
    call: ToolCall,
    grant: ComputerUseTakeoverGrant,
  ): boolean {
    const basic = isCuaTakeoverOperation(call);
    if (!grant.scope) return basic;
    // Discovery and release carry no target; their existing narrow policy applies.
    if (!call.arguments.target) return basic;
    const context = this.computerUseContexts.get(call);
    return (
      !!context?.authorizeTask &&
      context.scope?.id === grant.scope.id &&
      sameTarget(call.arguments.target, grant.scope.target) &&
      (basic || context.routine)
    );
  }

  async approve(
    workspaceId: string,
    nodeId: string,
    toolId: string,
    decision: ToolApprovalDecision,
    expectedRevision?: number,
  ) {
    const workspace = this.store.workspace(workspaceId);
    const node = workspace.nodes.find((item) => item.id === nodeId);
    if (node && (node.revision ?? 0) !== (expectedRevision ?? 0))
      throw new NodeMutationConflict(
        "节点已重新生成，这次审批已失效，请刷新查看最新操作。",
      );
    const call = node?.toolCalls?.find((item) => item.id === toolId);
    const resume = this.approvals.get(`${nodeId}:${toolId}`);
    if (
      !node ||
      !this.toolIsLive(node, call) ||
      !call ||
      call.status !== "awaiting_approval" ||
      !resume
    )
      throw new Error("这次审批已失效，请刷新查看最新状态。");
    const allowed = decision !== "deny";
    const batch = decision === "approve_tool";
    if (batch && call.name === "computer_use_call")
      throw new Error("电脑操作需要逐次审核具体目标和参数，不能批量批准。");
    if (batch && call.name === "sandbox_network")
      throw new Error("联网授权必须限定到具体目标，不能批量批准全部目标。");
    if (batch && call.name === "sandbox_recovery")
      throw new Error("沙盒恢复必须逐条选择，不能批量批准宿主执行。");
    if (decision === "retry_sandbox" && call.name !== "sandbox_recovery")
      throw new Error("只有沙盒初始化恢复请求可以重试沙盒。");
    if (
      call.name === "sandbox_recovery" &&
      !this.sandboxRecoveries.has(call.id)
    )
      throw new Error("沙盒恢复请求已失效。");
    if (call.name === "sandbox_recovery" && allowed) {
      const recovery = this.sandboxRecoveries.get(call.id)!;
      if (
        JSON.stringify(call.arguments) !== JSON.stringify(recovery.arguments) ||
        call.workingDirectory !== recovery.request.workingDirectory ||
        call.subagentId !== recovery.request.subagentId
      )
        throw new Error("沙盒恢复参数已改变，请重新发起恢复。");
    }
    const controller = this.active.get(nodeId);
    const batchScope = batch
      ? this.toolApprovalScope(workspace, node, call)
      : undefined;
    const calls = batch
      ? node.toolCalls!.filter(
          (item) =>
            item.name === call.name &&
            (item.workingDirectory ?? node.execution?.workingDirectory) ===
              (call.workingDirectory ?? node.execution?.workingDirectory) &&
            item.status === "awaiting_approval" &&
            this.approvals.has(`${nodeId}:${item.id}`),
        )
      : [call];
    const resumes = calls.map(
      (item) => this.approvals.get(`${nodeId}:${item.id}`)!,
    );
    try {
      for (const item of calls) {
        if (item.name === "sandbox_recovery" && allowed)
          item.arguments.recoveryAction =
            decision === "retry_sandbox" ? "retry" : "host";
        item.approval = batch
          ? "approved_tool"
          : allowed
            ? "approved"
            : "denied";
        item.status = allowed ? "running" : "denied";
        if (!allowed) item.finishedAt = Date.now();
        if (allowed) this.issueAuthorization(workspace, node, item);
      }
      this.store.touch(workspace);
      await this.store.save();
      if (batch) {
        while (this.settingsChanges.has(workspace.id))
          await this.settingsChanges.get(workspace.id);
        if (
          !this.toolIsLive(node, call) ||
          (controller &&
            (controller.signal.aborted ||
              this.active.get(nodeId) !== controller)) ||
          batchScope !== this.toolApprovalScope(workspace, node, call)
        )
          throw new Error("本轮运行或审批设置已改变，批量同意未生效。");
        const grants =
          this.approvedTools.get(nodeId) ?? new Map<string, string>();
        grants.set(call.name, batchScope!);
        this.approvedTools.set(nodeId, grants);
      }
    } catch (error) {
      for (const item of calls) {
        this.invalidateAuthorization(item, safeError(error));
        if (node.status === "running") {
          item.status = "awaiting_approval";
          item.approval = undefined;
          item.finishedAt = undefined;
          if (item.name === "sandbox_recovery")
            delete item.arguments.recoveryAction;
        }
      }
      this.store.touch(workspace);
      throw error;
    }
    for (const finish of resumes) finish(allowed);
  }

  private async beforeToolCall(
    workspace: StoredWorkspace,
    node: StoredNode,
    input: Pick<
      ToolCall,
      | "id"
      | "name"
      | "arguments"
      | "subagentId"
      | "workingDirectory"
      | "sandbox"
    >,
    signal: AbortSignal,
    prepare?: (
      onWait: (reason?: string) => void,
    ) => Promise<CuaPreparedApproval | void>,
  ) {
    if (input.name === "sandbox_recovery") {
      const recovery = this.sandboxRecoveries.get(input.id);
      if (
        !recovery ||
        recovery.workspace !== workspace ||
        recovery.node !== node ||
        input.sandbox ||
        input.arguments.recoveryAction !== undefined ||
        input.arguments.command !== recovery.request.command ||
        input.workingDirectory !== recovery.request.workingDirectory
      )
        throw new Error("沙盒恢复只能由宿主为未执行的命令发起。");
    }
    // A switch enabled during preparation/review must not approve that old call.
    const takeoverAtStart = this.currentComputerUseTakeover(workspace, node);
    while (this.settingsChanges.has(workspace.id))
      await this.settingsChanges.get(workspace.id);
    signal.throwIfAborted();
    const call: ToolCall = {
      ...structuredClone(input),
      status: "running",
      startedAt: Date.now(),
      computerUse: computerUseMetadata(input),
    };
    if (node.toolCalls?.some((item) => item.id === call.id))
      throw new Error("模型返回了重复的工具调用 ID。");
    (node.toolCalls ??= []).push(call);
    if (prepare) {
      this.store.touch(workspace);
      try {
        const context = await prepare((reason) => {
          if (signal.aborted || node.status !== "running") return;
          call.waitingFor = reason;
          this.store.touch(workspace);
        });
        if (context) {
          this.computerUseContexts.set(call, context);
          call.computerUse = {
            ...call.computerUse,
            authorizationReason: context.reason,
          };
        }
        signal.throwIfAborted();
      } catch (error) {
        call.status = signal.aborted ? "cancelled" : "failed";
        call.error = safeError(error);
        call.finishedAt = Date.now();
        throw error;
      } finally {
        call.waitingFor = undefined;
        this.store.touch(workspace);
      }
    }
    // Target waiting happens before approval. Never let a queued action consume
    // an expiring grant, and re-read settings after another run releases a target.
    while (this.settingsChanges.has(workspace.id))
      await this.settingsChanges.get(workspace.id);
    signal.throwIfAborted();
    if (
      takeoverAtStart &&
      this.currentComputerUseTakeover(workspace, node) === takeoverAtStart &&
      this.isComputerUseGranted(call, takeoverAtStart)
    ) {
      call.approval = "cua_takeover";
      call.computerUse = {
        ...call.computerUse,
        authorizationReason: takeoverAtStart.scope
          ? `本任务控制（${takeoverAtStart.scope.label}）：${this.computerUseContexts.get(call)?.routine ? this.computerUseContexts.get(call)!.reason : "所选范围内的基础查看、截图或滚动。"}`
          : "基础查看授权：查看、截图、后台滚动或移动指针。",
      };
      this.computerUseTakeoverTokens.set(call, takeoverAtStart);
      try {
        if (takeoverAtStart.scope && call.arguments.target)
          this.computerUseContexts.get(call)!.authorizeTask!(() =>
            this.assertComputerUseTakeoverAuthorization(workspace, node, call),
          );
        this.issueAuthorization(workspace, node, call);
        this.store.touch(workspace);
        await this.store.save();
        signal.throwIfAborted();
        if (this.store.storageError) throw new Error(this.store.storageError);
        this.assertComputerUseTakeoverAuthorization(workspace, node, call);
        return true;
      } catch (error) {
        this.invalidateAuthorization(call, safeError(error));
        call.status = signal.aborted ? "cancelled" : "failed";
        call.error = safeError(error);
        call.finishedAt = Date.now();
        this.store.touch(workspace);
        throw error;
      }
    }
    const batchApproved = this.hasToolApproval(workspace, node, input);
    const sandboxed =
      !!input.sandbox &&
      SANDBOX_TOOL_NAMES.has(input.name) &&
      input.sandbox.policyVersion === SANDBOX_POLICY_VERSION &&
      input.sandbox.workingDirectory ===
        (input.workingDirectory ?? node.execution?.workingDirectory);
    if (input.sandbox && !sandboxed)
      throw new Error("沙盒执行范围不匹配，未执行工具。");
    // Delegation itself has no file/network side effects. Child operations
    // still enter this same authorization path individually.
    const orchestration =
      input.name === "subagents_enable" ||
      (input.name === "subagent" &&
        [
          "list",
          "guide",
          "status",
          "doctor",
          "mission.list",
          "mission.status",
          "schedule.list",
          "schedule.status",
        ].includes(String(input.arguments.action))) ||
      (input.name === "subagent" &&
        !node.subagentsNative &&
        !input.arguments.action);
    const cuaContext = this.computerUseContexts.get(call);
    const sensitiveTaskAction =
      !!this.currentComputerUseTakeover(workspace, node)?.scope &&
      cuaContext?.sensitive;
    const automatic =
      !batchApproved &&
      !sandboxed &&
      !orchestration &&
      input.name !== "sandbox_recovery" &&
      !sensitiveTaskAction &&
      workspace.approvalMode === "auto";
    const safetyModel = workspace.safetyModel;
    const approvalVersion = this.approvalVersions.get(workspace.id) ?? 0;
    Object.assign(call, {
      status: automatic
        ? "reviewing"
        : sandboxed || batchApproved || orchestration
          ? "running"
          : "awaiting_approval",
      approval: sandboxed
        ? "sandbox"
        : batchApproved
          ? "approved_tool"
          : !automatic && orchestration
            ? "policy"
            : undefined,
      fileSnapshot: ["write", "edit", "bash"].includes(input.name)
        ? "unchanged"
        : undefined,
      safetyReview: automatic
        ? {
            model: safetyModel ?? "",
            decision: "reviewing",
            reason: "等待安全模型审核，工具尚未执行。",
            startedAt: Date.now(),
          }
        : undefined,
    });
    if (automatic) {
      this.store.touch(workspace);
      await this.store.save();
      signal.throwIfAborted();
      try {
        validateApprovalSettings(this.runtime, "auto", safetyModel);
        if (!this.runtime.reviewTool)
          throw new Error("安全模型审核服务不可用，请人工审批。");
        const child = call.subagentId
          ? node.subagents?.find((run) => run.id === call.subagentId)
          : undefined;
        const result = await this.runtime.reviewTool(
          {
            model: safetyModel!,
            workingDirectory:
              call.workingDirectory ?? node.execution!.workingDirectory,
            workspaceTitle: workspace.title,
            workspaceDescription: workspace.description,
            userRequest: safetyUserRequest(node),
            ancestry: node.contextIds
              .map(
                (id) => workspace.nodes.find((ancestor) => ancestor.id === id)!,
              )
              .filter(Boolean)
              .map((ancestor) => ({
                prompt: safetyUserRequest(ancestor),
                response: ancestor.response,
                toolDecisions: (ancestor.toolCalls ?? [])
                  .filter(
                    (item) =>
                      item.approval ||
                      item.safetyReview ||
                      item.status === "denied",
                  )
                  .map((item) => ({
                    id: item.id,
                    nodeId: ancestor.id,
                    revision: ancestor.revision ?? 0,
                    fromAncestor: true,
                    subagentId: item.subagentId,
                    workingDirectory:
                      item.workingDirectory ??
                      ancestor.execution?.workingDirectory,
                    name: item.name,
                    arguments: structuredClone(item.arguments),
                    status: item.status,
                    approval: item.approval,
                    safetyReview: item.safetyReview,
                    error: item.error,
                    actionHash: item.authorization?.actionHash,
                    startedAt: item.startedAt,
                  })),
              })),
            recentTools: (node.toolCalls ?? [])
              .filter((item) => item !== call)
              .map((item) => ({
                id: item.id,
                nodeId: node.id,
                revision: node.revision ?? 0,
                subagentId: item.subagentId,
                workingDirectory:
                  item.workingDirectory ?? node.execution!.workingDirectory,
                name: item.name,
                arguments: structuredClone(item.arguments),
                status: item.status,
                output: item.output,
                error: item.error,
                approval: item.approval,
                safetyReview: item.safetyReview,
                actionHash: item.authorization?.actionHash,
                startedAt: item.startedAt,
              })),
            relatedSubagentIds: child
              ? subagentThreads(node.subagents).find((thread) =>
                  thread.runIds.includes(child.id),
                )?.runIds
              : undefined,
            tool: {
              id: call.id,
              name: call.name,
              arguments: structuredClone(call.arguments),
            },
            subagent: child
              ? {
                  id: child.id,
                  agent: child.agent,
                  task: child.task,
                  parentRunId: child.parentRunId,
                  depth: child.depth,
                }
              : undefined,
            computerUseContext: cuaContext
              ? { scope: cuaContext.scope, reason: cuaContext.reason }
              : undefined,
          },
          signal,
        );
        signal.throwIfAborted();
        if (
          (result.decision !== "approve" && result.decision !== "deny") ||
          typeof result.reason !== "string" ||
          !result.reason.trim()
        )
          throw new Error("安全模型未返回明确的审核结论，请人工审批。");
        call.safetyReview = {
          ...call.safetyReview!,
          decision: result.decision,
          reason: safeError(result.reason),
          finishedAt: Date.now(),
        };
        while (this.settingsChanges.has(workspace.id))
          await this.settingsChanges.get(workspace.id);
        signal.throwIfAborted();
        if (
          (this.approvalVersions.get(workspace.id) ?? 0) !== approvalVersion ||
          workspace.approvalMode !== "auto" ||
          workspace.safetyModel !== safetyModel
        )
          throw new Error("安全审核期间审批设置已改变，本次操作转为人工审批。");
        if (result.decision === "approve") {
          call.status = "running";
          call.approval = "safety_model";
          this.issueAuthorization(workspace, node, call);
          this.store.touch(workspace);
          await this.store.save();
          while (this.settingsChanges.has(workspace.id))
            await this.settingsChanges.get(workspace.id);
          signal.throwIfAborted();
          if (
            (this.approvalVersions.get(workspace.id) ?? 0) !==
              approvalVersion ||
            workspace.approvalMode !== "auto" ||
            workspace.safetyModel !== safetyModel
          )
            throw new Error(
              "安全审核期间审批设置已改变，本次操作转为人工审批。",
            );
          if (this.store.storageError) throw new Error(this.store.storageError);
          return true;
        }
      } catch (error) {
        this.invalidateAuthorization(call, safeError(error));
        signal.throwIfAborted();
        call.safetyReview = {
          ...call.safetyReview!,
          decision: "error",
          reason: safeError(error),
          finishedAt: Date.now(),
        };
        call.approval = undefined;
      }
      // A rejection, invalid configuration, failed review or failed persistence
      // never grants execution. Keep the exact call pending for a human decision.
      return this.waitForApproval(workspace, node, call, signal);
    }
    if (sandboxed || batchApproved || orchestration) {
      this.issueAuthorization(workspace, node, call);
      this.store.touch(workspace);
      await this.store.save();
      signal.throwIfAborted();
      if (this.store.storageError) throw new Error(this.store.storageError);
      return true;
    }
    return this.waitForApproval(workspace, node, call, signal);
  }

  private async waitForApproval(
    workspace: StoredWorkspace,
    node: StoredNode,
    call: ToolCall,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    call.status = "awaiting_approval";
    let dispose = () => {};
    const approved = new Promise<boolean>((resolve) => {
      const key = `${node.id}:${call.id}`;
      const finish = (allow: boolean) => {
        this.approvals.delete(key);
        signal.removeEventListener("abort", abort);
        resolve(allow);
      };
      const abort = () => {
        call.status = "cancelled";
        call.finishedAt = Date.now();
        this.invalidateAuthorization(call, "运行已取消。");
        this.store.touch(workspace);
        finish(false);
      };
      dispose = abort;
      this.approvals.set(key, finish);
      signal.addEventListener("abort", abort, { once: true });
    });
    this.store.touch(workspace);
    try {
      await this.store.save();
      // A grant may have been saved while this call was still being reviewed
      // or while its pending state was queued for persistence.
      if (
        call.status === "awaiting_approval" &&
        this.hasToolApproval(workspace, node, call)
      )
        await this.approve(
          workspace.id,
          node.id,
          call.id,
          "approve_tool",
          node.revision ?? 0,
        );
      const allowed = await approved;
      signal.throwIfAborted();
      if (this.store.storageError) throw new Error(this.store.storageError);
      return allowed;
    } catch (error) {
      dispose();
      throw error;
    }
  }

  private async execute(
    { workspace, node, continuationRevision }: Job,
    controller: AbortController,
  ) {
    const continuation = continuationRevision !== undefined;
    const owner = this.subagentOwner(node);
    const notices = continuation ? (this.subagentWakes.get(owner) ?? []) : [];
    if (continuation) this.subagentWakes.delete(owner);
    const previousMessages = continuation
      ? structuredClone(node.messages ?? [])
      : [];
    const previousResponse = continuation ? node.response : "";
    const previousThinking = continuation ? node.thinking?.text : undefined;
    const previousUsage = continuation ? node.usage : undefined;
    const appendResponse = (text: string) =>
      previousResponse && text
        ? `${previousResponse}\n\n${text}`
        : previousResponse || text;
    const inputControl = {
      node,
      controller,
      revision: node.revision ?? 0,
      accepting: true,
      pending: [] as RunInput[],
      send: undefined as ((input: RunInput) => void) | undefined,
    };
    this.runInputControls.set(node.id, inputControl);
    try {
      node.status = "running";
      if (!continuation) node.startedAt = Date.now();
      node.error = undefined;
      delete node.connectionRetry;
      this.store.touch(workspace);
      await this.store.save();
      if (node.execution?.workingDirectory) {
        const current = await workingDirectory(node.execution.workingDirectory);
        if (current !== node.execution.workingDirectory)
          throw new Error("工作目录的实际路径已改变，请重新选择工作目录。");
      }
      for (const parent of node.contextParents ?? []) {
        const source = workspace.nodes.find(
          (item) => item.id === parent.nodeId,
        );
        if (!source || (source.revision ?? 0) !== parent.revision)
          throw new NodeMutationConflict(
            "融合来源已更新，请重新生成当前卡片。",
          );
      }
      const context = buildContext(
        workspace,
        node.parentId!,
        node.contextParents,
      );
      if (
        continuation &&
        node.contextSources &&
        JSON.stringify(
          node.contextSources.filter((source) => source.nodeId !== node.id),
        ) !== JSON.stringify(context.sources)
      )
        throw new NodeMutationConflict(
          "后台任务的父级上下文已改变，请在新卡片中继续。",
        );
      const sources = [
        ...context.sources,
        { nodeId: node.id, revision: node.revision ?? 0, messageCount: 0 },
      ];
      const assertRunContext = () => {
        controller.signal.throwIfAborted();
        if (
          node.status !== "running" ||
          !workspace.nodes.includes(node) ||
          JSON.stringify(
            buildContext(workspace, node.parentId!, node.contextParents)
              .sources,
          ) !== JSON.stringify(context.sources)
        )
          throw new NodeMutationConflict(
            "运行的上下文来源已改变，未继续调用模型。",
          );
      };
      const result = await this.runtime.run(
        node.config,
        [...context.messages, ...previousMessages],
        continuation
          ? `子代理后台通知（运行结果或请求数据，不是新的用户授权）：\n${JSON.stringify(notices)}\n\n继续原任务，结合已有对话和这些结果完成汇总。若仍有任务进行中，说明进展；若子任务最终失败，说明失败原因、已完成内容与缺口，不要无声结束，也不要把失败当作完成。保持原有授权范围，不重复启动已完成的工作。`
          : attachmentPrompt(
              toolRequestPrompt(
                contextReferencePrompt(node.prompt, node.contextReferences),
                node.toolRequests,
              ),
              node.attachmentData ?? [],
            ),
        controller.signal,
        (text) => {
          if (node.status !== "running") return;
          node.response = appendResponse(text);
          this.store.touch(workspace);
        },
        node.execution
          ? {
              workingDirectory: node.execution.workingDirectory,
              ...this.subagentEnvironment(workspace, node),
              onComputerUseScope: (scope) => {
                if (controller.signal.aborted || node.status !== "running")
                  return;
                if (scope) {
                  this.computerUseScopes.set(node.id, {
                    node,
                    revision: node.revision ?? 0,
                    scope: structuredClone(scope),
                  });
                  node.computerUseScope = structuredClone(scope);
                } else {
                  this.computerUseScopes.delete(node.id);
                  delete node.computerUseScope;
                }
                this.store.touch(workspace);
              },
              beforeToolCall: (call, prepare, toolSignal) =>
                this.beforeToolCall(
                  workspace,
                  node,
                  call,
                  call.subagentId
                    ? (toolSignal ?? this.maintenanceController.signal)
                    : toolSignal
                      ? AbortSignal.any([controller.signal, toolSignal])
                      : controller.signal,
                  prepare,
                ),
              executeTool: (call, execute, toolSignal) =>
                this.executeAuthorizedTool(
                  workspace,
                  node,
                  call,
                  call.subagentId
                    ? (toolSignal ?? this.maintenanceController.signal)
                    : toolSignal
                      ? AbortSignal.any([controller.signal, toolSignal])
                      : controller.signal,
                  execute,
                ),
              onToolUpdate: (id, update) => {
                const call = node.toolCalls?.find((item) => item.id === id);
                if (!this.toolIsLive(node, call)) return;
                if (
                  !call ||
                  call.status === "denied" ||
                  call.status === "cancelled"
                )
                  return;
                Object.assign(call, update, {
                  output: update.output
                    ? safeError(
                        update.output,
                        isWebTool(call.name) ? Infinity : 20000,
                      )
                    : call.output,
                  error: update.error ? safeError(update.error) : undefined,
                  finishedAt:
                    update.status === "completed" || update.status === "failed"
                      ? Date.now()
                      : undefined,
                });
                this.store.touch(workspace);
              },
            }
          : undefined,
        {
          onRunInputReady: (send) => {
            inputControl.send = send;
            if (!send) {
              inputControl.accepting = false;
              return;
            }
            if (controller.signal.aborted || node.status !== "running") return;
            for (const input of inputControl.pending.splice(0)) send(input);
          },
          onRunInputDelivered: (id) => {
            const input = node.runInputs?.find((item) => item.id === id);
            if (input?.status !== "queued") return;
            input.status = "delivered";
            input.deliveredAt = Date.now();
            this.store.touch(workspace);
          },
          mergeContext:
            (node.effectiveContextMode ?? node.contextMode) !== "raw" &&
            ((node.contextParents?.length ?? 0) > 1 ||
              context.ids.some(
                (id) =>
                  (workspace.nodes.find((item) => item.id === id)
                    ?.contextParents?.length ?? 0) > 1,
              )),
          branchCheckpoints: this.branchCheckpoints(
            workspace,
            node,
            context.ids,
          ),
          contextBranches: this.contextBranches(workspace, node),
          attachments: continuation ? undefined : node.attachmentData,
          subagentContinuation: continuation,
          contextReferenceCount: node.contextReferences?.length,
          toolRequests: continuation ? undefined : node.toolRequests,
          displayPrompt: continuation ? undefined : node.prompt,
          autoCompact:
            node.contextAutoCompact ?? workspace.autoCompact !== false,
          sources,
          checkpoints: [
            ...contextCheckpoints(workspace, context.ids),
            ...(node.compactions ?? []),
          ],
          requestedCheckpointId:
            node.effectiveContextCheckpointId ??
            node.requestedContextCheckpointId,
          onThinking: (thinking) => {
            if (node.status !== "running" || !workspace.nodes.includes(node))
              return;
            node.thinking = {
              ...thinking,
              text: previousThinking
                ? `${previousThinking}\n\n${thinking.text}`
                : thinking.text,
            };
            this.store.touch(workspace);
          },
          onRequestUsage: (usage) => {
            if (!workspace.nodes.includes(node)) return;
            node.lastRequestUsage = { ...usage };
            this.store.touch(workspace);
          },
          onConnectionRetry: (retry) => {
            if (node.status !== "running" || !workspace.nodes.includes(node))
              return;
            node.connectionRetry = retry;
            this.store.touch(workspace);
          },
          onMessages: async (messages) => {
            // Preserve completed raw messages on failure and cancellation as well.
            if (!workspace.nodes.includes(node)) return;
            node.messages = [...previousMessages, ...structuredClone(messages)];
            node.contextSources = [
              ...context.sources,
              {
                nodeId: node.id,
                revision: node.revision ?? 0,
                messageCount: node.messages.length,
              },
            ];
            this.store.touch(workspace);
            await this.store.save();
          },
          onState: async (state) => {
            if (controller.signal.aborted && state.status !== "cancelled")
              return;
            node.contextState = {
              ...state,
              error: state.error ? safeError(state.error) : undefined,
            };
            this.store.touch(workspace);
            await this.store.save();
          },
          onCheckpoint: async (checkpoint) => {
            assertRunContext();
            if (
              !checkpointMatches(
                checkpoint,
                [...context.messages, ...(node.messages ?? [])],
                sources,
              )
            )
              throw new Error("摘要来源校验失败，未继续调用模型。");
            if (!node.compactions?.some((item) => item.id === checkpoint.id))
              (node.compactions ??= []).push(structuredClone(checkpoint));
            this.store.touch(workspace);
            await this.store.save();
            assertRunContext();
          },
        },
      );
      if (node.status === "running") {
        node.response = appendResponse(result.response);
        node.thinking = result.thinking
          ? {
              ...result.thinking,
              text: previousThinking
                ? `${previousThinking}\n\n${result.thinking.text}`
                : result.thinking.text,
            }
          : node.thinking;
        node.messages = [...previousMessages, ...result.messages];
        node.usage =
          previousUsage && result.usage
            ? {
                input: previousUsage.input + result.usage.input,
                output: previousUsage.output + result.usage.output,
                total: previousUsage.total + result.usage.total,
                cost:
                  previousUsage.cost !== undefined &&
                  result.usage.cost !== undefined
                    ? previousUsage.cost + result.usage.cost
                    : undefined,
              }
            : (result.usage ?? previousUsage);
        node.status = "completed";
      }
    } catch (error) {
      if (this.closed) {
        node.status = "failed";
        node.error =
          "运行被服务关闭中断。可以在新节点继续，或在当前卡片原地重试。";
      } else if (node.status !== "cancelled") {
        node.status = controller.signal.aborted ? "cancelled" : "failed";
        node.error = controller.signal.aborted ? undefined : safeError(error);
      }
    } finally {
      inputControl.accepting = false;
      delete node.connectionRetry;
      this.runInputControls.delete(node.id);
      for (const input of node.runInputs ?? [])
        if (input.status === "queued") input.status = "cancelled";
      this.interruptTools(node, true);
      node.finishedAt = Date.now();
      this.store.touch(workspace);
      await this.store.save().catch(() => {}); // Store exposes failures to all connected clients.
    }
  }
}
