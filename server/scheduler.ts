import { ancestorPath, directParentIds } from "../shared/types.ts";
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
} from "../shared/types.ts";
import type { GitBaseline } from "./git-snapshots.ts";
import {
  buildContext,
  contextCheckpoints,
  preparedContextCheckpoints,
} from "./context.ts";
import { checkpointMatches } from "./compaction.ts";
import { safeError, type Runtime } from "./runtime.ts";
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
import { computerUseMetadata } from "./computer-use.ts";
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

export class Scheduler {
  private queue: Job[] = [];
  private active = new Map<string, AbortController>();
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

  constructor(store: Store, runtime: Runtime, concurrency = Infinity) {
    this.store = store;
    this.runtime = runtime;
    this.concurrency = concurrency;
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
            (node.status === "running" || node.status === "queued") &&
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
          (node) => node.status === "running" || node.status === "queued",
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

  async cancel(workspaceId: string, nodeId: string) {
    const workspace = this.store.workspace(workspaceId);
    const node = workspace.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("节点不存在。");
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
    if (node.status !== "running" && node.status !== "queued") return;
    node.status = "cancelled";
    node.finishedAt = Date.now();
    this.interruptTools(node);
    this.queue = this.queue.filter((job) => job.node.id !== node.id);
    this.active.get(node.id)?.abort();
    this.store.touch(workspace);
    await this.store.save();
  }

  shutdown() {
    this.closed = true;
    this.maintenanceController.abort();
    for (const job of [
      ...this.contextJobs.values(),
      ...this.mergeContextJobs.values(),
    ])
      job.controller.abort(new Error("服务关闭中断了摘要生成。"));
    for (const workspace of this.store.data.workspaces) {
      for (const node of workspace.nodes) {
        if (node.status === "running" || node.status === "queued") {
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
          !candidate.node.execution?.workingDirectory ||
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
          ),
      );
      if (index < 0) break;
      const [job] = this.queue.splice(index, 1);
      if (job.node.status !== "queued") continue;
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
        this.pump();
      });
    }
  }

  private interruptTools(node: StoredNode) {
    this.revokeComputerUseTakeover(node);
    this.computerUseScopes.delete(node.id);
    delete node.computerUseScope;
    this.approvedTools.delete(node.id);
    this.authorizations.revokeNode(node.id);
    for (const call of node.toolCalls ?? []) {
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
      workingDirectory: node.execution.workingDirectory ?? null,
      settingsVersion: this.approvalVersions.get(workspace.id) ?? 0,
      approvalMode: workspace.approvalMode ?? "ask",
      safetyModel: workspace.safetyModel,
    };
  }

  private issueAuthorization(
    workspace: StoredWorkspace,
    node: StoredNode,
    call: ToolCall,
  ) {
    if (call.authorization) this.authorizations.revoke(call.authorization.id);
    call.authorization = this.authorizations.issue(
      this.authorizationScope(workspace, node),
      { id: call.id, name: call.name, arguments: call.arguments },
    );
  }

  private toolApprovalScope(workspace: StoredWorkspace, node: StoredNode) {
    return JSON.stringify({
      ...this.authorizationScope(workspace, node),
      revision: node.revision ?? 0,
    });
  }

  private hasToolApproval(
    workspace: StoredWorkspace,
    node: StoredNode,
    name: string,
  ) {
    if (name === "computer_use_call") return false;
    const grants = this.approvedTools.get(node.id);
    const scope = grants?.get(name);
    if (!scope) return false;
    if (scope === this.toolApprovalScope(workspace, node)) return true;
    grants!.delete(name);
    return false;
  }

  private invalidateAuthorization(call: ToolCall, reason: string) {
    if (!call.authorization) return;
    this.authorizations.revoke(call.authorization.id);
    call.authorization.invalidatedAt = Date.now();
    call.authorization.invalidationReason = reason;
  }

  private async executeAuthorizedTool<T>(
    workspace: StoredWorkspace,
    node: StoredNode,
    input: Pick<ToolCall, "id" | "name" | "arguments">,
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
        node.status !== "running" ||
        call?.status !== "running" ||
        !call.authorization ||
        call.authorization.invalidatedAt ||
        call.authorization.consumedAt !== undefined ||
        ![
          "policy",
          "safety_model",
          "approved",
          "approved_tool",
          "cua_takeover",
        ].includes(call.approval ?? "")
      )
        throw new Error("工具缺少有效的单次执行授权，未执行。");
      const directory = node.execution?.workingDirectory;
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
      if (node.status !== "running" || call.status !== "running")
        throw new Error("任务已停止，未执行等待中的工具。");
      if (this.store.storageError) throw new Error(this.store.storageError);
      this.assertComputerUseTakeoverAuthorization(workspace, node, call);
      const scope = this.authorizationScope(workspace, node);
      const authorization = this.authorizations.consume(
        call.authorization.id,
        scope,
        input,
      );
      consumedHere = true;
      call.authorization = authorization;
      this.store.touch(workspace);
      // Consumption is synchronous and final. Failed persistence or interrupted
      // dispatch cannot restore/replay this grant, including after a restart.
      await this.store.save();
      if (
        node.execution?.workingDirectory &&
        ["write", "edit", "bash"].includes(input.name)
      ) {
        historyEntry = {
          id: randomUUID(),
          nodeId: node.id,
          nodeRevision: node.revision ?? 0,
          nodePrompt: node.prompt,
          toolCallId: input.id,
          toolName: input.name,
          workingDirectory: node.execution.workingDirectory,
          createdAt: Date.now(),
          summary: "正在记录文件更新",
          status: "recording",
          files: [],
        };
        try {
          baseline = await this.store.gitSnapshots.prepare(
            workspace.id,
            node.execution.workingDirectory,
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
        node.status !== "running" ||
        call.status !== "running" ||
        call.authorization !== authorization ||
        call.authorization.invalidatedAt ||
        this.store.storageError ||
        JSON.stringify(scope) !==
          JSON.stringify(this.authorizationScope(workspace, node)) ||
        Date.now() >= authorization.expiresAt
      )
        throw new Error(
          "执行前审批设置已改变、授权过期或保存失败，未执行工具。",
        );
      // No await between the final check and dispatch into the Pi tool adapter.
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
      node.status !== "running" ||
      !call ||
      call.status !== "awaiting_approval" ||
      !resume
    )
      throw new Error("这次审批已失效，请刷新查看最新状态。");
    const allowed = decision !== "deny";
    const batch = decision === "approve_tool";
    if (batch && call.name === "computer_use_call")
      throw new Error("电脑操作需要逐次审核具体目标和参数，不能批量批准。");
    const controller = this.active.get(nodeId);
    const batchScope = batch
      ? this.toolApprovalScope(workspace, node)
      : undefined;
    const calls = batch
      ? node.toolCalls!.filter(
          (item) =>
            item.name === call.name &&
            item.status === "awaiting_approval" &&
            this.approvals.has(`${nodeId}:${item.id}`),
        )
      : [call];
    const resumes = calls.map(
      (item) => this.approvals.get(`${nodeId}:${item.id}`)!,
    );
    try {
      for (const item of calls) {
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
          !controller ||
          controller.signal.aborted ||
          this.active.get(nodeId) !== controller ||
          node.status !== "running" ||
          batchScope !== this.toolApprovalScope(workspace, node)
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
    input: Pick<ToolCall, "id" | "name" | "arguments" | "subagentId">,
    signal: AbortSignal,
    prepare?: (
      onWait: (reason?: string) => void,
    ) => Promise<CuaPreparedApproval | void>,
  ) {
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
    const batchApproved = this.hasToolApproval(workspace, node, input.name);
    // Delegation itself has no file/network side effects. Child operations
    // still enter this same authorization path individually.
    const orchestration =
      input.name === "subagent" || input.name === "subagents_enable";
    const cuaContext = this.computerUseContexts.get(call);
    const sensitiveTaskAction =
      !!this.currentComputerUseTakeover(workspace, node)?.scope &&
      cuaContext?.sensitive;
    const automatic =
      !batchApproved &&
      !orchestration &&
      !sensitiveTaskAction &&
      workspace.approvalMode === "auto";
    const safetyModel = workspace.safetyModel;
    const approvalVersion = this.approvalVersions.get(workspace.id) ?? 0;
    Object.assign(call, {
      status: automatic
        ? "reviewing"
        : batchApproved || input.name === "read" || orchestration
          ? "running"
          : "awaiting_approval",
      approval: batchApproved
        ? "approved_tool"
        : !automatic && (input.name === "read" || orchestration)
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
        const result = await this.runtime.reviewTool(
          {
            model: safetyModel!,
            workingDirectory: node.execution!.workingDirectory,
            workspaceTitle: workspace.title,
            workspaceDescription: workspace.description,
            userRequest: attachmentPrompt(
              toolRequestPrompt(
                contextReferencePrompt(node.prompt, node.contextReferences),
                node.toolRequests,
              ),
              node.attachmentData ?? [],
            ),
            ancestry: node.contextIds
              .map(
                (id) => workspace.nodes.find((ancestor) => ancestor.id === id)!,
              )
              .filter(Boolean)
              .map((ancestor) => ({
                prompt: attachmentPrompt(
                  toolRequestPrompt(
                    contextReferencePrompt(
                      ancestor.prompt,
                      ancestor.contextReferences,
                    ),
                    ancestor.toolRequests,
                  ),
                  ancestor.attachmentData ?? [],
                ),
                response: ancestor.response,
              })),
            recentTools: (node.toolCalls ?? [])
              .filter((item) => item !== call)
              .map((item) => ({
                name: item.name,
                arguments: structuredClone(item.arguments),
                status: item.status,
                output: item.output,
              })),
            tool: {
              id: call.id,
              name: call.name,
              arguments: structuredClone(call.arguments),
            },
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
    if (batchApproved || input.name === "read" || orchestration) {
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
        this.hasToolApproval(workspace, node, call.name)
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

  private async execute({ workspace, node }: Job, controller: AbortController) {
    try {
      node.status = "running";
      node.startedAt = Date.now();
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
        context.messages,
        attachmentPrompt(
          toolRequestPrompt(
            contextReferencePrompt(node.prompt, node.contextReferences),
            node.toolRequests,
          ),
          node.attachmentData ?? [],
        ),
        controller.signal,
        (text) => {
          if (node.status !== "running") return;
          node.response = text;
          this.store.touch(workspace);
        },
        node.execution
          ? {
              workingDirectory: node.execution.workingDirectory,
              onSubagentsEnabled: () => {
                node.subagentsEnabled = true;
                this.store.touch(workspace);
              },
              onSubagentUpdate: (run) => {
                const runs = (node.subagents ??= []);
                const index = runs.findIndex((item) => item.id === run.id);
                const record = {
                  ...run,
                  error: run.error ? safeError(run.error) : undefined,
                };
                if (index < 0) runs.push(record);
                else runs[index] = record;
                this.store.touch(workspace);
              },
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
                  toolSignal
                    ? AbortSignal.any([controller.signal, toolSignal])
                    : controller.signal,
                  prepare,
                ),
              executeTool: (call, execute, toolSignal) =>
                this.executeAuthorizedTool(
                  workspace,
                  node,
                  call,
                  toolSignal
                    ? AbortSignal.any([controller.signal, toolSignal])
                    : controller.signal,
                  execute,
                ),
              onToolUpdate: (id, update) => {
                if (node.status !== "running") return;
                const call = node.toolCalls?.find((item) => item.id === id);
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
          attachments: node.attachmentData,
          contextReferenceCount: node.contextReferences?.length,
          toolRequests: node.toolRequests,
          displayPrompt: node.prompt,
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
            node.thinking = { ...thinking };
            this.store.touch(workspace);
          },
          onRequestUsage: (usage) => {
            if (!workspace.nodes.includes(node)) return;
            node.lastRequestUsage = { ...usage };
            this.store.touch(workspace);
          },
          onMessages: async (messages) => {
            // Preserve completed raw messages on failure and cancellation as well.
            if (!workspace.nodes.includes(node)) return;
            node.messages = structuredClone(messages);
            node.contextSources = [
              ...context.sources,
              {
                nodeId: node.id,
                revision: node.revision ?? 0,
                messageCount: messages.length,
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
        node.response = result.response;
        node.thinking = result.thinking ?? node.thinking;
        node.messages = result.messages;
        node.usage = result.usage;
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
      this.interruptTools(node);
      node.finishedAt = Date.now();
      this.store.touch(workspace);
      await this.store.save().catch(() => {}); // Store exposes failures to all connected clients.
    }
  }
}
