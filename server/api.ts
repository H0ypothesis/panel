import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ancestorPath,
  type ApprovalMode,
  type RunConfig,
} from "../shared/types.ts";
import { createWorkspace } from "./seed.ts";
import { safeError, type Runtime } from "./runtime.ts";
import { NodeMutationConflict, Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import { listDirectories, workingDirectory } from "./directories.ts";
import { validateApprovalSettings } from "./approval-settings.ts";
import { webCapabilities } from "./web-tools.ts";
import { importWorkspace, MAX_IMPORT_BYTES } from "./workspace-import.ts";
import { readWorkspaceImportFile } from "./workspace-import-file.ts";

function approvalMode(value: unknown): ApprovalMode {
  if (value !== "ask" && value !== "auto")
    throw new Error("审批模式必须是请求批准或自动审批。");
  return value;
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJson(
  request: IncomingMessage,
  maxBytes = 512_000,
): Promise<Record<string, unknown>> {
  if (!request.headers["content-type"]?.startsWith("application/json"))
    throw new Error("请求必须使用 application/json。");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("请求内容过大。");
    chunks.push(chunk);
  }
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("请求格式错误。");
  return data as Record<string, unknown>;
}

function field(
  value: unknown,
  label: string,
  max: number,
  empty = false,
): string {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > max
  )
    throw new Error(`${label}不能为空且最多 ${max} 个字符。`);
  return value.trim();
}

function expectedRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("请提供有效的节点版本。");
  return value;
}

function requestId(value: unknown): string {
  const id = field(value, "请求 ID", 80);
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw new Error("请求 ID 格式错误。");
  return id;
}

function runInput(body: Record<string, unknown>) {
  if (body.contextMode !== undefined && body.contextMode !== "raw")
    throw new Error("上下文选择无效。");
  if (body.contextMode === "raw" && body.contextCheckpointId !== undefined)
    throw new Error("原文和压缩摘要不能同时选择。");
  const config = body.config as Partial<RunConfig> | undefined;
  if (
    !config ||
    typeof config.model !== "string" ||
    typeof config.thinking !== "string"
  )
    throw new Error("请选择模型与思考强度。");
  return {
    prompt: field(body.prompt, "问题", 20000),
    config: config as RunConfig,
    requestId: requestId(body.requestId),
    contextMode: body.contextMode as "raw" | undefined,
    contextCheckpointId:
      body.contextCheckpointId === undefined
        ? undefined
        : field(body.contextCheckpointId, "摘要 ID", 100),
  };
}

export function createApi(
  store: Store,
  runtime: Runtime,
  scheduler: Scheduler,
) {
  const clients = new Set<ServerResponse>();
  let broadcast: ReturnType<typeof setTimeout> | undefined;
  store.on("change", () => {
    if (broadcast) return;
    broadcast = setTimeout(() => {
      broadcast = undefined;
      const payload = `data: ${JSON.stringify(store.snapshot())}\n\n`;
      for (const client of clients) {
        if (client.writableLength > 2_000_000) {
          client.destroy();
          clients.delete(client);
        } else client.write(payload);
      }
    }, 60);
  });

  return async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/api/")) return false;
    response.setHeader("X-Content-Type-Options", "nosniff");
    const host = request.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      json(response, 403, { error: "仅支持本机访问。" });
      return true;
    }
    const origin = request.headers.origin;
    if (origin && origin !== `http://${host}`) {
      json(response, 403, { error: "不允许跨站请求。" });
      return true;
    }
    if (request.headers["sec-fetch-site"] === "cross-site") {
      json(response, 403, { error: "不允许跨站请求。" });
      return true;
    }
    try {
      if (request.method === "GET" && url.pathname === "/api/state")
        json(response, 200, store.snapshot());
      else if (request.method === "GET" && url.pathname === "/api/models")
        json(response, 200, runtime.models());
      else if (request.method === "GET" && url.pathname === "/api/capabilities")
        json(response, 200, webCapabilities());
      else if (request.method === "GET" && url.pathname === "/api/directories")
        json(
          response,
          200,
          await listDirectories(url.searchParams.get("path")),
        );
      else if (request.method === "GET" && url.pathname === "/api/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.write(`data: ${JSON.stringify(store.snapshot())}\n\n`);
        clients.add(response);
        const heartbeat = setInterval(
          () => response.write(": keepalive\n\n"),
          15000,
        );
        request.on("close", () => {
          clients.delete(response);
          clearInterval(heartbeat);
        });
      } else if (
        request.method === "POST" &&
        url.pathname === "/api/workspaces/import"
      ) {
        const body = await readJson(request, MAX_IMPORT_BYTES);
        const hasPath = Object.hasOwn(body, "path");
        const hasData = Object.hasOwn(body, "data");
        if (hasPath === hasData)
          throw new Error("请选择一个 JSON 文件或填写一个 JSON 文件路径。");
        const workspace = importWorkspace(
          hasPath ? await readWorkspaceImportFile(body.path) : body.data,
        );
        await store.save({ workspace, createWorkspace: true });
        json(response, 201, {
          workspaceId: workspace.id,
          state: store.snapshot(),
        });
      } else if (
        request.method === "POST" &&
        url.pathname === "/api/workspaces"
      ) {
        const body = await readJson(request);
        const workspace = createWorkspace(
          field(body.title, "标题", 80),
          field(body.description ?? "", "背景", 10000, true),
        );
        workspace.approvalMode = approvalMode(body.approvalMode ?? "ask");
        if (
          body.autoCompact !== undefined &&
          typeof body.autoCompact !== "boolean"
        )
          throw new Error("自动压缩设置必须为布尔值。");
        workspace.autoCompact = body.autoCompact !== false;
        if (
          body.safetyModel !== undefined &&
          body.safetyModel !== null &&
          body.safetyModel !== ""
        )
          workspace.safetyModel = field(body.safetyModel, "安全模型", 300);
        validateApprovalSettings(
          runtime,
          workspace.approvalMode,
          workspace.safetyModel,
        );
        if (
          body.workingDirectory !== undefined &&
          body.workingDirectory !== null &&
          body.workingDirectory !== ""
        )
          workspace.workingDirectory = await workingDirectory(
            body.workingDirectory,
          );
        scheduler.assertDirectoryAvailable(workspace.workingDirectory);
        store.data.workspaces.unshift(workspace);
        store.touch(workspace);
        await store.save();
        json(response, 201, {
          workspaceId: workspace.id,
          state: store.snapshot(),
        });
      } else {
        const settings = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/);
        if (request.method === "DELETE" && settings) {
          const body = await readJson(request);
          if (
            body.deleteTemporaryDirectory !== undefined &&
            typeof body.deleteTemporaryDirectory !== "boolean"
          )
            throw new Error("请选择是否清理临时目录文件。");
          if (
            !Array.isArray(body.expectedNodeIds) ||
            !body.expectedNodeIds.length
          )
            throw new Error("请提供确认删除的节点范围。");
          const state = await scheduler.deleteWorkspace(
            decodeURIComponent(settings[1]),
            {
              deleteTemporaryDirectory: body.deleteTemporaryDirectory === true,
              expectedNodeIds: body.expectedNodeIds.map((id) =>
                field(id, "节点 ID", 80),
              ),
            },
          );
          json(response, 200, state);
          return true;
        }
        if (request.method === "PATCH" && settings) {
          const workspace = store.workspace(settings[1]);
          const body = await readJson(request);
          const mode =
            body.approvalMode !== undefined
              ? approvalMode(body.approvalMode)
              : undefined;
          if (
            body.autoCompact !== undefined &&
            typeof body.autoCompact !== "boolean"
          )
            throw new Error("自动压缩设置必须为布尔值。");
          const directory =
            body.workingDirectory === undefined
              ? undefined
              : body.workingDirectory === null || body.workingDirectory === ""
                ? null
                : await workingDirectory(body.workingDirectory);
          await scheduler.configureWorkspace(workspace.id, {
            workingDirectory: directory,
            approvalMode: mode,
            autoCompact: body.autoCompact as boolean | undefined,
            safetyModel:
              body.safetyModel === undefined
                ? undefined
                : body.safetyModel === null || body.safetyModel === ""
                  ? null
                  : field(body.safetyModel, "安全模型", 300),
          });
          json(response, 200, store.snapshot());
          return true;
        }
        const compaction = url.pathname.match(
          /^\/api\/workspaces\/([^/]+)\/nodes\/([^/]+)\/compact$/,
        );
        if (request.method === "POST" && compaction) {
          const body = await readJson(request);
          const config = body.config as Partial<RunConfig> | undefined;
          if (
            !config ||
            typeof config.model !== "string" ||
            typeof config.thinking !== "string"
          )
            throw new Error("请选择摘要使用的模型与思考强度。");
          const checkpoint = await scheduler.compactContext(
            decodeURIComponent(compaction[1]),
            decodeURIComponent(compaction[2]),
            {
              config: config as RunConfig,
              expectedRevision: expectedRevision(body.expectedRevision),
              requestId: requestId(body.requestId),
            },
          );
          json(response, 200, {
            checkpointId: checkpoint?.id,
            state: store.snapshot(),
          });
          return true;
        }
        const approval = url.pathname.match(
          /^\/api\/workspaces\/([^/]+)\/nodes\/([^/]+)\/approvals\/([^/]+)$/,
        );
        if (request.method === "POST" && approval) {
          const body = await readJson(request);
          if (body.decision !== "approve" && body.decision !== "deny")
            throw new Error("请选择批准或拒绝。");
          await scheduler.approve(
            decodeURIComponent(approval[1]),
            decodeURIComponent(approval[2]),
            decodeURIComponent(approval[3]),
            body.decision,
            body.expectedRevision === undefined
              ? undefined
              : expectedRevision(body.expectedRevision),
          );
          json(response, 200, store.snapshot());
          return true;
        }
        const retry = url.pathname.match(
          /^\/api\/workspaces\/([^/]+)\/nodes\/([^/]+)\/retry$/,
        );
        if (request.method === "POST" && retry) {
          const body = await readJson(request);
          const node = await scheduler.retry(
            decodeURIComponent(retry[1]),
            decodeURIComponent(retry[2]),
            {
              requestId: requestId(body.requestId),
              expectedRevision: expectedRevision(body.expectedRevision),
            },
          );
          json(response, 200, { nodeId: node.id, state: store.snapshot() });
          return true;
        }
        const regenerate = url.pathname.match(
          /^\/api\/workspaces\/([^/]+)\/nodes\/([^/]+)\/regenerate$/,
        );
        if (request.method === "POST" && regenerate) {
          const body = await readJson(request);
          const node = await scheduler.regenerate(
            decodeURIComponent(regenerate[1]),
            decodeURIComponent(regenerate[2]),
            {
              ...runInput(body),
              expectedRevision: expectedRevision(body.expectedRevision),
            },
          );
          json(response, 200, { nodeId: node.id, state: store.snapshot() });
          return true;
        }
        const match = url.pathname.match(
          /^\/api\/workspaces\/([^/]+)\/(nodes|layout|export)(?:\/([^/]+))?(?:\/(cancel))?$/,
        );
        if (!match) {
          json(response, 404, { error: "接口不存在。" });
          return true;
        }
        const [, workspaceId, action, nodeId, suffix] = match;
        const workspace = store.workspace(workspaceId);
        if (request.method === "GET" && action === "export") {
          if (url.searchParams.get("format") === "markdown") {
            const path = ancestorPath(
              workspace.nodes,
              url.searchParams.get("node") ?? workspace.nodes[0].id,
            );
            const markdown =
              `# ${workspace.title}\n\n${workspace.description}\n\n` +
              path
                .slice(1)
                .map(
                  (node, i) =>
                    `## ${i + 1}. ${node.prompt}\n\n模型：${node.config.model} · 思考强度：${node.config.thinking} · 状态：${node.status}\n\n${node.contextStale ? "> 上游已更新，此回答基于修改前的上下文，需重新生成。\n\n" : ""}${node.response || "（暂无回答）"}\n`,
                )
                .join("\n---\n\n");
            response.writeHead(200, {
              "Content-Type": "text/markdown; charset=utf-8",
              "Content-Disposition": 'attachment; filename="panel-path.md"',
            });
            response.end(markdown);
          } else {
            response.setHeader(
              "Content-Disposition",
              'attachment; filename="panel-exploration.json"',
            );
            json(response, 200, {
              version: 1,
              exportedAt: new Date().toISOString(),
              workspace: {
                ...store
                  .snapshot()
                  .workspaces.find((item) => item.id === workspace.id),
                // The UI snapshot omits transcripts; an explicit JSON export keeps
                // the full original messages, archived runs, and derived summaries.
                nodes: workspace.nodes.map(
                  ({ preparationRequest: _preparationRequest, ...node }) =>
                    node,
                ),
              },
            });
          }
        } else if (request.method === "POST" && action === "nodes" && !nodeId) {
          const body = await readJson(request);
          const node = await scheduler.submit(workspaceId, {
            ...runInput(body),
            parentId: field(body.parentId, "父节点", 80),
          });
          json(response, 201, { nodeId: node.id, state: store.snapshot() });
        } else if (
          request.method === "DELETE" &&
          action === "nodes" &&
          nodeId &&
          !suffix
        ) {
          const body = await readJson(request);
          if (
            !Array.isArray(body.expectedNodeIds) ||
            !body.expectedNodeIds.length
          )
            throw new Error("请提供确认删除的节点范围。");
          const expectedNodeIds = body.expectedNodeIds.map((id) =>
            field(id, "节点 ID", 80),
          );
          await scheduler.deleteNode(workspaceId, nodeId, {
            expectedRevision: expectedRevision(body.expectedRevision),
            expectedNodeIds,
          });
          json(response, 200, store.snapshot());
        } else if (
          request.method === "POST" &&
          action === "nodes" &&
          nodeId &&
          suffix === "cancel"
        ) {
          await readJson(request);
          await scheduler.cancel(workspaceId, nodeId);
          json(response, 200, store.snapshot());
        } else if (
          request.method === "PATCH" &&
          (action === "layout" || (action === "nodes" && nodeId && !suffix))
        ) {
          const body = await readJson(request);
          const positions =
            action === "layout" ? body.positions : { [nodeId!]: body.position };
          if (
            !positions ||
            typeof positions !== "object" ||
            Array.isArray(positions)
          )
            throw new Error("坐标格式错误。");
          const updates = Object.entries(positions).map(([id, value]) => {
            const node = workspace.nodes.find((item) => item.id === id);
            const position = value as { x?: unknown; y?: unknown } | null;
            if (
              !node ||
              !position ||
              typeof position.x !== "number" ||
              typeof position.y !== "number" ||
              !Number.isFinite(position.x) ||
              !Number.isFinite(position.y) ||
              Math.abs(position.x) > 1e6 ||
              Math.abs(position.y) > 1e6
            )
              throw new Error("节点或坐标无效。");
            return { node, position: { x: position.x, y: position.y } };
          });
          await scheduler.updatePositions(
            workspaceId,
            Object.fromEntries(
              updates.map((update) => [update.node.id, update.position]),
            ),
          );
          json(response, 200, store.snapshot());
        } else json(response, 404, { error: "接口不存在。" });
      }
    } catch (error) {
      json(response, error instanceof NodeMutationConflict ? 409 : 400, {
        error: safeError(error),
      });
    }
    return true;
  };
}
