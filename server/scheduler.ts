import { randomUUID } from "node:crypto";
import type { RunConfig } from "../shared/types.ts";
import { buildContext, estimateTokens } from "./context.ts";
import { safeError, type Runtime } from "./runtime.ts";
import type { StoredNode, StoredWorkspace } from "./store.ts";
import { Store } from "./store.ts";

interface Job {
  workspace: StoredWorkspace;
  node: StoredNode;
}
export class Scheduler {
  private queue: Job[] = [];
  private active = new Map<string, AbortController>();
  private store: Store;
  private runtime: Runtime;
  private concurrency: number;
  private closed = false;

  constructor(store: Store, runtime: Runtime, concurrency = 3) {
    this.store = store;
    this.runtime = runtime;
    this.concurrency = concurrency;
  }

  async submit(
    workspaceId: string,
    input: {
      parentId: string;
      prompt: string;
      config: RunConfig;
      requestId: string;
    },
  ) {
    const workspace = this.store.workspace(workspaceId);
    const duplicate = workspace.nodes.find(
      (node) => node.requestId === input.requestId,
    );
    if (duplicate) {
      if (
        duplicate.parentId !== input.parentId ||
        duplicate.prompt !== input.prompt ||
        duplicate.config.model !== input.config.model ||
        duplicate.config.thinking !== input.config.thinking
      ) {
        throw new Error("请求 ID 已用于其他内容，请重新发送。");
      }
      return duplicate;
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
    };
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

  async cancel(workspaceId: string, nodeId: string) {
    const workspace = this.store.workspace(workspaceId);
    const node = workspace.nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error("节点不存在。");
    if (node.status !== "running" && node.status !== "queued") return;
    node.status = "cancelled";
    node.finishedAt = Date.now();
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
      const job = this.queue.shift()!;
      if (job.node.status !== "queued") continue;
      const controller = new AbortController();
      this.active.set(job.node.id, controller);
      void this.execute(job, controller).finally(() => {
        this.active.delete(job.node.id);
        this.pump();
      });
    }
  }

  private async execute({ workspace, node }: Job, controller: AbortController) {
    try {
      node.status = "running";
      node.startedAt = Date.now();
      this.store.touch(workspace);
      await this.store.save();
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
      node.finishedAt = Date.now();
      this.store.touch(workspace);
      await this.store.save().catch(() => {}); // Store exposes failures to all connected clients.
    }
  }
}
