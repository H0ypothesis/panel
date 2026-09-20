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
  ContextCheckpoint,
  ContextState,
  GitHistoryEntry,
  RunConfig,
  ToolCall,
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
import {
  FileOperationLocks,
  resolveFileOperationResource,
  validateFileOperationResource,
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
  private activeDirectories = new Map<string, string>();
  private deletingDirectories = new Map<string, string>();
  private configuringDirectories = new Map<string, string>();
  private approvals = new Map<string, (allow: boolean) => void>();
  private settingsChanges = new Map<string, Promise<void>>();
  private mutations = new Map<string, Promise<unknown>>();
  private approvalVersions = new Map<string, number>();
  private authorizations = new ToolAuthorizationRegistry();
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

  submit(
    workspaceId: string,
    input: {
      parentId: string;
      prompt: string;
      attachments?: AttachmentUpload[];
      referenceNodeIds?: string[];
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
      prompt: string;
      attachments?: AttachmentUpload[];
      referenceNodeIds?: string[];
      config: RunConfig;
      requestId: string;
      contextCheckpointId?: string;
      contextMode?: "raw";
    },
  ) {
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
    if (duplicate) {
      if (
        duplicate.run.requestKind === "retry" ||
        (duplicate.run.revision ?? 0) !== 0 ||
        duplicate.run.parentId !== input.parentId ||
        duplicate.run.prompt !== input.prompt ||
        duplicate.run.attachmentInputHash !== attachmentHash ||
        !referenceSelectionMatches(
          duplicate.run.contextReferences,
          references,
        ) ||
        duplicate.run.config.model !== input.config.model ||
        duplicate.run.config.thinking !== input.config.thinking ||
        duplicate.run.requestedContextCheckpointId !==
          input.contextCheckpointId ||
        duplicate.run.contextMode !== input.contextMode
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
    if (!model.demo)
      this.assertDirectoryAvailable(
        this.store.effectiveWorkingDirectory(workspace),
      );
    const context = buildContext(workspace, input.parentId);
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
      throw new NodeMutationConflict(
        "此路径仍在收尾，请等待结束后继续。",
      );
    const contextReferences = resolveContextReferences(workspace, references);
    const parent = workspace.nodes.find((node) => node.id === input.parentId)!;
    const selection = this.contextSelection(workspace, parent, input);
    this.validateRequestedContext(
      workspace,
      selection.effectiveContextCheckpointId,
      context,
    );
    const siblings = workspace.nodes.filter(
      (node) => node.parentId === input.parentId,
    );
    const colors = ["sage", "violet", "blue", "amber"] as const;
    const x = parent.position.x + (input.contextCheckpointId ? 500 : 360);
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
      prompt: input.prompt,
      contextReferences,
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

  private validateRequestedContext(
    workspace: StoredWorkspace,
    checkpointId: string | undefined,
    context: ReturnType<typeof buildContext>,
  ) {
    if (!checkpointId) return;
    const checkpoint = contextCheckpoints(workspace, context.ids).find(
      (item) => item.id === checkpointId,
    );
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
  ) {
    this.validateContextSelection(input);
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
    const previousCheckpoint =
      parent.effectiveContextCheckpointId ??
      parent.requestedContextCheckpointId;
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
      contextAutoCompact: raw ? false : workspace.autoCompact !== false,
    };
  }

  private preparationRequestExists(
    workspace: StoredWorkspace,
    requestId: string,
  ): boolean {
    return workspace.nodes.some((node) =>
      [node, ...(node.previousRuns ?? [])].some((run) =>
        run.preparationRequests?.some(
          (request) => request.requestId === requestId,
        ),
      ),
    );
  }

  /** Manual preparation is an explicit request, not a mutation of the completed answer. */
  async compactContext(
    workspaceId: string,
    nodeId: string,
    input: { config: RunConfig; expectedRevision: number; requestId: string },
  ): Promise<ContextCheckpoint | undefined> {
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
          previousRequest.config.model !== input.config.model ||
          previousRequest.config.thinking !== input.config.thinking
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
      if (this.contextJobs.size >= 3)
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
        if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
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
          this.contextJobs.has(item.id),
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
      const references = referenceNodeIds(input.referenceNodeIds);
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
          !referenceSelectionMatches(
            duplicate.run.contextReferences,
            references,
            previous?.contextReferences,
          ) ||
          duplicate.run.config.model !== input.config.model ||
          duplicate.run.config.thinking !== input.config.thinking ||
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
      // Build from the parent; the old question, answer and transcript are never replayed.
      const context = buildContext(workspace, node.parentId!);
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
      );
      this.validateRequestedContext(
        workspace,
        selection.effectiveContextCheckpointId,
        context,
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
        position: { ...node.position },
        color: node.color,
        createdAt: node.createdAt,
        revision: input.expectedRevision + 1,
        prompt: input.prompt,
        contextReferences,
        attachments: structuredClone(node.attachments),
        attachmentData: structuredClone(node.attachmentData),
        attachmentInputHash: node.attachmentInputHash,
        response: "",
        status: "queued",
        config: { ...input.config },
        contextIds: context.ids,
        contextSources: context.sources,
        ...selection,
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
      const context = buildContext(workspace, node.parentId!);
      const selection = this.contextSelection(
        workspace,
        workspace.nodes.find((item) => item.id === node.parentId)!,
        {},
        node,
      );
      this.validateRequestedContext(
        workspace,
        selection.effectiveContextCheckpointId,
        context,
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
        if (this.directoryInUse(directory, workspace.id, Boolean(pending)))
          throw new NodeMutationConflict(
            "原工作目录或其子目录仍有任务运行、排队或回溯，请等待结束后原地重试。",
          );
      }
      const lock = `retry:${workspaceId}:${input.requestId}`;
      if (directory) this.activeDirectories.set(lock, directory);
      let releaseFiles: (() => void) | undefined;
      try {
        if (directory)
          releaseFiles = await this.fileOperations.acquire(
            { global: true, mode: "write", workingDirectory: directory },
            this.maintenanceController.signal,
          );
        if (this.closed) throw new Error("服务正在关闭，未启动文件回溯。");
        let journal: PendingNodeRetry | undefined = pending;
        const toRestore = history.filter((entry) => !entry.restoredAt);
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
          position: { ...node.position },
          color: node.color,
          createdAt: node.createdAt,
          revision: input.expectedRevision + 1,
          prompt: node.prompt,
          contextReferences: structuredClone(node.contextReferences),
          attachments: structuredClone(node.attachments),
          attachmentData: structuredClone(node.attachmentData),
          attachmentInputHash: node.attachmentInputHash,
          response: "",
          status: "queued",
          config: { ...node.config },
          contextIds: context.ids,
          contextSources: context.sources,
          ...selection,
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

  private assertNoPendingRestore(directory: string) {
    if (
      [...this.activeDirectories.entries()].some(
        ([id, active]) =>
          id.startsWith("retry:") && directoriesOverlap(directory, active),
      ) ||
      this.store.data.workspaces.some(
        (workspace) =>
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

  private directoryInUse(
    directory: string,
    ownWorkspaceId: string,
    continuingRestore = false,
  ) {
    return (
      [...this.activeDirectories.values()].some((active) =>
        directoriesOverlap(directory, active),
      ) ||
      (!continuingRestore &&
        this.store.data.workspaces.some((workspace) =>
          workspace.nodes.some(
            (node) =>
              (node.status === "running" || node.status === "queued") &&
              node.execution?.workingDirectory &&
              directoriesOverlap(directory, node.execution.workingDirectory),
          ),
        )) ||
      (!continuingRestore &&
        this.queue.some(
          (job) =>
            job.node.execution?.workingDirectory &&
            directoriesOverlap(directory, job.node.execution.workingDirectory),
        )) ||
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
        this.queue.some((job) => job.workspace.id === workspaceId)
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
    for (const job of this.contextJobs.values())
      job.controller.abort(new Error("服务关闭中断了摘要生成。"));
    for (const workspace of this.store.data.workspaces) {
      for (const node of workspace.nodes) {
        if (node.status === "running" || node.status === "queued") {
          node.status = "failed";
          node.error = "运行被服务关闭中断。可以在新节点继续，或在当前卡片原地重试。";
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
        !["policy", "safety_model", "approved"].includes(call.approval ?? "")
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
      }
      while (this.settingsChanges.has(workspace.id))
        await this.settingsChanges.get(workspace.id);
      signal.throwIfAborted();
      if (node.status !== "running" || call.status !== "running")
        throw new Error("任务已停止，未执行等待中的工具。");
      if (this.store.storageError) throw new Error(this.store.storageError);
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

  async approve(
    workspaceId: string,
    nodeId: string,
    toolId: string,
    decision: "approve" | "deny",
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
    const allowed = decision === "approve";
    call.approval = allowed ? "approved" : "denied";
    call.status = allowed ? "running" : "denied";
    if (!allowed) call.finishedAt = Date.now();
    try {
      if (allowed) this.issueAuthorization(workspace, node, call);
      this.store.touch(workspace);
      await this.store.save();
    } catch (error) {
      this.invalidateAuthorization(call, safeError(error));
      if (node.status === "running") {
        call.status = "awaiting_approval";
        call.approval = undefined;
        call.finishedAt = undefined;
      }
      this.store.touch(workspace);
      throw error;
    }
    resume(allowed);
  }

  private async beforeToolCall(
    workspace: StoredWorkspace,
    node: StoredNode,
    input: Pick<ToolCall, "id" | "name" | "arguments">,
    signal: AbortSignal,
  ) {
    while (this.settingsChanges.has(workspace.id))
      await this.settingsChanges.get(workspace.id);
    signal.throwIfAborted();
    const automatic = workspace.approvalMode === "auto";
    const safetyModel = workspace.safetyModel;
    const approvalVersion = this.approvalVersions.get(workspace.id) ?? 0;
    const call: ToolCall = {
      ...structuredClone(input),
      status: automatic
        ? "reviewing"
        : input.name === "read"
          ? "running"
          : "awaiting_approval",
      approval: !automatic && input.name === "read" ? "policy" : undefined,
      fileSnapshot: ["write", "edit", "bash"].includes(input.name)
        ? "unchanged"
        : undefined,
      startedAt: Date.now(),
      safetyReview: automatic
        ? {
            model: safetyModel ?? "",
            decision: "reviewing",
            reason: "等待安全模型审核，工具尚未执行。",
            startedAt: Date.now(),
          }
        : undefined,
    };
    if (node.toolCalls?.some((item) => item.id === call.id))
      throw new Error("模型返回了重复的工具调用 ID。");
    (node.toolCalls ??= []).push(call);
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
              contextReferencePrompt(node.prompt, node.contextReferences),
              node.attachmentData ?? [],
            ),
            ancestry: node.contextIds
              .map(
                (id) => workspace.nodes.find((ancestor) => ancestor.id === id)!,
              )
              .filter(Boolean)
              .map((ancestor) => ({
                prompt: attachmentPrompt(
                  contextReferencePrompt(
                    ancestor.prompt,
                    ancestor.contextReferences,
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
    if (input.name === "read") {
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
      const abort = () => finish(false);
      dispose = abort;
      this.approvals.set(key, finish);
      signal.addEventListener("abort", abort, { once: true });
    });
    this.store.touch(workspace);
    try {
      await this.store.save();
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
      const context = buildContext(workspace, node.parentId!);
      const sources = [
        ...context.sources,
        { nodeId: node.id, revision: node.revision ?? 0, messageCount: 0 },
      ];
      const assertRunContext = () => {
        controller.signal.throwIfAborted();
        if (
          node.status !== "running" ||
          !workspace.nodes.includes(node) ||
          JSON.stringify(buildContext(workspace, node.parentId!).sources) !==
            JSON.stringify(context.sources)
        )
          throw new NodeMutationConflict(
            "运行的上下文来源已改变，未继续调用模型。",
          );
      };
      const result = await this.runtime.run(
        node.config,
        context.messages,
        attachmentPrompt(
          contextReferencePrompt(node.prompt, node.contextReferences),
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
              beforeToolCall: (call) =>
                this.beforeToolCall(workspace, node, call, controller.signal),
              executeTool: (call, execute) =>
                this.executeAuthorizedTool(
                  workspace,
                  node,
                  call,
                  controller.signal,
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
          attachments: node.attachmentData,
          contextReferenceCount: node.contextReferences?.length,
          displayPrompt: node.prompt,
          autoCompact:
            node.contextAutoCompact ?? workspace.autoCompact !== false,
          sources,
          checkpoints: contextCheckpoints(workspace, context.ids),
          requestedCheckpointId:
            node.effectiveContextCheckpointId ??
            node.requestedContextCheckpointId,
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
        node.messages = result.messages;
        node.usage = result.usage;
        node.status = "completed";
      }
    } catch (error) {
      if (this.closed) {
        node.status = "failed";
        node.error = "运行被服务关闭中断。可以在新节点继续，或在当前卡片原地重试。";
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
