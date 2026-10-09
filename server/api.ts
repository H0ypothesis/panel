import { subagentCatalog } from "./subagent-profiles.ts";
import { thinkingDescription } from "../shared/thinking-controls.ts";
import { contextParentInput } from "./context-parents.ts";
import { StateEvents } from "./state-events.ts";
import { serveCuaPreview } from "./cua-preview.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ancestorPath,
  type ApprovalMode,
  type RunConfig,
} from "../shared/types.ts";
import { createWorkspace } from "./seed.ts";
import { safeError, type Runtime } from "./runtime.ts";
import { readToolImage } from "./tool-images.ts";
import { validateToolRequests } from "./tool-requests.ts";
import { NodeMutationConflict, Scheduler } from "./scheduler.ts";
import { Store } from "./store.ts";
import { listDirectories, workingDirectory } from "./directories.ts";
import { validateApprovalSettings } from "./approval-settings.ts";
import { webCapabilities } from "./web-tools.ts";
import { importWorkspace, MAX_IMPORT_BYTES } from "./workspace-import.ts";
import { readWorkspaceImportFile } from "./workspace-import-file.ts";
import {
  GeneratedFileError,
  listGeneratedFiles,
  serveGeneratedFile,
} from "./generated-files.ts";
import {
  MAX_ATTACHMENT_REQUEST_BYTES,
  type AttachmentUpload,
} from "../shared/attachments.ts";
import type {
  DiscoverProviderModels,
  ThinkingProbeInput,
  SaveProviderSettings,
} from "../shared/provider-settings.ts";
import { referenceNodeIds } from "./context-references.ts";
import { validateLongTask, workspaceDefaultConfig } from "./run-config.ts";

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

function runInput(body: Record<string, unknown>, allowAttachments = false) {
  const toolRequests = validateToolRequests(body.toolRequests);
  if (
    toolRequests?.length &&
    (typeof body.prompt !== "string" || !body.prompt.trim())
  )
    throw new Error("请选择工具后输入具体任务。");
  if (!allowAttachments && body.attachments !== undefined)
    throw new Error("重新生成会保留原附件；如需更换附件，请创建新分支。");
  if (body.attachments !== undefined && !Array.isArray(body.attachments))
    throw new Error("附件列表格式错误。");
  const attachments = body.attachments as AttachmentUpload[] | undefined;
  if (!allowAttachments && body.mergedContextCheckpointId !== undefined)
    throw new Error("重新生成会保留原整体摘要；如需更改，请创建新卡片。");
  if (!allowAttachments && body.contextParents !== undefined)
    throw new Error("重新生成会保留原分支接入；如需更改，请创建新卡片。");
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
  validateLongTask(config.longTask);
  return {
    prompt:
      field(body.prompt ?? "", "问题", 20000, Boolean(attachments?.length)) ||
      "请分析上传的附件。",
    ...(allowAttachments
      ? {
          attachments,
          contextParents: contextParentInput(body.contextParents),
          mergedContextCheckpointId:
            body.mergedContextCheckpointId === undefined
              ? undefined
              : field(body.mergedContextCheckpointId, "整体摘要 ID", 100),
        }
      : {}),
    referenceNodeIds: referenceNodeIds(body.referenceNodeIds),
    toolRequests,
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
  const stateEvents = new StateEvents(store);

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
      const generatedFile = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/nodes\/([^/]+)\/generated-files(?:\/([a-f0-9]{64})\/(content|native))?$/,
      );
      if (
        generatedFile &&
        request.method === (generatedFile[4] === "native" ? "POST" : "GET")
      ) {
        const workspace = store.data.workspaces.find(
          (item) => item.id === decodeURIComponent(generatedFile[1]),
        );
        const node = workspace?.nodes.find(
          (item) => item.id === decodeURIComponent(generatedFile[2]),
        );
        if (!workspace || !node)
          throw new GeneratedFileError("回答不存在或已删除。", 404);
        const revision = url.searchParams.get("revision");
        if (
          revision === null ||
          !/^\d+$/.test(revision) ||
          !Number.isSafeInteger(Number(revision))
        )
          throw new GeneratedFileError("请提供有效的回答版本。", 400);
        if ((node.revision ?? 0) !== Number(revision))
          throw new GeneratedFileError("回答已更新，请重新打开文件。", 409);
        if (generatedFile[4] === "native") await readJson(request, 1024);
        const fallback = store.temporaryDirectory(workspace);
        if (!generatedFile[3])
          json(response, 200, {
            files: await listGeneratedFiles(workspace, node, fallback),
          });
        else
          await serveGeneratedFile(
            request,
            response,
            workspace,
            node,
            fallback,
            generatedFile[3],
            generatedFile[4] as "native" | "content",
            url.searchParams.get("download") === "1",
          );
        return true;
      }
      const enterPreview = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/nodes\/([^/]+)\/computer-use\/preview\/enter$/,
      );
      if (request.method === "POST" && enterPreview) {
        const workspaceId = decodeURIComponent(enterPreview[1]);
        const nodeId = decodeURIComponent(enterPreview[2]);
        const body = await readJson(request, 4096);
        const revision = expectedRevision(body.expectedRevision);
        const scopeId = field(body.scopeId, "预览目标", 256);
        const find = () =>
          store.data.workspaces
            .find((workspace) => workspace.id === workspaceId)
            ?.nodes.find((node) => node.id === nodeId);
        const node = find();
        if (!node) {
          json(response, 404, { error: "任务不存在。" });
          return true;
        }
        const assertCurrent = () => {
          const live = find();
          if (
            !live ||
            (live.revision ?? 0) !== revision ||
            !["queued", "running"].includes(live.status) ||
            live.computerUseScope?.id !== scopeId
          )
            throw new NodeMutationConflict("预览目标已变化，请刷新后重试。");
        };
        assertCurrent();
        const source = runtime.computerUsePreviewSource?.(
          node.computerUseScope!,
        );
        if (!source?.active()) {
          json(response, 409, { error: "操作目标已释放，请刷新预览。" });
          return true;
        }
        const controller = new AbortController();
        const abort = () => controller.abort();
        response.on("close", abort);
        request.on("aborted", abort);
        try {
          await source.enter(
            AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
            assertCurrent,
          );
          json(response, 200, { ok: true });
        } finally {
          response.off("close", abort);
          request.off("aborted", abort);
          await source.close();
        }
        return true;
      }
      const preview = url.pathname.match(
        /^\/api\/workspaces\/([^/]+)\/nodes\/([^/]+)\/computer-use\/preview$/,
      );
      if (request.method === "GET" && preview) {
        const workspaceId = decodeURIComponent(preview[1]);
        const nodeId = decodeURIComponent(preview[2]);
        const revisionText = url.searchParams.get("revision");
        if (revisionText === null || !/^\d+$/.test(revisionText))
          throw new Error("请提供当前任务版本。");
        const revision = expectedRevision(Number(revisionText));
        const find = () =>
          store.data.workspaces
            .find((workspace) => workspace.id === workspaceId)
            ?.nodes.find((node) => node.id === nodeId);
        const node = find();
        if (!node) {
          json(response, 404, { error: "任务不存在。" });
          return true;
        }
        if ((node.revision ?? 0) !== revision) {
          json(response, 409, { error: "任务已更新，请重新打开预览。" });
          return true;
        }
        if (!runtime.computerUsePreviewSource) {
          json(response, 501, { error: "当前服务不支持实时预览。" });
          return true;
        }
        await serveCuaPreview(
          request,
          response,
          `${workspaceId}:${nodeId}`,
          () => {
            const live = find();
            const active =
              !!live &&
              (live.revision ?? 0) === revision &&
              ["queued", "running"].includes(live.status);
            const call = live?.toolCalls?.findLast(
              (call) =>
                call.name === "computer_use_call" &&
                ["running", "awaiting_approval", "reviewing"].includes(
                  call.status,
                ),
            );
            const operations: Record<string, string> = {
              get_window_state: "观察窗口",
              get_browser_state: "观察页面",
              click: "点击",
              browser_click: "点击页面",
              type_text: "输入",
              browser_type: "输入",
              scroll: "滚动",
              browser_navigate: "打开页面",
              drag: "拖动",
              press_key: "按键",
              hotkey: "按键",
              browser_pointer: "移动操作光标",
            };
            return {
              active,
              scope: active ? live?.computerUseScope : undefined,
              action: call
                ? (call.waitingFor ??
                  (call.status === "awaiting_approval"
                    ? "等待批准"
                    : call.status === "reviewing"
                      ? "正在审核操作"
                      : (operations[String(call.arguments.tool)] ??
                        "正在操作")))
                : "正在思考下一步",
            };
          },
          (scope) => runtime.computerUsePreviewSource!(scope),
          url.searchParams.get("native") === "1",
        );
        return true;
      }
      if (request.method === "GET" && url.pathname === "/api/state")
        json(response, 200, store.snapshot());
      else if (request.method === "GET" && url.pathname === "/api/models")
        json(response, 200, runtime.models());
      else if (request.method === "GET" && url.pathname === "/api/computer-use")
        json(
          response,
          200,
          runtime.computerUseStatus?.() ?? {
            available: false,
            connected: false,
            overlay: true,
          },
        );
      else if (
        request.method === "POST" &&
        url.pathname === "/api/computer-use/connect"
      ) {
        await readJson(request, 1024);
        if (!runtime.connectComputerUse)
          throw new Error("当前运行时不支持电脑控制。");
        json(response, 200, await runtime.connectComputerUse());
      } else if (
        request.method === "GET" &&
        url.pathname === "/api/subagent-settings"
      ) {
        if (!runtime.subagentSettings)
          throw new Error("当前运行时不支持子代理设置，请更新并重启服务。");
        json(response, 200, runtime.subagentSettings());
      } else if (
        request.method === "GET" &&
        url.pathname === "/api/subagent-profiles"
      ) {
        const workspaceId = url.searchParams.get("workspaceId");
        const workspace = workspaceId
          ? store.data.workspaces.find((item) => item.id === workspaceId)
          : undefined;
        if (workspaceId && !workspace) throw new Error("探索空间不存在。");
        json(
          response,
          200,
          await (runtime.subagentCatalog?.(
            workspace?.workingDirectory ?? process.cwd(),
          ) ?? subagentCatalog(workspace?.workingDirectory ?? process.cwd())),
        );
      } else if (
        request.method === "PUT" &&
        url.pathname === "/api/subagent-settings"
      ) {
        if (!runtime.saveSubagentSettings)
          throw new Error("当前运行时不支持子代理设置，请更新并重启服务。");
        json(
          response,
          200,
          await runtime.saveSubagentSettings(await readJson(request, 16384)),
        );
      } else if (
        request.method === "GET" &&
        url.pathname === "/api/model-providers"
      ) {
        if (!runtime.providerSettings)
          throw new Error("当前运行时不支持模型连接设置。");
        json(response, 200, runtime.providerSettings());
      } else if (
        request.method === "POST" &&
        /^\/api\/model-providers\/[^/]+\/(models|thinking-probe)$/.test(
          url.pathname,
        )
      ) {
        const probe = url.pathname.endsWith("/thinking-probe");
        if (
          probe
            ? !runtime.probeProviderThinking
            : !runtime.discoverProviderModels
        )
          throw new Error(
            probe
              ? "当前服务不支持思考检测，请更新并重启服务。"
              : "当前运行时不支持获取模型列表，请更新并重启服务。",
          );
        let body: Record<string, unknown>;
        try {
          body = await readJson(request, 16_384);
        } catch {
          throw new Error(
            "模型设置请求格式无效，请提交不超过 16 KB 的 JSON 配置。",
          );
        }
        const controller = new AbortController();
        const cancel = () => {
          if (!response.writableEnded) controller.abort();
        };
        response.on?.("close", cancel);
        try {
          const id = decodeURIComponent(url.pathname.split("/")[3]);
          const catalog = probe
            ? await runtime.probeProviderThinking!(
                id,
                body as unknown as ThinkingProbeInput,
                controller.signal,
              )
            : await runtime.discoverProviderModels!(
                id,
                body as unknown as DiscoverProviderModels,
                controller.signal,
              );
          json(response, 200, catalog);
        } finally {
          response.off?.("close", cancel);
        }
      } else if (
        request.method === "PUT" &&
        /^\/api\/model-providers\/[^/]+$/.test(url.pathname)
      ) {
        if (!runtime.saveProviderSettings)
          throw new Error("当前运行时不支持模型连接设置。");
        let body: Record<string, unknown>;
        try {
          body = await readJson(request, 16_384);
        } catch {
          // JSON parser diagnostics can contain a submitted, not-yet-stored key.
          throw new Error(
            "模型连接请求格式无效，请提交不超过 16 KB 的 JSON 配置。",
          );
        }
        const provider = await runtime.saveProviderSettings(
          decodeURIComponent(
            url.pathname.slice("/api/model-providers/".length),
          ),
          body as unknown as SaveProviderSettings,
        );
        json(response, 200, { provider, models: runtime.models() });
      } else if (
        request.method === "GET" &&
        url.pathname === "/api/capabilities"
      )
        json(response, 200, {
          ...webCapabilities(),
          cardReferences: true,
          branchMerging: true,
          mergeContextPreparation: true,
          toolBatchApproval: true,
          toolRequests: true,
          longTasks: true,
          computerUseTakeover: true,
          computerUseTaskControl: true,
          computerUsePreview: !!runtime.computerUsePreviewSource,
          runInputs: true,
        });
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
        stateEvents.subscribe(
          request,
          response,
          url.searchParams.get("patches") === "1",
        );
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
        if (body.config !== undefined) {
          workspace.defaultConfig = workspaceDefaultConfig(
            body.config,
            runtime.models(),
          );
          workspace.nodes[0].config = { ...workspace.defaultConfig };
        }
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
        await store.save({ workspace, createWorkspace: true });
        json(response, 201, {
          workspaceId: workspace.id,
          state: store.snapshot(),
        });
      } else {
        const toolImage = url.pathname.match(
          /^\/api\/workspaces\/([^/]+)\/nodes\/([^/]+)\/tool-images\/([^/]+)\/(\d+)$/,
        );
        if (request.method === "GET" && toolImage) {
          const revision = url.searchParams.get("revision");
          const workspace = store.data.workspaces.find(
            (item) => item.id === decodeURIComponent(toolImage[1]),
          );
          const node = workspace?.nodes.find(
            (item) => item.id === decodeURIComponent(toolImage[2]),
          );
          const numericRevision =
            revision && /^\d+$/.test(revision) ? Number(revision) : NaN;
          const run = Number.isSafeInteger(numericRevision)
            ? (node?.revision ?? 0) === numericRevision
              ? node
              : node?.previousRuns?.find(
                  (item) => (item.revision ?? 0) === numericRevision,
                )
            : undefined;
          const result = readToolImage(
            run?.messages,
            decodeURIComponent(toolImage[3]),
            Number(toolImage[4]),
          );
          if (!result) {
            json(response, 404, { error: "截图不存在或已删除。" });
            return true;
          }
          response.writeHead(200, {
            "Content-Type": result.mimeType,
            "Content-Length": result.data.length,
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'; sandbox",
          });
          response.end(result.data);
          return true;
        }
        const attachmentDownload = url.pathname.match(
          /^\/api\/workspaces\/([^/]+)\/nodes\/([^/]+)\/attachments\/([^/]+)$/,
        );
        if (request.method === "GET" && attachmentDownload) {
          const workspace = store.workspace(
            decodeURIComponent(attachmentDownload[1]),
          );
          const node = workspace.nodes.find(
            (item) => item.id === decodeURIComponent(attachmentDownload[2]),
          );
          const attachment = node?.attachmentData?.find(
            (item) =>
              item.metadata.id === decodeURIComponent(attachmentDownload[3]),
          );
          if (!attachment) {
            json(response, 404, { error: "附件不存在或已删除。" });
            return true;
          }
          const data = Buffer.from(attachment.data, "base64");
          const filename = encodeURIComponent(attachment.metadata.name).replace(
            /[!'()*]/g,
            (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
          );
          response.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${filename}`,
            "Content-Length": data.length,
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'; sandbox",
          });
          response.end(data);
          return true;
        }
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
        const mergeCompaction = url.pathname.match(
          /^\/api\/workspaces\/([^/]+)\/merge-context\/compact$/,
        );
        if (request.method === "POST" && mergeCompaction) {
          const body = await readJson(request);
          const config = body.config as Partial<RunConfig> | undefined;
          if (
            !config ||
            typeof config.model !== "string" ||
            typeof config.thinking !== "string"
          )
            throw new Error("请选择摘要使用的模型与思考强度。");
          validateLongTask(config.longTask);
          const checkpoint = await scheduler.compactMergeContext(
            decodeURIComponent(mergeCompaction[1]),
            {
              parentId: field(body.parentId, "主分支", 80),
              contextParents: contextParentInput(body.contextParents) ?? [],
              config: config as RunConfig,
              requestId: requestId(body.requestId),
            },
          );
          json(response, 200, { checkpoint, state: store.snapshot() });
          return true;
        }
        const cancelMergeCompaction = url.pathname.match(
          /^\/api\/workspaces\/([^/]+)\/merge-context\/compact\/([^/]+)\/cancel$/,
        );
        if (request.method === "POST" && cancelMergeCompaction) {
          await scheduler.cancelMergeContext(
            decodeURIComponent(cancelMergeCompaction[1]),
            requestId(decodeURIComponent(cancelMergeCompaction[2])),
          );
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
          validateLongTask(config.longTask);
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
        const computerUseTakeover = url.pathname.match(
          /^\/api\/workspaces\/([^/]+)\/nodes\/([^/]+)\/computer-use-takeover$/,
        );
        if (request.method === "POST" && computerUseTakeover) {
          const body = await readJson(request);
          if (typeof body.enabled !== "boolean")
            throw new Error("CUA 接管开关必须是布尔值。");
          if (
            (body.mode !== undefined &&
              body.mode !== "observe" &&
              body.mode !== "task") ||
            (body.scopeId !== undefined && typeof body.scopeId !== "string")
          )
            throw new Error("CUA 接管模式或范围无效。");
          await scheduler.setComputerUseTakeover(
            decodeURIComponent(computerUseTakeover[1]),
            decodeURIComponent(computerUseTakeover[2]),
            body.enabled,
            expectedRevision(body.expectedRevision),
            { mode: body.mode, scopeId: body.scopeId },
          );
          json(response, 200, store.snapshot());
          return true;
        }
        const subagentCommand = url.pathname.match(
          /^\/api\/workspaces\/([^/]+)\/nodes\/([^/]+)\/subagents$/,
        );
        const subagentAnswer = url.pathname.match(
          /^\/api\/workspaces\/([^/]+)\/nodes\/([^/]+)\/subagents\/answers\/([^/]+)$/,
        );
        if (request.method === "POST" && subagentAnswer) {
          const body = await readJson(request);
          scheduler.answerSubagentQuestion(
            decodeURIComponent(subagentAnswer[1]),
            decodeURIComponent(subagentAnswer[2]),
            expectedRevision(body.expectedRevision),
            decodeURIComponent(subagentAnswer[3]),
            body.answer,
          );
          json(response, 200, store.snapshot());
          return true;
        }
        if (request.method === "POST" && subagentCommand) {
          const body = await readJson(request);
          if (
            !body.input ||
            typeof body.input !== "object" ||
            Array.isArray(body.input)
          )
            throw new Error("子代理参数必须是对象。");
          const result = await scheduler.subagentCommand(
            decodeURIComponent(subagentCommand[1]),
            decodeURIComponent(subagentCommand[2]),
            expectedRevision(body.expectedRevision),
            body.input as Record<string, unknown>,
            body.tool === undefined
              ? undefined
              : field(body.tool, "工具名", 100),
          );
          json(response, 200, { result, state: store.snapshot() });
          return true;
        }
        const approval = url.pathname.match(
          /^\/api\/workspaces\/([^/]+)\/nodes\/([^/]+)\/approvals\/([^/]+)$/,
        );
        if (request.method === "POST" && approval) {
          const body = await readJson(request);
          if (
            body.decision !== "approve" &&
            body.decision !== "approve_tool" &&
            body.decision !== "retry_sandbox" &&
            body.decision !== "deny"
          )
            throw new Error("请选择批准、批量同意、重试沙盒或拒绝。");
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
          /^\/api\/workspaces\/([^/]+)\/(nodes|layout|export)(?:\/([^/]+))?(?:\/(cancel|inputs))?$/,
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
                    `## ${i + 1}. ${node.prompt}\n\n模型：${node.config.model} · 思考强度：${thinkingDescription(node.config)} · 状态：${node.status}\n\n${node.toolRequests?.length ? `指定工具：${node.toolRequests.map((tool) => `@${tool}`).join("、")}\n\n` : ""}${node.attachments?.length ? `附件：${node.attachments.map((file) => `${file.name.replace(/[\r\n]/g, " ")}（${file.size} 字节${file.truncated ? "，提取内容已截断" : ""}）`).join("、")}\n\n` : ""}${node.contextReferences?.length ? `引用卡片（保存时的内容快照）：\n\n${node.contextReferences.map((reference) => `> 卡片 ${reference.nodeId} · 版本 ${reference.revision}\n> 问题：${reference.prompt.replaceAll("\n", "\n> ")}\n> 回答：${reference.response.replaceAll("\n", "\n> ")}`).join("\n\n")}\n\n` : ""}${node.contextStale ? "> 上游已更新，此回答基于修改前的上下文，需重新生成。\n\n" : ""}${node.response || "（暂无回答）"}\n`,
                )
                .join("\n---\n\n");
            response.writeHead(200, {
              "Content-Type": "text/markdown; charset=utf-8",
              "Content-Disposition": 'attachment; filename="panel-path.md"',
            });
            response.end(markdown);
          } else {
            const exportedAt = new Date();
            const exportDate = [
              exportedAt.getFullYear(),
              String(exportedAt.getMonth() + 1).padStart(2, "0"),
              String(exportedAt.getDate()).padStart(2, "0"),
            ].join("-");
            const exportId = workspace.id.replace(/[^a-zA-Z0-9_-]/g, "_");
            response.setHeader(
              "Content-Disposition",
              `attachment; filename="panel-exploration_${exportId}_${exportDate}.json"`,
            );
            json(response, 200, {
              version: 1,
              exportedAt: exportedAt.toISOString(),
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
          const body = await readJson(request, MAX_ATTACHMENT_REQUEST_BYTES);
          const node = await scheduler.submit(workspaceId, {
            ...runInput(body, true),
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
          suffix === "inputs"
        ) {
          const body = await readJson(request);
          if (body.mode !== "steer" && body.mode !== "followUp")
            throw new Error("请选择引导当前任务或完成后继续。");
          const input = await scheduler.sendRunInput(workspaceId, nodeId, {
            text: field(body.text, "追加消息", 20000),
            mode: body.mode,
            requestId: field(body.requestId, "请求 ID", 80),
            expectedRevision: expectedRevision(body.expectedRevision),
          });
          json(response, 200, { input, state: store.snapshot() });
        } else if (
          request.method === "POST" &&
          action === "nodes" &&
          nodeId &&
          suffix === "cancel"
        ) {
          const body = await readJson(request);
          if (body.expectedRevision !== undefined) {
            const node = workspace.nodes.find((item) => item.id === nodeId);
            if (
              !node ||
              (node.revision ?? 0) !== expectedRevision(body.expectedRevision)
            )
              throw new NodeMutationConflict("任务已更新，未停止新的运行。");
          }
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
      if (response.headersSent) {
        response.destroy();
        return true;
      }
      json(
        response,
        error instanceof GeneratedFileError
          ? error.status
          : error instanceof NodeMutationConflict
            ? 409
            : 400,
        {
          error: safeError(error),
        },
      );
    }
    return true;
  };
}
