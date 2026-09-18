import { randomUUID } from "node:crypto";
import type { ApprovalMode, RunConfig, ToolCall } from "../shared/types.ts";
import { buildContext, estimateTokens } from "./context.ts";
import { safeError, type Runtime } from "./runtime.ts";
import type { StoredNode, StoredRun, StoredWorkspace } from "./store.ts";
import { Store } from "./store.ts";
import { directoriesOverlap, workingDirectory } from "./directories.ts";
import { validateApprovalSettings } from "./approval-settings.ts";
import {
  ToolAuthorizationRegistry,
  type ToolAuthorizationScope,
} from "./tool-authorization.ts";

interface Job {
  workspace: StoredWorkspace;
  node: StoredNode;
}
export class NodeMutationConflict extends Error {}

export class Scheduler {
  private queue: Job[] = [];
  private active = new Map<string, AbortController>();
  private activeDirectories = new Map<string, string>();
  private approvals = new Map<string, (allow: boolean) => void>();
  private settingsChanges = new Map<string, Promise<void>>();
  private mutations = new Map<string, Promise<unknown>>();
  private approvalVersions = new Map<string, number>();
  private authorizations = new ToolAuthorizationRegistry();
  private store: Store;
  private runtime: Runtime;
  private concurrency: number;
  private closed = false;

  constructor(store: Store, runtime: Runtime, concurrency = 3) {
    this.store = store;
    this.runtime = runtime;
    this.concurrency = concurrency;
  }

  submit(
    workspaceId: string,
    input: {
      parentId: string;
      prompt: string;
      config: RunConfig;
      requestId: string;
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
      config: RunConfig;
      requestId: string;
    },
  ) {
    const workspace = this.store.workspace(workspaceId);
    const duplicate = this.findRequest(workspace, input.requestId);
    if (duplicate) {
      if (
        (duplicate.run.revision ?? 0) !== 0 ||
        duplicate.run.parentId !== input.parentId ||
        duplicate.run.prompt !== input.prompt ||
        duplicate.run.config.model !== input.config.model ||
        duplicate.run.config.thinking !== input.config.thinking
      ) {
        throw new Error("请求 ID 已用于其他内容，请重新发送。");
      }
      return duplicate.node;
    }
    if (this.closed) throw new Error("服务正在关闭，请稍后重试。");
    if (this.store.storageError) throw new Error(this.store.storageError);
    const model = this.runtime
      .models()
      .find((item) => item.id === input.config.model);
    if (!model?.available)
      throw new Error(
        `模型未配置。请设置 ${model?.envVar ?? "相应的 API Key"} 后重启服务。`,
      );
    if (!model.thinkingLevels.includes(input.config.thinking))
      throw new Error("该模型不支持所选思考强度。");
    const context = buildContext(workspace, input.parentId);
    if (
      estimateTokens(context.messages, input.prompt) + 4096 >
      model.contextWindow
    )
      throw new Error(
        "这条路径预计超过模型上下文预算，请从较早的节点分支或选择更大上下文的模型。",
      );
    const parent = workspace.nodes.find((node) => node.id === input.parentId)!;
    const siblings = workspace.nodes.filter(
      (node) => node.parentId === input.parentId,
    );
    const colors = ["sage", "violet", "blue", "amber"] as const;
    const x = parent.position.x + 360;
    let y = parent.position.y;
    while (
      workspace.nodes.some(
        (node) =>
          Math.abs(node.position.x - x) < 290 &&
          Math.abs(node.position.y - y) < 235,
      )
    )
      y += 250;
    const node: StoredNode = {
      id: randomUUID(),
      parentId: parent.id,
      prompt: input.prompt,
      response: "",
      status: "queued",
      config: { ...input.config },
      contextIds: context.ids,
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
  ) {
    if (this.closed) throw new Error("服务正在关闭，请稍后重试。");
    if (this.store.storageError) throw new Error(this.store.storageError);
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
          this.active.has(item.id),
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
      config: RunConfig;
      requestId: string;
      expectedRevision: number;
    },
  ) {
    return this.serializeMutation(workspaceId, async () => {
      const workspace = this.store.workspace(workspaceId);
      if (
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 0
      )
        throw new Error("节点版本无效。");
      const duplicate = this.findRequest(workspace, input.requestId);
      if (duplicate) {
        if (
          duplicate.node.id !== nodeId ||
          (duplicate.run.revision ?? 0) !== input.expectedRevision + 1 ||
          duplicate.run.prompt !== input.prompt ||
          duplicate.run.config.model !== input.config.model ||
          duplicate.run.config.thinking !== input.config.thinking
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
      // Build from the parent; the old question, answer and transcript are never replayed.
      const context = buildContext(workspace, node.parentId!);
      if (
        estimateTokens(context.messages, input.prompt) + 4096 >
        model.contextWindow
      )
        throw new Error(
          "这条路径预计超过模型上下文预算，请从较早的节点分支或选择更大上下文的模型。",
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
        response: "",
        status: "queued",
        config: { ...input.config },
        contextIds: context.ids,
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
    },
  ) {
    const change = this.serializeMutation(workspaceId, async () => {
      const workspace = this.store.workspace(workspaceId);
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
      await this.store.save({
        workspace,
        values: {
          workingDirectory: directory,
          approvalMode: mode,
          safetyModel,
        },
      });
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
    for (const workspace of this.store.data.workspaces) {
      for (const node of workspace.nodes) {
        if (node.status === "running" || node.status === "queued") {
          node.status = "failed";
          node.error = "运行被服务关闭中断。请从父节点重新生成。";
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
          ![...this.activeDirectories.values()].some((directory) =>
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
      this.store.effectiveWorkingDirectory(workspace) !==
        node.execution.workingDirectory
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
    const call = node.toolCalls?.find((item) => item.id === input.id);
    let consumedHere = false;
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
      while (this.settingsChanges.has(workspace.id))
        await this.settingsChanges.get(workspace.id);
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
      return execute();
    } catch (error) {
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
            userRequest: node.prompt,
            ancestry: node.contextIds
              .map(
                (id) => workspace.nodes.find((ancestor) => ancestor.id === id)!,
              )
              .filter(Boolean)
              .map((ancestor) => ({
                prompt: ancestor.prompt,
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
      const result = await this.runtime.run(
        node.config,
        context.messages,
        node.prompt,
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
                    ? safeError(update.output, 20000)
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
        node.error = "运行被服务关闭中断。请从父节点重新生成。";
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
