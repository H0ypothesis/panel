import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleHelp,
  Command,
  Copy,
  FileJson,
  FileText,
  GitBranch,
  Globe,
  Layers,
  LoaderCircle,
  Monitor,
  Moon,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldQuestion,
  Sparkles,
  Square,
  Sun,
  Unplug,
  X,
  Zap,
} from "lucide-react";
import {
  ancestorPath,
  DEFAULT_CONFIG,
  statusLabels,
  thinkingLabels,
  type AppState,
  type ApprovalMode,
  type ModelOption,
  type RunConfig,
  type ToolApprovalDecision,
  type TurnNode,
  type WebCapabilities,
  type Workspace,
} from "../shared/types";
import {
  api,
  readPreference,
  savePreference,
  type MutationResult,
} from "./api";
import { Graph, StatusIcon } from "./Graph";
import { ResizableWorkspace } from "./ResizableWorkspace";
import { ToolActivity } from "./CodingControls";
import { GenerationIndicator } from "./GenerationIndicator";
import { AssistantResponse } from "./AssistantResponse";
import "./assistant-response.css";
import { Markdown } from "./Markdown";
import { responseText } from "../shared/response-parts";
import { getGenerationActivity } from "./generation-activity";
import { canBranchFrom } from "../shared/node-branching";
import { ContextCompression } from "./ContextCompression";
import {
  checkpointMatchesPath,
  compressionNodeId,
  preparedCheckpoints,
} from "../shared/context-graph";
import {
  ComposerModelControls,
  RootDirectoryCard,
  WorkbenchControls,
} from "./WorkspaceControls";
import { useTheme, type ThemePreference } from "./useTheme";
import { useCollapsibleComposer } from "./useCollapsibleComposer";
import "./composer-collapse.css";
import {
  contextUsageForNode,
  estimatePathContextTokens,
} from "../shared/context-usage";
import { formatContextWindow } from "./model-context";
import type { CanvasBranchDraft } from "./branch-draft";
import { AttachmentPicker, AttachmentList } from "./Attachments";
import { encodeAttachments } from "./attachment-draft";
import { CardReferenceInput } from "./CardReferenceInput";
import { CardReferenceList } from "./CardReferenceList";
import { BrandHint } from "./BrandHint";
import { DeleteWorkspaceDialog } from "./DeleteWorkspaceDialog";
import { NewWorkspace } from "./NewWorkspace";
import { getDesktopBridge, onDesktopAction } from "./desktop";
import {
  NodeActionsDialog,
  subtreeIds,
  type NodeActionTarget,
} from "./NodeActionsDialog";

const EMPTY_ATTACHMENT_FILES: File[] = [];
const CONTINUE_PROMPT =
  "请从上一轮中断的位置继续完成尚未完成的任务。沿用已有回答和已完成的工具结果，先核对当前进度与文件状态，避免重复已经完成的操作；对未返回结果的工具先确认实际状态，再决定下一步。";

function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`logo ${small ? "small" : ""}`}>
      <svg width="30" height="30" viewBox="0 0 36 36" fill="none">
        <rect width="36" height="36" rx="10" fill="var(--logo-background)" />
        <path
          d="M11 11v14m0-7h8m0 0v-7m0 7 7 7"
          stroke="var(--logo-foreground)"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <circle cx="11" cy="11" r="2.2" fill="var(--logo-foreground)" />
        <circle cx="19" cy="11" r="2.2" fill="var(--logo-foreground)" />
        <circle cx="26" cy="25" r="2.2" fill="var(--logo-foreground)" />
      </svg>
      {!small && (
        <b>
          panel<span>·</span>
        </b>
      )}
    </span>
  );
}

export function App() {
  const { preference: theme, colorMode, changeTheme } = useTheme();
  const [state, setState] = useState<AppState | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [webCapabilities, setWebCapabilities] =
    useState<WebCapabilities | null>(null);
  const [workspaceId, setWorkspaceId] = useState(readPreference("workspace"));
  const [selectedId, setSelectedId] = useState(readPreference("node"));
  const [online, setOnline] = useState(false);
  const [error, setError] = useState("");
  const [modal, setModal] = useState<
    "new" | "settings" | "help" | "directory" | null
  >(null);
  const [changingApproval, setChangingApproval] = useState(false);
  const [changingAutoCompact, setChangingAutoCompact] = useState<
    Record<string, boolean>
  >({});
  const autoCompactLocks = useRef(new Set<string>());
  const [compactingPaths, setCompactingPaths] = useState<
    Record<string, boolean>
  >({});
  const compactionLocks = useRef(new Set<string>());
  const compactionRequestIds = useRef(new Map<string, string>());
  const [selectedCompression, setSelectedCompression] = useState<{
    workspaceId: string;
    parentId: string;
    revision: number;
    checkpointId: string;
  } | null>(null);
  const [safetyModelRequired, setSafetyModelRequired] = useState(false);
  const [directoryDirty, setDirectoryDirty] = useState(false);
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [approvalFocus, setApprovalFocus] = useState<{
    nodeId: string;
    toolId: string;
    version: number;
  } | null>(null);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [tab, setTab] = useState<"conversation" | "context">("conversation");
  const [drafts, setDrafts] = useState<
    Record<
      string,
      {
        text: string;
        files?: File[];
        referenceNodeIds?: string[];
        requestId: string;
        contextMode?: "raw";
      }
    >
  >({});
  const [config, setConfig] = useState<RunConfig>({ ...DEFAULT_CONFIG });
  const configSelection = useRef({ nodeId: "", revision: -1, resolved: false });
  const [submitting, setSubmitting] = useState(false);
  const submissionLock = useRef(false);
  const [canvasDrafts, setCanvasDrafts] = useState<
    Record<string, CanvasBranchDraft>
  >({});
  const [canvasDraftParents, setCanvasDraftParents] = useState<
    Record<string, string>
  >({});
  const [canvasSubmittingId, setCanvasSubmittingId] = useState<string | null>(
    null,
  );
  const [nodeAction, setNodeAction] = useState<NodeActionTarget | null>(null);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<Workspace | null>(
    null,
  );
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const retryRequestIds = useRef(new Map<string, string>());
  const [continuingId, setContinuingId] = useState<string | null>(null);
  const continuationRequestIds = useRef(new Map<string, string>());
  const [sidebar, setSidebar] = useState(window.innerWidth > 1000);
  const [headingCollapsed, setHeadingCollapsed] = useState(
    () => readPreference("heading-collapsed") === "true",
  );
  const [focus, setFocus] = useState<{ id: string | null; version: number }>({
    id: null,
    version: 0,
  });
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const closeSidebar = useCallback(() => {
    setSidebar(false);
    requestAnimationFrame(() => sidebarToggleRef.current?.focus());
  }, []);
  const apply = useCallback(
    (next: AppState) =>
      setState((current) =>
        !current ||
        next.instanceId !== current.instanceId ||
        next.revision >= current.revision
          ? next
          : current,
      ),
    [],
  );
  const fail = useCallback(
    (reason: unknown) =>
      setError(reason instanceof Error ? reason.message : "操作失败，请重试。"),
    [],
  );

  useEffect(() => {
    let mounted = true;
    void Promise.all([
      api<AppState>("/state"),
      api<ModelOption[]>("/models"),
      api<WebCapabilities>("/capabilities"),
    ])
      .then(([next, options, capabilities]) => {
        if (mounted) {
          apply(next);
          setModels(options);
          setWebCapabilities(capabilities);
        }
      })
      .catch(fail);
    const events = new EventSource("/api/events");
    events.onmessage = (event) => {
      apply(JSON.parse(event.data));
      setOnline(true);
    };
    events.onopen = () => {
      setOnline(true);
      void Promise.all([
        api<ModelOption[]>("/models"),
        api<WebCapabilities>("/capabilities"),
      ])
        .then(([options, capabilities]) => {
          if (mounted) {
            setModels(options);
            setWebCapabilities(capabilities);
          }
        })
        .catch(fail);
    };
    events.onerror = () => setOnline(false);
    return () => {
      mounted = false;
      events.close();
    };
  }, [apply, fail]);

  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 1000px)");
    const update = () => setSidebar(!narrow.matches);
    narrow.addEventListener("change", update);
    return () => narrow.removeEventListener("change", update);
  }, []);

  const workspace =
    state?.workspaces.find((item) => item.id === workspaceId) ??
    state?.workspaces[0];
  const currentWorkspaceId = useRef(workspace?.id);
  currentWorkspaceId.current = workspace?.id;
  const canvasDraftKey = `${workspace?.id}:${workspace ? canvasDraftParents[workspace.id] : ""}`;
  const canvasDraft = canvasDrafts[canvasDraftKey] ?? null;
  const canvasParent = workspace?.nodes.find(
    (node) => node.id === canvasDraft?.parentId,
  );
  const canvasModel = models.find(
    (item) => item.id === canvasDraft?.config.model,
  );
  const canvasDraftBlockedReason = !canvasDraft
    ? ""
    : !canvasParent
      ? "来源节点已删除，请取消草稿后重新选择节点。"
      : canvasParent.contextStale ||
          (canvasParent.revision ?? 0) !== canvasDraft.parentRevision
        ? "来源上下文已更新，请点击来源节点的加号重新确认。"
        : canvasDraft.contextCheckpointId &&
            !preparedCheckpoints(canvasParent).some(
              (checkpoint) =>
                checkpoint.id === canvasDraft.contextCheckpointId &&
                checkpointMatchesPath(
                  checkpoint,
                  workspace!.nodes,
                  canvasParent.id,
                ),
            )
          ? "此压缩节点已失效，请取消草稿后重新选择来源。"
          : !canBranchFrom(canvasParent)
            ? canvasParent.retryRestore
              ? "请先完成来源节点的文件恢复与重试，再生成分支。"
              : "请等待来源节点结束后再生成分支。"
            : !online
              ? "连接已断开，恢复连接后可继续生成。"
              : directoryDirty || directoryBusy
                ? "请先完成工作目录设置。"
                : changingApproval
                  ? "正在保存审批设置，请稍候。"
                  : submitting && canvasSubmittingId !== canvasDraft.id
                    ? "另一条问题正在提交，请稍候。"
                    : !canvasModel?.available
                      ? "请选择一个已连接的模型。"
                      : !canvasModel.thinkingLevels.includes(
                            canvasDraft.config.thinking,
                          )
                        ? "请选择该模型支持的思考深度。"
                        : "";
  const selected =
    workspace?.nodes.find((node) => node.id === selectedId) ??
    workspace?.nodes[0];
  const parent =
    selected && workspace?.nodes.find((node) => node.id === selected.parentId);
  const canBranch = canBranchFrom(selected);
  const canRetry =
    selected?.status === "failed" || selected?.status === "cancelled";
  const retryDisabledReason = !online
    ? "连接已断开，恢复连接后可原地重试。"
    : directoryDirty || directoryBusy
      ? "请先完成工作目录设置。"
      : changingApproval
        ? "正在保存审批设置，请稍候。"
        : submitting
          ? "当前操作正在提交，请稍候。"
          : "";
  const selectedRetryBusy =
    retryingId === selected?.id ||
    selected?.retryRestore?.status === "restoring";
  const selectedRetryDisabledReason =
    selected?.retryRestore?.status === "restoring"
      ? "正在恢复本轮修改的文件，请稍候。"
      : retryDisabledReason;
  const selectedPreparedCheckpoint =
    selectedCompression &&
    workspace &&
    selected &&
    selectedCompression.workspaceId === workspace.id &&
    selectedCompression.parentId === selected.id &&
    selectedCompression.revision === (selected.revision ?? 0)
      ? preparedCheckpoints(selected).find(
          (checkpoint) => checkpoint.id === selectedCompression.checkpointId,
        )
      : undefined;
  const selectedContextCheckpointId =
    selectedPreparedCheckpoint &&
    workspace &&
    selected &&
    selected.status === "completed" &&
    checkpointMatchesPath(
      selectedPreparedCheckpoint,
      workspace.nodes,
      selected.id,
    )
      ? selectedPreparedCheckpoint.id
      : undefined;
  const selectedRawContext =
    !!selected &&
    !selectedContextCheckpointId &&
    preparedCheckpoints(selected).length > 0;
  const draftKey = `${workspace?.id}:${selected?.id}:${selectedContextCheckpointId ?? "path"}`;
  // Keep text attached to the card when its first compression point appears.
  // Only renew the idempotency key if that card's submission mode changes.
  useEffect(() => {
    const contextMode = selectedRawContext ? ("raw" as const) : undefined;
    setDrafts((current) => {
      const existing = current[draftKey];
      if (!existing || existing.contextMode === contextMode) return current;
      return {
        ...current,
        [draftKey]: {
          ...existing,
          contextMode,
          requestId: crypto.randomUUID(),
        },
      };
    });
  }, [draftKey, selectedRawContext]);
  const draft = drafts[draftKey]?.text ?? "";
  const draftFiles = drafts[draftKey]?.files ?? EMPTY_ATTACHMENT_FILES;
  const draftReferenceIds = drafts[draftKey]?.referenceNodeIds ?? [];
  const referenceCandidates =
    workspace?.nodes.filter(
      (node) => node.status === "completed" && !node.contextStale,
    ) ?? [];
  const composer = useCollapsibleComposer(
    `${draftKey}:${selected?.revision ?? 0}`,
    Boolean(canBranch),
    inputRef,
  );
  const model = models.find((item) => item.id === config.model);
  const continueDisabledReason =
    selectedRetryDisabledReason ||
    (!canBranch
      ? "当前节点暂时不能继续，请先完成文件恢复或更新上下文。"
      : "") ||
    (!model?.available ? "请选择一个已连接的模型。" : "");
  const selectedModel = models.find(
    (item) => item.id === selected?.config.model,
  );
  const safetyModel = models.find(
    (item) => item.id === workspace?.safetyModel && !item.demo,
  );
  const defaultModel = models.find((item) => item.available && item.default);
  const defaultModelId = defaultModel?.id;
  const defaultThinking = defaultModel?.thinkingLevels.includes(
    selected?.config.thinking ?? DEFAULT_CONFIG.thinking,
  )
    ? (selected?.config.thinking ?? DEFAULT_CONFIG.thinking)
    : defaultModel?.thinkingLevels.includes("medium")
      ? "medium"
      : defaultModel?.thinkingLevels[0];
  const path =
    workspace && selected ? ancestorPath(workspace.nodes, selected.id) : [];
  const contextScope = `${workspace?.id}:${selected?.id}:${selected?.revision ?? 0}`;
  const currentContextScope = useRef(contextScope);
  currentContextScope.current = contextScope;
  const staleAncestor = path.slice(0, -1).find((node) => node.contextStale);
  const activeCount =
    state?.workspaces
      .flatMap((item) => item.nodes)
      .filter((node) => node.status === "running" || node.status === "queued")
      .length ?? 0;
  const branchCount =
    workspace?.nodes.filter(
      (node) =>
        node.parentId &&
        !workspace.nodes.some((child) => child.parentId === node.id),
    ).length ?? 0;
  const pendingApprovals =
    state?.workspaces.flatMap((item) =>
      item.nodes.flatMap((node) =>
        (node.toolCalls ?? [])
          .filter((call) => call.status === "awaiting_approval")
          .map((call) => ({ workspace: item, node, call })),
      ),
    ) ?? [];
  const selectedPendingApproval = selected?.toolCalls?.some(
    (call) => call.status === "awaiting_approval",
  );
  const selectedSafetyReview = selected?.toolCalls?.some(
    (call) => call.status === "reviewing",
  );

  useEffect(() => {
    if (!selected) return;
    if (
      configSelection.current.nodeId !== selected.id ||
      configSelection.current.revision !== (selected.revision ?? 0)
    ) {
      configSelection.current = {
        nodeId: selected.id,
        revision: selected.revision ?? 0,
        resolved: selected.status !== "root",
      };
      setConfig({ ...selected.config });
      detailRef.current?.scrollTo({ top: 0 });
      savePreference("node", selected.id);
    }
    if (
      !configSelection.current.resolved &&
      defaultModelId &&
      defaultThinking
    ) {
      configSelection.current.resolved = true;
      setConfig({ model: defaultModelId, thinking: defaultThinking });
    }
  }, [selected?.id, selected?.revision, defaultModelId, defaultThinking]);
  useEffect(() => {
    if (workspace) savePreference("workspace", workspace.id);
    setSafetyModelRequired(false);
    setNodeAction(null);
  }, [workspace?.id]);
  useEffect(() => {
    setDirectoryDirty(false);
  }, [workspace?.id, selected?.id]);
  useEffect(() => {
    if (
      state &&
      workspaceToDelete &&
      !state.workspaces.some((item) => item.id === workspaceToDelete.id)
    )
      setWorkspaceToDelete(null);
  }, [state, workspaceToDelete]);
  useEffect(() => {
    if (
      !approvalFocus ||
      selected?.id !== approvalFocus.nodeId ||
      tab !== "conversation"
    )
      return;
    const frame = requestAnimationFrame(() => {
      const container = detailRef.current;
      const call = container?.querySelector<HTMLElement>(
        `[data-tool-call-id="${CSS.escape(approvalFocus.toolId)}"]`,
      );
      if (!container || !call) return;
      const activity = call.closest<HTMLDetailsElement>(
        ".tool-activity-disclosure",
      );
      if (activity) activity.open = true;
      const details = call.querySelector("details");
      if (details) details.open = true;
      // scrollIntoView also scrolls overflow:hidden ancestors, which can shift
      // the entire desktop workbench beyond its visible, unscrollable bounds.
      container.scrollTo({
        top:
          container.scrollTop +
          call.getBoundingClientRect().top -
          container.getBoundingClientRect().top -
          container.clientTop,
      });
      // The narrow layout stacks the inspector below the canvas and uses page
      // scrolling, so reveal the panel after positioning its own content.
      if (window.matchMedia("(max-width: 650px)").matches) {
        container.scrollIntoView({ block: "nearest" });
      }
      setApprovalFocus(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [approvalFocus, selected?.id, tab]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (modal === "directory" || nodeAction || workspaceToDelete) return;
      if (event.key === "Escape") {
        setModal(null);
        setSearchOpen(false);
        setExportOpen(false);
        if (!modal && window.innerWidth <= 1000) closeSidebar();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
        requestAnimationFrame(() => searchRef.current?.focus());
      }
      if (
        event.key.toLowerCase() === "b" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.isComposing &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement) &&
        !(event.target instanceof HTMLSelectElement) &&
        !(
          event.target instanceof HTMLElement && event.target.isContentEditable
        ) &&
        !modal
      )
        composer.expand();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [modal, closeSidebar, nodeAction, workspaceToDelete, composer.expand]);
  useEffect(
    () =>
      onDesktopAction((action) => {
        if (!state || modal || nodeAction || workspaceToDelete) return;
        setExportOpen(false);
        if (action === "new-workspace") {
          setSearchOpen(false);
          setModal("new");
        } else {
          setSearchOpen(true);
          requestAnimationFrame(() => searchRef.current?.focus());
        }
      }),
    [state, modal, nodeAction, workspaceToDelete],
  );

  const select = useCallback((id: string) => {
    setSelectedId(id);
    setSelectedCompression(null);
    setTab("conversation");
  }, []);
  const showCompression = useCallback(
    (parentId: string, checkpointId: string) => {
      const source = workspace?.nodes.find((node) => node.id === parentId);
      if (!workspace || !source) return;
      setSelectedId(parentId);
      setSelectedCompression({
        workspaceId: workspace.id,
        parentId,
        revision: source.revision ?? 0,
        checkpointId,
      });
      setTab("context");
    },
    [workspace],
  );
  const locateCompression = (parentId: string, checkpointId: string) => {
    showCompression(parentId, checkpointId);
    setFocus((current) => ({
      id: compressionNodeId(parentId, checkpointId),
      version: current.version + 1,
    }));
  };
  const branch = useCallback(
    (id: string, contextCheckpointId?: string) => {
      if (!workspace || submissionLock.current) return;
      const source = workspace.nodes.find((node) => node.id === id);
      if (!source || !canBranchFrom(source)) return;
      const checkpoint = contextCheckpointId
        ? preparedCheckpoints(source).find(
            (item) => item.id === contextCheckpointId,
          )
        : undefined;
      if (
        contextCheckpointId &&
        (!checkpoint || !checkpointMatchesPath(checkpoint, workspace.nodes, id))
      )
        return;
      const contextMode =
        !contextCheckpointId && preparedCheckpoints(source).length
          ? ("raw" as const)
          : undefined;
      const originKey = `${id}:${contextCheckpointId ?? "path"}`;
      const key = `${workspace.id}:${originKey}`;
      const initial =
        id === selected?.id
          ? config
          : source.status === "root"
            ? {
                model: defaultModelId ?? DEFAULT_CONFIG.model,
                thinking: defaultThinking ?? DEFAULT_CONFIG.thinking,
              }
            : source.config;
      const initialModel = models.find((item) => item.id === initial.model);
      const siblings = workspace.nodes.filter((node) => node.parentId === id);
      const colors = ["sage", "violet", "blue", "amber"] as const;
      setCanvasDrafts((current) => {
        const existing = current[key];
        return {
          ...current,
          [key]: {
            id: existing?.id ?? `draft-${crypto.randomUUID()}`,
            workspaceId: workspace.id,
            parentId: id,
            contextCheckpointId,
            contextMode,
            parentRevision: source.revision ?? 0,
            parentTitle: source.prompt,
            parentPosition: { ...source.position },
            color:
              source.status === "root"
                ? colors[siblings.length % colors.length]
                : source.color,
            text: existing?.text ?? "",
            files: existing?.files ?? [],
            referenceNodeIds: existing?.referenceNodeIds ?? [],
            config: existing?.config ?? {
              ...initial,
              thinking: initialModel?.thinkingLevels.includes(initial.thinking)
                ? initial.thinking
                : (initialModel?.thinkingLevels[0] ?? initial.thinking),
            },
            requestId:
              existing &&
              existing.parentRevision === (source.revision ?? 0) &&
              existing.contextMode === contextMode
                ? existing.requestId
                : crypto.randomUUID(),
            error: "",
            focusVersion: (existing?.focusVersion ?? 0) + 1,
          },
        };
      });
      setCanvasDraftParents((current) => ({
        ...current,
        [workspace.id]: originKey,
      }));
      if (contextCheckpointId) showCompression(id, contextCheckpointId);
      else select(id);
    },
    [
      workspace,
      selected?.id,
      config,
      defaultModelId,
      defaultThinking,
      models,
      select,
      showCompression,
    ],
  );
  const changeCanvasDraft = (
    change: Partial<
      Pick<CanvasBranchDraft, "text" | "config" | "files" | "referenceNodeIds">
    >,
  ) => {
    if (!canvasDraft || canvasSubmittingId === canvasDraft.id) return;
    setCanvasDrafts((current) => ({
      ...current,
      [canvasDraftKey]: {
        ...current[canvasDraftKey],
        ...change,
        requestId: crypto.randomUUID(),
        error: "",
      },
    }));
  };
  const cancelCanvasDraft = () => {
    if (!canvasDraft || canvasSubmittingId === canvasDraft.id) return;
    setCanvasDrafts((current) => {
      const next = { ...current };
      delete next[canvasDraftKey];
      return next;
    });
    if (canvasParent) {
      select(canvasParent.id);
      setFocus((current) => ({
        id: canvasParent.id,
        version: current.version + 1,
      }));
    }
  };
  const sendCanvasDraft = async () => {
    if (
      !canvasDraft ||
      (!canvasDraft.text.trim() && !canvasDraft.files.length) ||
      canvasDraftBlockedReason ||
      submissionLock.current
    )
      return;
    const submitted = canvasDraft;
    const key = canvasDraftKey;
    submissionLock.current = true;
    setSubmitting(true);
    setCanvasSubmittingId(submitted.id);
    try {
      const attachments = await encodeAttachments(submitted.files);
      const result = await api<MutationResult>(
        `/workspaces/${submitted.workspaceId}/nodes`,
        {
          parentId: submitted.parentId,
          prompt: submitted.text,
          attachments,
          referenceNodeIds: submitted.referenceNodeIds,
          config: submitted.config,
          requestId: submitted.requestId,
          contextCheckpointId: submitted.contextCheckpointId,
          contextMode: submitted.contextMode,
        },
      );
      apply(result.state);
      setCanvasDrafts((current) => {
        if (current[key]?.requestId !== submitted.requestId) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      if (currentWorkspaceId.current === submitted.workspaceId) {
        select(result.nodeId!);
        setFocus((current) => ({
          id: result.nodeId!,
          version: current.version + 1,
        }));
      }
    } catch (reason) {
      setCanvasDrafts((current) =>
        current[key]?.requestId === submitted.requestId
          ? {
              ...current,
              [key]: {
                ...current[key],
                error:
                  reason instanceof Error
                    ? reason.message
                    : "生成失败，请重试。",
              },
            }
          : current,
      );
    } finally {
      submissionLock.current = false;
      setSubmitting(false);
      setCanvasSubmittingId(null);
    }
  };
  const locate = (id: string) => {
    select(id);
    setFocus((current) => ({ id, version: current.version + 1 }));
    setSearchOpen(false);
    setSearch("");
  };
  const openNodeAction = (mode: NodeActionTarget["mode"], id: string) => {
    const node = workspace?.nodes.find((item) => item.id === id);
    if (!workspace || !node || node.status === "root") return;
    select(id);
    setModal(null);
    setNodeAction({
      mode,
      workspaceId: workspace.id,
      node: structuredClone(node),
      subtreeIds: subtreeIds(workspace.nodes, id),
    });
  };
  const setDraft = (text: string) =>
    setDrafts((current) => ({
      ...current,
      [draftKey]: {
        ...current[draftKey],
        text,
        requestId: crypto.randomUUID(),
        contextMode: selectedRawContext ? "raw" : undefined,
      },
    }));

  const changeConfig = (next: RunConfig) => {
    configSelection.current.resolved = true;
    setConfig(next);
    setDrafts((current) => ({
      ...current,
      [draftKey]: {
        ...current[draftKey],
        text: current[draftKey]?.text ?? "",
        requestId: crypto.randomUUID(),
        contextMode: selectedRawContext ? "raw" : undefined,
      },
    }));
  };

  const changeDraftFiles = (files: File[]) => {
    setDrafts((current) => ({
      ...current,
      [draftKey]: {
        ...current[draftKey],
        text: current[draftKey]?.text ?? "",
        files,
        requestId: crypto.randomUUID(),
        contextMode: selectedRawContext ? "raw" : undefined,
      },
    }));
  };

  const changeDraftReferences = (referenceNodeIds: string[]) => {
    setDrafts((current) => ({
      ...current,
      [draftKey]: {
        ...current[draftKey],
        text: current[draftKey]?.text ?? "",
        referenceNodeIds,
        requestId: crypto.randomUUID(),
        contextMode: selectedRawContext ? "raw" : undefined,
      },
    }));
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (
      !workspace ||
      !selected ||
      (!draft.trim() && !draftFiles.length) ||
      !canBranch ||
      submitting ||
      submissionLock.current ||
      !online ||
      !model?.available ||
      directoryDirty ||
      directoryBusy ||
      changingApproval
    )
      return;
    const key = draftKey;
    const requestId = drafts[key]?.requestId ?? crypto.randomUUID();
    submissionLock.current = true;
    setSubmitting(true);
    try {
      const attachments = await encodeAttachments(draftFiles);
      const result = await api<MutationResult>(
        `/workspaces/${workspace.id}/nodes`,
        {
          parentId: selected.id,
          prompt: draft,
          attachments,
          referenceNodeIds: draftReferenceIds,
          config,
          requestId,
          ...(selectedContextCheckpointId
            ? { contextCheckpointId: selectedContextCheckpointId }
            : selectedRawContext
              ? { contextMode: "raw" }
              : {}),
        },
      );
      apply(result.state);
      setDrafts((current) =>
        current[key]?.requestId === requestId
          ? {
              ...current,
              [key]: { text: "", files: [], requestId: crypto.randomUUID() },
            }
          : current,
      );
      if (currentWorkspaceId.current === workspace.id) {
        select(result.nodeId!);
        setFocus((current) => ({
          id: result.nodeId!,
          version: current.version + 1,
        }));
      }
    } catch (reason) {
      fail(reason);
    } finally {
      submissionLock.current = false;
      setSubmitting(false);
    }
  };

  const continueInNewNode = async () => {
    if (
      !workspace ||
      !selected ||
      !canRetry ||
      continueDisabledReason ||
      submissionLock.current
    )
      return;
    const key = JSON.stringify([
      workspace.id,
      selected.id,
      selected.revision ?? 0,
      config.model,
      config.thinking,
    ]);
    const requestId =
      continuationRequestIds.current.get(key) ?? crypto.randomUUID();
    // Reuse the same request after an uncertain network response.
    continuationRequestIds.current.set(key, requestId);
    submissionLock.current = true;
    setSubmitting(true);
    setContinuingId(selected.id);
    setError("");
    try {
      const result = await api<MutationResult>(
        `/workspaces/${workspace.id}/nodes`,
        {
          parentId: selected.id,
          prompt: CONTINUE_PROMPT,
          config: { ...config },
          requestId,
        },
      );
      apply(result.state);
      continuationRequestIds.current.delete(key);
      if (currentWorkspaceId.current === workspace.id) {
        select(result.nodeId!);
        setFocus((current) => ({
          id: result.nodeId!,
          version: current.version + 1,
        }));
      }
    } catch (reason) {
      fail(reason);
    } finally {
      submissionLock.current = false;
      setSubmitting(false);
      setContinuingId(null);
    }
  };

  const retryInPlace = async (nodeId: string) => {
    if (!workspace || submissionLock.current || retryDisabledReason) return;
    const node = workspace.nodes.find((item) => item.id === nodeId);
    if (
      !node ||
      !["failed", "cancelled"].includes(node.status) ||
      node.retryRestore?.status === "restoring"
    )
      return;
    const expectedRevision = node.revision ?? 0;
    const key = `${workspace.id}:${node.id}:${expectedRevision}`;
    const requestId =
      node.retryRestore?.requestId ??
      retryRequestIds.current.get(key) ??
      crypto.randomUUID();
    // Retain the same id if a response is lost after the server accepts the retry.
    retryRequestIds.current.set(key, requestId);
    submissionLock.current = true;
    setSubmitting(true);
    setRetryingId(node.id);
    setError("");
    select(node.id);
    try {
      const result = await api<MutationResult>(
        `/workspaces/${workspace.id}/nodes/${node.id}/retry`,
        { requestId, expectedRevision },
      );
      apply(result.state);
      retryRequestIds.current.delete(key);
      if (currentWorkspaceId.current === workspace.id) {
        select(node.id);
        setFocus((current) => ({ id: node.id, version: current.version + 1 }));
      }
    } catch (reason) {
      fail(reason);
    } finally {
      submissionLock.current = false;
      setSubmitting(false);
      setRetryingId(null);
    }
  };

  const retryAsBranch = () => {
    if (!parent || !selected || !workspace) return;
    const checkpointId = selected.requestedContextCheckpointId;
    if (
      checkpointId &&
      !preparedCheckpoints(parent).some(
        (checkpoint) =>
          checkpoint.id === checkpointId &&
          checkpointMatchesPath(checkpoint, workspace.nodes, parent.id),
      )
    ) {
      fail(new Error("原分支使用的摘要已失效，请重新选择上下文来源。"));
      return;
    }
    const origin = checkpointId ?? "path";
    const key = `${workspace.id}:${parent.id}:${origin}`;
    setDrafts((current) => ({
      ...current,
      [key]: {
        text: selected.prompt,
        referenceNodeIds: (selected.contextReferences ?? []).map(
          (reference) => reference.nodeId,
        ),
        requestId: crypto.randomUUID(),
        contextMode:
          !checkpointId && preparedCheckpoints(parent).length
            ? "raw"
            : undefined,
      },
    }));
    if (checkpointId) showCompression(parent.id, checkpointId);
    else select(parent.id);
    requestAnimationFrame(() => {
      configSelection.current.resolved = true;
      setConfig({ ...selected.config });
      composer.expand();
    });
  };

  const cancel = async () => {
    if (!workspace || !selected) return;
    try {
      apply(
        await api<AppState>(
          `/workspaces/${workspace.id}/nodes/${selected.id}/cancel`,
          {},
        ),
      );
    } catch (reason) {
      fail(reason);
    }
  };

  const changeApprovalMode = async (approvalMode: ApprovalMode) => {
    if (!workspace || changingApproval) return;
    if (approvalMode === "auto" && !safetyModel?.available) {
      setSafetyModelRequired(true);
      return;
    }
    setSafetyModelRequired(false);
    if (approvalMode === (workspace.approvalMode ?? "ask")) return;
    setChangingApproval(true);
    try {
      apply(
        await api<AppState>(
          `/workspaces/${workspace.id}`,
          { approvalMode },
          "PATCH",
        ),
      );
    } catch (reason) {
      fail(reason);
    } finally {
      setChangingApproval(false);
    }
  };

  const changeSafetyModel = async (nextModel: string) => {
    if (!workspace || changingApproval) return;
    setChangingApproval(true);
    try {
      apply(
        await api<AppState>(
          `/workspaces/${workspace.id}`,
          { safetyModel: nextModel || null },
          "PATCH",
        ),
      );
      setSafetyModelRequired(false);
    } catch (reason) {
      fail(reason);
    } finally {
      setChangingApproval(false);
    }
  };

  const changeAutoCompact = async (autoCompact: boolean) => {
    if (!workspace || autoCompactLocks.current.has(workspace.id)) return;
    const id = workspace.id;
    autoCompactLocks.current.add(id);
    setChangingAutoCompact((current) => ({ ...current, [id]: true }));
    try {
      apply(await api<AppState>(`/workspaces/${id}`, { autoCompact }, "PATCH"));
    } catch (reason) {
      fail(reason);
    } finally {
      autoCompactLocks.current.delete(id);
      setChangingAutoCompact((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };

  const generateContextSummary = async () => {
    if (
      !workspace ||
      !selected ||
      selected.status !== "completed" ||
      selected.contextStale ||
      !online ||
      !model?.available ||
      model.demo ||
      compactionLocks.current.has(contextScope) ||
      selected.preparedContextState?.status === "compacting"
    )
      return;
    const scope = contextScope;
    const requestKey = `${scope}:${config.model}:${config.thinking}`;
    const previousStatus = selected.preparedContextState?.status;
    if (previousStatus === "failed" || previousStatus === "cancelled")
      compactionRequestIds.current.delete(requestKey);
    const requestId =
      compactionRequestIds.current.get(requestKey) ?? crypto.randomUUID();
    compactionRequestIds.current.set(requestKey, requestId);
    compactionLocks.current.add(scope);
    setCompactingPaths((current) => ({ ...current, [scope]: true }));
    try {
      const result = await api<MutationResult & { checkpointId?: string }>(
        `/workspaces/${workspace.id}/nodes/${selected.id}/compact`,
        { config, expectedRevision: selected.revision ?? 0, requestId },
      );
      apply(result.state);
      compactionRequestIds.current.delete(requestKey);
      if (result.checkpointId && currentContextScope.current === scope) {
        locateCompression(selected.id, result.checkpointId);
      }
    } catch (reason) {
      fail(reason);
    } finally {
      compactionLocks.current.delete(scope);
      setCompactingPaths((current) => {
        const next = { ...current };
        delete next[scope];
        return next;
      });
    }
  };

  const cancelContextSummary = async () => {
    if (!workspace || !selected || !online) return;
    try {
      apply(
        await api<AppState>(
          `/workspaces/${workspace.id}/nodes/${selected.id}/cancel`,
          {},
        ),
      );
    } catch (reason) {
      fail(reason);
    }
  };

  const decideApproval = async (
    toolId: string,
    decision: ToolApprovalDecision,
  ) => {
    if (!workspace || !selected) return;
    apply(
      await api<AppState>(
        `/workspaces/${workspace.id}/nodes/${selected.id}/approvals/${encodeURIComponent(toolId)}`,
        { decision, expectedRevision: selected.revision ?? 0 },
      ),
    );
  };

  const updatePositions = useCallback(
    async (positions: Record<string, { x: number; y: number }>) => {
      if (!workspace) return;
      setState(
        (current) =>
          current && {
            ...current,
            workspaces: current.workspaces.map((item) =>
              item.id === workspace.id
                ? {
                    ...item,
                    nodes: item.nodes.map((node) =>
                      positions[node.id]
                        ? { ...node, position: positions[node.id] }
                        : node,
                    ),
                  }
                : item,
            ),
          },
      );
      try {
        apply(
          await api<AppState>(
            `/workspaces/${workspace.id}/layout`,
            { positions },
            "PATCH",
          ),
        );
      } catch (reason) {
        fail(reason);
      }
    },
    [workspace?.id, apply, fail],
  );

  const copyAnswer = async () => {
    try {
      await navigator.clipboard.writeText(
        responseText(selected?.response ?? "", selected?.status === "running"),
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("无法访问剪贴板，请直接选择文本复制。");
    }
  };

  const workspaceModal = modal && modal !== "directory" && (
    <div className="modal-backdrop" onClick={() => setModal(null)}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={
          modal === "new"
            ? "新建探索"
            : modal === "settings"
              ? "模型连接"
              : "使用指南"
        }
        onClick={(event) => event.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          aria-label="关闭弹窗"
          onClick={() => setModal(null)}
        >
          <X size={19} />
        </button>
        {modal === "new" ? (
          <NewWorkspace
            onCreated={(result) => {
              apply(result.state);
              setWorkspaceId(result.workspaceId!);
              setSelectedId(
                result.state.workspaces
                  .find((item) => item.id === result.workspaceId)
                  ?.nodes.find((node) => node.parentId === null)?.id ?? null,
              );
              setFocus({ id: null, version: 0 });
              setModal(null);
              if (window.innerWidth <= 1000) closeSidebar();
            }}
          />
        ) : modal === "settings" ? (
          <Settings models={models} webCapabilities={webCapabilities} />
        ) : (
          <Help />
        )}
      </section>
    </div>
  );

  if (state && state.workspaces.length === 0)
    return (
      <div className="workspace-empty-screen">
        <Logo />
        <h1>还没有探索空间</h1>
        <p>从一个问题开始，创建新的探索。</p>
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <button className="primary-button" onClick={() => setModal("new")}>
          <Plus size={16} />
          新建探索
        </button>
        {workspaceModal}
      </div>
    );

  if (!workspace || !selected || !state)
    return (
      <div className="loading-screen">
        <Logo />
        <span>{error || "正在打开你的探索空间…"}</span>
        {error ? (
          <button onClick={() => location.reload()}>重新连接</button>
        ) : (
          <LoaderCircle className="spin" size={20} />
        )}
      </div>
    );
  const results = workspace.nodes
    .filter((node) =>
      `${node.prompt} ${node.response}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .slice(0, 30);
  const currentIndex = workspace.nodes.findIndex(
    (node) => node.id === selected.id,
  );
  const contextNodes = canBranch ? path : path.slice(0, -1);
  const contextEstimate = estimatePathContextTokens(contextNodes);
  const selectedContextUsage = contextUsageForNode(
    selected,
    estimatePathContextTokens(path),
    selected.status === "root"
      ? model?.contextWindow
      : selectedModel?.contextWindow,
    path.some((node) => Boolean(node.contextStale)),
  );

  return (
    <div className={`workbench ${sidebar ? "" : "sidebar-hidden"}`}>
      <button
        className="sidebar-scrim"
        aria-label="关闭导航"
        aria-hidden={!sidebar}
        tabIndex={-1}
        disabled={!sidebar}
        onClick={closeSidebar}
      />
      <aside
        id="workspace-sidebar"
        className="sidebar"
        inert={!sidebar}
        aria-hidden={!sidebar}
      >
        <div className="sidebar-brand">
          <BrandHint available={sidebar} onOpenHelp={() => setModal("help")}>
            <Logo />
          </BrandHint>
          <button
            className="icon-button"
            aria-label="收起侧栏"
            onClick={closeSidebar}
          >
            <PanelLeftClose size={16} />
          </button>
        </div>
        <div className="workspace-switch">
          <span className="workspace-avatar">S</span>
          <span>
            我的工作台<small>个人空间</small>
          </span>
          <span className="local-badge">LOCAL</span>
        </div>
        <button className="new-exploration" onClick={() => setModal("new")}>
          <Plus size={16} />
          新建探索<span>＋</span>
        </button>
        <div className="sidebar-section-label">
          <span>探索空间</span>
          <span>{state.workspaces.length}</span>
        </div>
        <nav className="workspace-list" aria-label="探索空间">
          {state.workspaces.map((item) => (
            <div className="workspace-row" key={item.id}>
              <button
                className={`workspace-item ${item.id === workspace.id ? "selected" : ""}`}
                onClick={() => {
                  setWorkspaceId(item.id);
                  setSelectedId(item.nodes[0].id);
                  setFocus({ id: null, version: 0 });
                  if (window.innerWidth <= 1000) closeSidebar();
                }}
              >
                <Network size={16} />
                <span>
                  {item.title}
                  <small>
                    {item.nodes.length} 个节点{" "}
                    {item.nodes.some((node) =>
                      node.toolCalls?.some(
                        (call) => call.status === "awaiting_approval",
                      ),
                    )
                      ? "· 等待批准"
                      : item.nodes.some((node) =>
                            node.toolCalls?.some(
                              (call) => call.status === "reviewing",
                            ),
                          )
                        ? "· 安全审核中"
                        : item.workingDirectory
                          ? "· 本地项目"
                          : item.example
                            ? "· 示例探索"
                            : "· 临时目录"}
                  </small>
                </span>
                {item.nodes.some((node) => node.status === "running") && (
                  <span className="tiny-green-dot pulse" />
                )}
              </button>
              <button
                type="button"
                className="workspace-delete-button"
                aria-label={`删除探索「${item.title}」`}
                title={`删除探索「${item.title}」`}
                onClick={() => {
                  setSearchOpen(false);
                  setExportOpen(false);
                  setWorkspaceToDelete(structuredClone(item));
                }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="sidebar-bottom">
          <button onClick={() => setModal("settings")}>
            <Settings2 size={16} />
            模型连接
            <span className="connection-number">
              {
                new Set(
                  models
                    .filter((item) => item.available)
                    .map((item) => item.provider),
                ).size
              }
            </span>
          </button>
          <button onClick={() => setModal("help")}>
            <CircleHelp size={16} />
            使用指南
            <ArrowUpRight size={13} />
          </button>
        </div>
        <div className="powered">
          <span className="pi-mark">π</span> Powered by Pi <span>v0.1</span>
        </div>
      </aside>

      <main className="main-workspace">
        <header className="topbar">
          <div className="topbar-navigation">
            <div className="breadcrumbs">
              <button
                ref={sidebarToggleRef}
                className="icon-button"
                aria-label={sidebar ? "收起侧栏" : "展开侧栏"}
                aria-expanded={sidebar}
                aria-controls="workspace-sidebar"
                onClick={() => setSidebar(!sidebar)}
              >
                {sidebar ? (
                  <PanelLeftClose size={17} />
                ) : (
                  <PanelLeftOpen size={17} />
                )}
              </button>
              <Layers size={15} />
              <span>探索空间</span>
              <ChevronRight size={13} />
              <strong>{workspace.title}</strong>
              {workspace.example && <span className="example-badge">示例</span>}
            </div>
            <div className="topbar-actions">
              <label
                className="theme-control"
                title="界面主题：跟随系统会随系统外观自动切换"
              >
                {theme === "system" ? (
                  <Monitor size={14} aria-hidden="true" />
                ) : theme === "dark" ? (
                  <Moon size={14} aria-hidden="true" />
                ) : (
                  <Sun size={14} aria-hidden="true" />
                )}
                <select
                  aria-label="界面主题"
                  value={theme}
                  onChange={(event) =>
                    changeTheme(event.target.value as ThemePreference)
                  }
                >
                  <option value="system">跟随系统</option>
                  <option value="light">浅色</option>
                  <option value="dark">深色</option>
                </select>
              </label>
              <button
                className="heading-toggle"
                aria-expanded={!headingCollapsed}
                aria-controls="exploration-heading"
                aria-label={headingCollapsed ? "展开主题" : "收起主题"}
                title={
                  headingCollapsed ? "展开主题" : "收起主题，留出更多阅读空间"
                }
                onClick={() => {
                  const collapsed = !headingCollapsed;
                  setHeadingCollapsed(collapsed);
                  savePreference("heading-collapsed", String(collapsed));
                }}
              >
                {headingCollapsed ? (
                  <ChevronDown size={15} />
                ) : (
                  <ChevronUp size={15} />
                )}
                <span>{headingCollapsed ? "展开主题" : "收起主题"}</span>
              </button>
              <span
                className={`sync-state ${online && !state.storageError ? "" : "offline"}`}
              >
                <span />
                {state.storageError
                  ? "保存异常"
                  : online
                    ? "已连接 · 自动保存"
                    : "正在重新连接"}
              </span>
              <button
                className="icon-button"
                title="搜索节点（⌘K）"
                aria-label="搜索节点"
                onClick={() => {
                  setSearchOpen(!searchOpen);
                  requestAnimationFrame(() => searchRef.current?.focus());
                }}
              >
                <Search size={17} />
              </button>
              <div className="export-wrap">
                <button
                  className="export-button"
                  onClick={() => setExportOpen(!exportOpen)}
                >
                  <ArrowDownToLine size={14} />
                  导出
                  <ChevronDown size={12} />
                </button>
                {exportOpen && (
                  <div className="dropdown export-menu">
                    <a
                      href={`/api/workspaces/${workspace.id}/export`}
                      download
                      onClick={() => setExportOpen(false)}
                    >
                      <FileJson size={15} />
                      完整探索 · JSON
                    </a>
                    <a
                      href={`/api/workspaces/${workspace.id}/export?format=markdown&node=${selected.id}`}
                      download
                      onClick={() => setExportOpen(false)}
                    >
                      <FileText size={15} />
                      当前路径 · Markdown
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>
        </header>
        <div
          id="exploration-heading"
          className="exploration-heading"
          hidden={headingCollapsed}
        >
          <div className="exploration-heading-summary">
            <div className="exploration-heading-copy">
              <div className="eyebrow">A SPACE FOR POSSIBILITY</div>
              <h1>
                {workspace.title}
                <span className="title-dot">.</span>
              </h1>
              <p>
                {workspace.description ||
                  "从一个问题开始，把每一种可能留在画布上。"}
              </p>
            </div>
            <div className="exploration-meta">
              <div>
                <Network size={15} />
                <b>{workspace.nodes.length}</b>
                <span>节点</span>
              </div>
              <div>
                <GitBranch size={15} />
                <b>{branchCount}</b>
                <span>分支</span>
              </div>
              {activeCount > 0 && (
                <div className="active-stat">
                  <LoaderCircle size={14} className="spin" />
                  <b>{activeCount}</b>
                  <span>运行中</span>
                </div>
              )}
            </div>
          </div>
          <WorkbenchControls
            models={models}
            approvalMode={workspace.approvalMode ?? "ask"}
            safetyModel={workspace.safetyModel ?? ""}
            onApprovalModeChange={(mode) => void changeApprovalMode(mode)}
            onSafetyModelChange={(model) => void changeSafetyModel(model)}
            disabled={!online || submitting}
            approvalBusy={changingApproval}
            safetyModelRequired={safetyModelRequired}
          />
        </div>
        {pendingApprovals.length > 0 && (
          <div className="pending-approvals" aria-label="待审批操作">
            <span>
              <ShieldQuestion size={14} />
              {pendingApprovals.length} 项操作等待批准
            </span>
            <div>
              {pendingApprovals.map(({ workspace: item, node, call }) => (
                <button
                  type="button"
                  key={`${node.id}:${call.id}`}
                  title={`${item.title} · ${node.prompt}`}
                  onClick={() => {
                    setWorkspaceId(item.id);
                    locate(node.id);
                    setApprovalFocus((current) => ({
                      nodeId: node.id,
                      toolId: call.id,
                      version: (current?.version ?? 0) + 1,
                    }));
                  }}
                >
                  <span>
                    {item.id !== workspace.id ? `${item.title} · ` : ""}
                    {node.prompt}
                  </span>
                  <ArrowUpRight size={12} />
                </button>
              ))}
            </div>
          </div>
        )}
        <ResizableWorkspace>
          <section className="canvas-section" aria-label="非线性对话画布">
            <Graph
              key={workspace.id}
              workspace={workspace}
              selectedId={selected.id}
              models={models}
              rootModelId={config.model}
              colorMode={colorMode}
              onSelect={select}
              onShowContext={(id) => {
                select(id);
                setTab("context");
              }}
              onShowCompression={showCompression}
              selectedCompressionId={
                selectedPreparedCheckpoint
                  ? compressionNodeId(
                      selected.id,
                      selectedPreparedCheckpoint.id,
                    )
                  : undefined
              }
              onBranch={branch}
              branchDisabled={submitting}
              draft={canvasDraft}
              draftBusy={canvasSubmittingId === canvasDraft?.id}
              draftBlockedReason={canvasDraftBlockedReason}
              onDraftTextChange={(text) => changeCanvasDraft({ text })}
              onDraftConfigChange={(config) => changeCanvasDraft({ config })}
              onDraftFilesChange={(files) => changeCanvasDraft({ files })}
              onDraftReferencesChange={(referenceNodeIds) =>
                changeCanvasDraft({ referenceNodeIds })
              }
              onDraftSubmit={() => void sendCanvasDraft()}
              onDraftCancel={cancelCanvasDraft}
              onEdit={(id) => openNodeAction("edit", id)}
              onDelete={(id) => openNodeAction("delete", id)}
              nodeActionsDisabled={
                !online ||
                submitting ||
                changingApproval ||
                directoryBusy ||
                directoryDirty
              }
              onRetry={(id) => void retryInPlace(id)}
              retryingId={retryingId}
              retryDisabledReason={retryDisabledReason}
              onChooseDirectory={() => {
                const root = workspace.nodes.find(
                  (node) => node.status === "root",
                );
                if (!root) return;
                select(root.id);
                setModal("directory");
              }}
              directoryDisabled={
                !online || submitting || changingApproval || directoryBusy
              }
              onPositions={updatePositions}
              focusId={focus.id}
              focusVersion={focus.version}
            />
            {workspace.nodes.length === 1 && !canvasDraft && (
              <div className="empty-canvas-note">
                <GitBranch size={18} />
                <b>每一个好问题，都可以是新的起点。</b>
                <span>点击起点右侧的加号，写下第一个问题。</span>
              </div>
            )}
            <div className="canvas-footer">
              <span>
                <span className="legend-line" />
                当前上下文路径
              </span>
              <span>
                拖拽移动画布<span className="keyboard-hint">B</span>继续分支
              </span>
            </div>
          </section>

          <aside
            id="node-inspector"
            className="inspector"
            aria-label="节点详情"
          >
            <div className="inspector-header">
              <span className={`inspector-node-icon color-${selected.color}`}>
                {selected.status === "root" ? (
                  <Sparkles size={15} />
                ) : (
                  <GitBranch size={15} />
                )}
              </span>
              <strong>
                {selected.status === "root"
                  ? "探索起点"
                  : `对话 ${String(currentIndex).padStart(2, "0")}`}
              </strong>
              <span className={`detail-status ${selected.status}`}>
                {selectedPendingApproval ? (
                  <ShieldQuestion size={12} />
                ) : (
                  <StatusIcon status={selected.status} />
                )}
                {selectedPendingApproval
                  ? "等待批准"
                  : selectedSafetyReview
                    ? "安全审核中"
                    : statusLabels[selected.status]}
              </span>
            </div>
            <div className="inspector-tabs">
              <button
                className={tab === "conversation" ? "active" : ""}
                onClick={() => setTab("conversation")}
              >
                <BookOpen size={13} />
                对话详情
              </button>
              <button
                className={tab === "context" ? "active" : ""}
                onClick={() => setTab("context")}
              >
                <Layers size={13} />
                上下文路径<span>{contextNodes.length}</span>
              </button>
            </div>
            <div
              className="inspector-content"
              ref={detailRef}
              tabIndex={0}
              aria-label="对话输出与上下文"
              {...composer.readingHandlers}
            >
              <div hidden={tab !== "conversation"}>
                <div className="question-label">
                  <span className="user-dot">S</span>
                  {selected.status === "root" ? "探索主题" : "你的问题"}
                </div>
                <h2 className="node-question">{selected.prompt}</h2>
                {selected.contextStale && (
                  <div className="context-stale-notice" role="status">
                    上游指令已更新，下面保留的是原回答。请按上下文顺序重新生成，再继续创建分支。
                  </div>
                )}
                {selected.status === "root" ? (
                  <>
                    <RootDirectoryCard
                      key={workspace.id}
                      workspace={workspace}
                      dialogOpen={modal === "directory"}
                      onDialogClose={() => setModal(null)}
                      disabled={
                        !online ||
                        submitting ||
                        changingApproval ||
                        directoryBusy
                      }
                      onDirtyChange={setDirectoryDirty}
                      onSave={async (workingDirectory) => {
                        setDirectoryBusy(true);
                        try {
                          apply(
                            await api<AppState>(
                              `/workspaces/${workspace.id}`,
                              { workingDirectory },
                              "PATCH",
                            ),
                          );
                        } finally {
                          setDirectoryBusy(false);
                        }
                      }}
                    />
                    <Markdown
                      text={selected.response || "为这个主题提出第一个问题。"}
                    />
                    <div className="root-guide">
                      <Sparkles size={18} />
                      <b>让思考从这里生长</b>
                      <p>
                        每轮对话都会成为画布上的一个节点。你可以随时回来，从这里探索另一个方向。
                      </p>
                      <div>
                        <span>01</span>写下问题
                      </div>
                      <div>
                        <span>02</span>在输入框下方选择模型与思考强度
                      </div>
                      <div>
                        <span>03</span>沿着感兴趣的方向继续
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <CardReferenceList
                      references={selected.contextReferences ?? []}
                      nodes={workspace.nodes}
                      onLocate={locate}
                    />
                    <AttachmentList
                      attachments={selected.attachments ?? []}
                      workspaceId={workspace.id}
                      nodeId={selected.id}
                    />
                    <div className="answer-heading">
                      <span className="answer-logo">π</span>
                      <b>
                        {selectedModel?.name ??
                          selected.config.model.split("/").at(-1)}
                      </b>
                      <span
                        className="model-context-capacity"
                        title={
                          selectedModel?.contextWindow &&
                          selectedModel.contextWindow > 0
                            ? `上下文容量：${selectedModel.contextWindow.toLocaleString("zh-CN")} tokens`
                            : "上下文容量未知"
                        }
                      >
                        {formatContextWindow(selectedModel?.contextWindow)}
                      </span>
                      {selected.config.model.startsWith("demo/") && (
                        <span className="demo-badge">演示</span>
                      )}
                      <span className="answer-thinking">
                        <Zap size={11} />
                        {thinkingLabels[selected.config.thinking]}
                      </span>
                    </div>
                    {!!selected.toolCalls?.length && (
                      <ToolActivity
                        key={selected.id}
                        calls={selected.toolCalls}
                        workingDirectory={selected.execution?.workingDirectory}
                        onDecision={decideApproval}
                        batchApprovalAvailable={
                          webCapabilities?.toolBatchApproval === true
                        }
                      />
                    )}
                    <AssistantResponse
                      key={`${selected.id}:${selected.revision ?? 0}`}
                      response={selected.response}
                      thinking={selected.thinking}
                      status={selected.status}
                    />
                    {selected.status === "running" ||
                    selected.status === "queued" ? (
                      <GenerationIndicator
                        key={selected.id}
                        hasResponse={Boolean(selected.response)}
                        active={tab === "conversation"}
                        activityKey={getGenerationActivity(selected).key}
                        message={
                          selectedPendingApproval
                            ? "工具操作等待你的批准…"
                            : selectedSafetyReview
                              ? "安全模型正在审核工具操作…"
                              : selected.status === "queued"
                                ? "已进入队列，稍后开始…"
                                : undefined
                        }
                      />
                    ) : !selected.response && !selected.thinking?.text ? (
                      <div className="waiting-response">
                        这次运行没有生成回答。
                      </div>
                    ) : null}
                    {selected.error && (
                      <div className="inline-error">{selected.error}</div>
                    )}
                    {selected.retryRestore?.error &&
                      selected.retryRestore.error !== selected.error && (
                        <div className="inline-error" role="alert">
                          {selected.retryRestore.error}
                        </div>
                      )}
                    {selected.usage && (
                      <div className="usage">
                        累计用量 {selected.usage.total.toLocaleString()} tokens
                        {selected.usage.cost !== undefined
                          ? ` · $${selected.usage.cost.toFixed(4)}`
                          : ""}
                        {selected.finishedAt && selected.startedAt
                          ? ` · ${((selected.finishedAt - selected.startedAt) / 1000).toFixed(1)} 秒`
                          : ""}
                      </div>
                    )}
                    <div className="answer-actions">
                      {responseText(
                        selected.response,
                        selected.status === "running",
                      ).trim() && (
                        <button onClick={copyAnswer}>
                          {copied ? <Check size={13} /> : <Copy size={13} />}
                          {copied ? "已复制" : "复制"}
                        </button>
                      )}
                      {canRetry && canBranch && (
                        <button
                          type="button"
                          disabled={!!continueDisabledReason}
                          title={
                            continueDisabledReason ||
                            "使用所选模型，在新节点继承已有进度继续，保留当前文件"
                          }
                          onClick={() => void continueInNewNode()}
                        >
                          {continuingId === selected.id ? (
                            <LoaderCircle size={13} className="spin" />
                          ) : (
                            <GitBranch size={13} />
                          )}
                          {continuingId === selected.id
                            ? "正在创建…"
                            : "在新节点继续"}
                        </button>
                      )}
                      {canRetry ? (
                        <button
                          type="button"
                          disabled={!!selectedRetryDisabledReason}
                          title={
                            selectedRetryDisabledReason ||
                            "恢复本卡片本轮修改的文件，再使用原指令和模型重新生成"
                          }
                          onClick={() => void retryInPlace(selected.id)}
                        >
                          {selectedRetryBusy ? (
                            <LoaderCircle size={13} className="spin" />
                          ) : (
                            <RefreshCw size={13} />
                          )}
                          {selectedRetryBusy ? "正在恢复…" : "原地重试"}
                        </button>
                      ) : selected.status !== "running" &&
                        selected.status !== "queued" ? (
                        <button onClick={retryAsBranch}>
                          <GitBranch size={13} />
                          新分支重试
                        </button>
                      ) : null}
                      {(selected.status === "running" ||
                        selected.status === "queued") && (
                        <button onClick={cancel}>
                          <Square size={12} />
                          停止生成
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
              {tab === "context" && (
                <div className="context-view">
                  <ContextCompression
                    key={contextScope}
                    workspace={workspace}
                    node={selected}
                    usage={selectedContextUsage}
                    config={config}
                    model={model}
                    online={online}
                    busy={Boolean(compactingPaths[contextScope])}
                    settingsBusy={Boolean(changingAutoCompact[workspace.id])}
                    selectedCheckpointId={selectedPreparedCheckpoint?.id}
                    onLocateCompression={(checkpointId) =>
                      locateCompression(selected.id, checkpointId)
                    }
                    onBranch={(checkpointId) =>
                      branch(selected.id, checkpointId)
                    }
                    onGenerate={() => void generateContextSummary()}
                    onCancel={() => void cancelContextSummary()}
                    onAutoChange={(value) => void changeAutoCompact(value)}
                    onLocate={locate}
                  />
                  <div className="context-explainer">
                    <Layers size={17} />
                    <b>
                      {selected.contextStale
                        ? "更新后的上下文路径"
                        : canBranch
                          ? "下一轮的原始父链档案"
                          : "本轮的原始父链档案"}
                    </b>
                    <p>
                      {selected.contextStale
                        ? "当前回答仍基于修改前的上下文。请先更新上游待生成节点，再重新生成这一轮。"
                        : "这里保留从起点到当前分支的原文，以及每轮显式引用的卡片快照。实际请求可能使用上方摘要与近期消息，未引用的其他分支不会被带入。"}
                    </p>
                    <span>
                      原文约 {contextEstimate.toLocaleString()} tokens · 估算
                    </span>
                  </div>
                  {contextNodes.map((node, index) => (
                    <details
                      className="context-step"
                      key={node.id}
                      open={index === contextNodes.length - 1}
                    >
                      <summary>
                        <span className="step-number">{index + 1}</span>
                        <b>{node.prompt}</b>
                        <ChevronDown size={13} />
                      </summary>
                      <div>
                        <CardReferenceList
                          references={node.contextReferences ?? []}
                          nodes={workspace.nodes}
                          onLocate={locate}
                        />
                        {node.status === "root" ? (
                          <Markdown text={node.response || "没有额外背景。"} />
                        ) : (
                          <AssistantResponse
                            key={`${node.id}:${node.revision ?? 0}`}
                            response={node.response}
                            thinking={node.thinking}
                            status={node.status}
                          />
                        )}
                        <button onClick={() => locate(node.id)}>
                          在画布上定位
                          <ArrowUpRight size={12} />
                        </button>
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </div>

            <form
              ref={composer.composerRef}
              className={`composer${composer.collapsed ? " is-collapsed" : ""}`}
              onSubmit={send}
            >
              <div className="branch-from">
                {canBranch ? (
                  <button
                    ref={composer.toggleRef}
                    type="button"
                    className="composer-toggle"
                    aria-expanded={!composer.collapsed}
                    aria-controls="composer-content"
                    aria-label={
                      composer.collapsed ? "展开分支输入框" : "收起分支输入框"
                    }
                    title={
                      composer.collapsed
                        ? "展开并继续输入（B）"
                        : "收起输入框，留出更多阅读空间"
                    }
                    onClick={
                      composer.collapsed ? composer.expand : composer.collapse
                    }
                  >
                    <GitBranch size={13} />
                    <span>
                      {composer.collapsed
                        ? draft
                          ? "继续输入 · 草稿已保留"
                          : "点击输入，探索新分支"
                        : "从这里，探索新分支"}
                    </span>
                    <ChevronDown
                      size={13}
                      className="composer-toggle-chevron"
                    />
                  </button>
                ) : (
                  <>
                    <GitBranch size={13} />
                    <span>
                      {selected.contextStale
                        ? "上游指令已更新"
                        : selected.status === "running" ||
                            selected.status === "queued"
                          ? "这个节点正在生成"
                          : "从上一个节点重新出发"}
                    </span>
                  </>
                )}
                {canBranch && (
                  <button
                    type="button"
                    className="context-count"
                    title="查看将被继承的上下文"
                    onClick={() => setTab("context")}
                  >
                    {path.length} 层上下文
                    <ChevronRight size={11} />
                  </button>
                )}
              </div>
              <div
                id="composer-content"
                className="composer-content"
                aria-hidden={composer.collapsed}
                inert={composer.collapsed}
                onTransitionEnd={composer.onTransitionEnd}
              >
                <div className="composer-content-inner">
                  {canBranch ? (
                    <>
                      {canRetry && (
                        <p className="composer-continuation-note">
                          可接着已有进度继续；新节点会继承部分回答和工具记录，保留当前文件。
                        </p>
                      )}
                      <div className="compose-box">
                        <CardReferenceInput
                          key={draftKey}
                          inputRef={inputRef}
                          referenceNodeIds={draftReferenceIds}
                          onReferencesChange={changeDraftReferences}
                          candidates={referenceCandidates}
                          workspaceNodes={workspace.nodes}
                          aria-label="新分支问题"
                          placeholder={
                            selected.status === "root"
                              ? "你想先探索哪个方向？输入 @ 引用卡片"
                              : canRetry
                                ? "补充继续执行的要求，或点击上方「在新节点继续」"
                                : "追问一个细节，或输入 @ 引用卡片…"
                          }
                          value={draft}
                          disabled={submitting}
                          onChange={setDraft}
                          maxLength={20000}
                          onKeyDown={(event) => {
                            if (
                              (event.metaKey || event.ctrlKey) &&
                              event.key === "Enter" &&
                              !event.nativeEvent.isComposing
                            ) {
                              event.preventDefault();
                              void send();
                            }
                          }}
                        />
                        <div className="compose-bottom">
                          <span>
                            <GitBranch size={12} />
                            {selected.status === "root"
                              ? "从起点分支"
                              : `从对话 ${String(currentIndex).padStart(2, "0")} 分支`}
                          </span>
                          <button
                            type="submit"
                            className="send-button"
                            title="创建分支（⌘/Ctrl + Enter）"
                            aria-label="发送并创建分支"
                            disabled={
                              (!draft.trim() && !draftFiles.length) ||
                              submitting ||
                              directoryDirty ||
                              directoryBusy ||
                              changingApproval ||
                              !online ||
                              !model?.available
                            }
                          >
                            {submitting ? (
                              <LoaderCircle size={17} className="spin" />
                            ) : (
                              <ArrowUp size={18} />
                            )}
                          </button>
                        </div>
                      </div>
                      <AttachmentPicker
                        key={draftKey}
                        files={draftFiles}
                        onChange={changeDraftFiles}
                        disabled={submitting || !online}
                      />
                      <ComposerModelControls
                        models={models}
                        config={config}
                        onConfigChange={changeConfig}
                        disabled={!online || submitting}
                      />
                      {selectedContextCheckpointId && (
                        <p className="composer-compression-note" role="status">
                          从压缩节点继续，本次新分支将使用此摘要。
                        </p>
                      )}
                      {directoryDirty && (
                        <p className="root-directory-hint" role="status">
                          工作目录尚未确认，请先在根节点保存或取消修改。
                        </p>
                      )}
                      <div className="composer-footnote">
                        {model?.demo ? (
                          <span>演示模式，不调用远程模型或执行工具</span>
                        ) : (
                          <span
                            title={`当前目录：${workspace.workingDirectory ?? workspace.temporaryDirectory ?? "空间临时目录"}。分支共享当前文件；停止或切换分支不会回滚已执行的操作。`}
                          >
                            {workspace.workingDirectory
                              ? "本地项目"
                              : "临时目录"}{" "}
                            · 本机执行 · 分支共享文件
                          </span>
                        )}
                        <span>
                          <Command size={10} /> Enter
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="blocked-composer">
                      <p>
                        {selected.contextStale
                          ? staleAncestor
                            ? "请先重新生成上游节点，再更新这轮回答。"
                            : "编辑当前指令，使用更新后的上下文重新生成回答。"
                          : selected.status === "running" ||
                              selected.status === "queued"
                            ? "等待完成后继续深入。现在可以切换到其他节点，同时探索。"
                            : "恢复本卡片本轮修改的文件后，使用原指令和模型重新生成。"}
                      </p>
                      <button
                        type="button"
                        disabled={
                          canRetry &&
                          !selected.contextStale &&
                          !!selectedRetryDisabledReason
                        }
                        title={
                          canRetry
                            ? selectedRetryDisabledReason ||
                              "恢复本轮文件修改后，在当前卡片重新生成"
                            : undefined
                        }
                        onClick={() =>
                          selected.contextStale
                            ? staleAncestor
                              ? locate(staleAncestor.id)
                              : openNodeAction("edit", selected.id)
                            : canRetry
                              ? void retryInPlace(selected.id)
                              : retryAsBranch()
                        }
                      >
                        {canRetry && !selected.contextStale ? (
                          selectedRetryBusy ? (
                            <LoaderCircle size={14} className="spin" />
                          ) : (
                            <RefreshCw size={14} />
                          )
                        ) : (
                          <GitBranch size={14} />
                        )}
                        {selected.contextStale
                          ? staleAncestor
                            ? "前往上游待更新节点"
                            : "编辑并重新生成"
                          : selected.status === "running" ||
                              selected.status === "queued"
                            ? "从父节点再开一个方向"
                            : selectedRetryBusy
                              ? "正在恢复…"
                              : "原地重试"}
                        <ArrowRight size={13} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </form>
          </aside>
        </ResizableWorkspace>
      </main>

      {(error || state.storageError) && (
        <div className="toast" role="alert">
          <Circle size={13} />
          <span>{error || state.storageError}</span>
          <button aria-label="关闭提示" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {searchOpen && (
        <div className="search-overlay" onClick={() => setSearchOpen(false)}>
          <div
            className="search-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="search-input">
              <Search size={19} />
              <input
                ref={searchRef}
                autoFocus
                placeholder="搜索这个探索中的问题或回答…"
                aria-label="搜索内容"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button
                aria-label="关闭搜索"
                onClick={() => setSearchOpen(false)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="search-results">
              {results.length ? (
                results.map((node) => (
                  <button key={node.id} onClick={() => locate(node.id)}>
                    <span className={`search-node-dot color-${node.color}`} />
                    <span>
                      <b>{node.prompt}</b>
                      <small>
                        {node.response.replace(/[#*`]/g, "").slice(0, 80) ||
                          statusLabels[node.status]}
                      </small>
                    </span>
                    <ArrowUpRight size={14} />
                  </button>
                ))
              ) : (
                <p>没有找到相关节点，试试其他关键词。</p>
              )}
            </div>
            <div className="search-footer">
              搜索当前探索中的 {workspace.nodes.length} 个节点
              <span>ESC 关闭</span>
            </div>
          </div>
        </div>
      )}
      {nodeAction && nodeAction.workspaceId === workspace.id && (
        <NodeActionsDialog
          key={`${nodeAction.workspaceId}:${nodeAction.node.id}:${nodeAction.mode}`}
          target={nodeAction}
          workspace={workspace}
          models={models}
          disabled={
            !online ||
            submitting ||
            changingApproval ||
            directoryBusy ||
            directoryDirty
          }
          onClose={() => setNodeAction(null)}
          onRegenerate={async (input) => {
            const result = await api<MutationResult>(
              `/workspaces/${nodeAction.workspaceId}/nodes/${nodeAction.node.id}/regenerate`,
              input,
            );
            apply(result.state);
            select(nodeAction.node.id);
            setConfig({ ...input.config });
            configSelection.current = {
              nodeId: nodeAction.node.id,
              revision: input.expectedRevision + 1,
              resolved: true,
            };
            setFocus((current) => ({
              id: nodeAction.node.id,
              version: current.version + 1,
            }));
            setNodeAction(null);
          }}
          onDelete={async () => {
            const next = await api<AppState>(
              `/workspaces/${nodeAction.workspaceId}/nodes/${nodeAction.node.id}`,
              {
                expectedRevision: nodeAction.node.revision ?? 0,
                expectedNodeIds: nodeAction.subtreeIds,
              },
              "DELETE",
            );
            apply(next);
            const parentId = nodeAction.node.parentId!;
            select(parentId);
            setFocus((current) => ({
              id: parentId,
              version: current.version + 1,
            }));
            setDrafts((current) =>
              Object.fromEntries(
                Object.entries(current).filter(
                  ([key]) =>
                    !nodeAction.subtreeIds.some((id) =>
                      key.startsWith(`${nodeAction.workspaceId}:${id}:`),
                    ),
                ),
              ),
            );
            setApprovalFocus((current) =>
              current && nodeAction.subtreeIds.includes(current.nodeId)
                ? null
                : current,
            );
            setSearchOpen(false);
            setSearch("");
            setNodeAction(null);
          }}
        />
      )}
      {workspaceToDelete && (
        <DeleteWorkspaceDialog
          key={workspaceToDelete.id}
          target={workspaceToDelete}
          workspace={state.workspaces.find(
            (item) => item.id === workspaceToDelete.id,
          )}
          disabled={
            !online ||
            submitting ||
            changingApproval ||
            directoryBusy ||
            !!retryingId
          }
          onClose={() => setWorkspaceToDelete(null)}
          onDelete={async (deleteTemporaryDirectory) => {
            const target = workspaceToDelete;
            const deletingCurrent = currentWorkspaceId.current === target.id;
            const next = await api<AppState>(
              `/workspaces/${encodeURIComponent(target.id)}`,
              {
                deleteTemporaryDirectory,
                expectedNodeIds: target.nodes.map((node) => node.id),
              },
              "DELETE",
            );
            apply(next);
            if (deletingCurrent || !next.workspaces.length) {
              const remaining = next.workspaces[0];
              setWorkspaceId(remaining?.id ?? null);
              setSelectedId(remaining?.nodes[0]?.id ?? null);
              savePreference("workspace", remaining?.id ?? "");
              savePreference("node", remaining?.nodes[0]?.id ?? "");
              setFocus({ id: null, version: 0 });
              setTab("conversation");
              setApprovalFocus(null);
            }
            setDrafts((current) =>
              Object.fromEntries(
                Object.entries(current).filter(
                  ([key]) => !key.startsWith(`${target.id}:`),
                ),
              ),
            );
            setCanvasDrafts((current) =>
              Object.fromEntries(
                Object.entries(current).filter(
                  ([, draft]) => draft.workspaceId !== target.id,
                ),
              ),
            );
            setCanvasDraftParents((current) =>
              Object.fromEntries(
                Object.entries(current).filter(([key]) => key !== target.id),
              ),
            );
            setSearchOpen(false);
            setSearch("");
            setWorkspaceToDelete(null);
            setError("");
            requestAnimationFrame(() => {
              const nextControl = document.querySelector<HTMLButtonElement>(
                ".workspace-item.selected, .workspace-empty-screen > .primary-button",
              );
              if (window.innerWidth <= 1000 && next.workspaces.length)
                sidebarToggleRef.current?.focus();
              else nextControl?.focus();
            });
          }}
        />
      )}
      {workspaceModal}
    </div>
  );
}

function Settings({
  models,
  webCapabilities,
}: {
  models: ModelOption[];
  webCapabilities: WebCapabilities | null;
}) {
  const desktop = getDesktopBridge();
  const providers = [
    ...new Set(
      models.filter((model) => !model.demo).map((model) => model.provider),
    ),
  ];
  return (
    <>
      <div className="modal-illustration">
        <Settings2 size={25} />
      </div>
      <h2>模型与联网工具</h2>
      <p className="modal-intro">
        由 Pi 统一驱动。每一轮对话，都可以有自己的模型。
      </p>
      <div className="provider-row">
        <span className="provider-logo">π</span>
        <div>
          <b>Pi Demo</b>
          <small>本地演示 · 无需密钥 · 预设回复</small>
        </div>
        <span className="provider-connected">
          <Check size={12} />
          已就绪
        </span>
      </div>
      {providers.map((provider) => {
        const options = models.filter((model) => model.provider === provider);
        const first = options[0];
        return (
          <div className="provider-row" key={provider}>
            <span className={`provider-logo ${provider}`}>
              {provider === "anthropic"
                ? "A"
                : provider === "openai"
                  ? "◎"
                  : provider === "google"
                    ? "G"
                    : (first?.providerName ?? provider)
                        .slice(0, 1)
                        .toUpperCase()}
            </span>
            <div>
              <b>{first?.providerName ?? provider}</b>
              <small>{first?.envVar}</small>
            </div>
            <span
              className={
                first?.available
                  ? "provider-connected"
                  : "provider-disconnected"
              }
            >
              {first?.available ? <Check size={12} /> : <Unplug size={12} />}
              {first?.available ? "已连接" : "未配置"}
            </span>
          </div>
        );
      })}
      <div className="setup-guide">
        <b>在本机配置</b>
        {desktop ? (
          <p>
            打开模型配置，在 <code>.env</code> 中填入供应商 API Key。 保存后，从
            macOS 的 Panel 菜单重启本地服务。 已配置的模型可在输入框下方选择。
          </p>
        ) : (
          <p>
            将项目中的 <code>.env.example</code> 复制为 <code>.env</code>
            ，填入供应商 API Key，然后重启 <code>npm run dev</code>
            。已配置的模型可在输入框下方选择。
          </p>
        )}
        <p>密钥只由本地服务读取，不会保存到浏览器或随探索导出。</p>
        {desktop && <DesktopSettingsActions />}
      </div>
      <section className="web-settings" aria-label="联网工具连接状态">
        <h3>联网工具</h3>
        <p>真实模型可使用，无需选择本地项目。</p>
        <div className="provider-row">
          <span className="provider-logo">
            <Globe size={17} />
          </span>
          <div>
            <b>{webCapabilities?.pdfRead ? "网页与 PDF 读取" : "网页读取"}</b>
            <small>公开网址 · 提取文本 · 无需搜索密钥</small>
          </div>
          <span
            className={
              webCapabilities?.webFetch
                ? "provider-connected"
                : "provider-disconnected"
            }
          >
            {webCapabilities?.webFetch ? (
              <Check size={12} />
            ) : (
              <Unplug size={12} />
            )}
            {webCapabilities === null
              ? "读取中"
              : webCapabilities.webFetch
                ? "已就绪"
                : "未启用"}
          </span>
        </div>
        <div className="provider-row">
          <span className="provider-logo">
            <Search size={17} />
          </span>
          <div>
            <b>{webCapabilities?.searchProvider ?? "Exa 搜索"}</b>
            <small>
              {webCapabilities === null
                ? "读取连接状态…"
                : webCapabilities.searchProvider === "Exa API"
                  ? "使用可选 API 密钥"
                  : "默认 MCP · 无需密钥"}
            </small>
          </div>
          <span
            className={
              webCapabilities?.webSearch
                ? "provider-connected"
                : "provider-disconnected"
            }
          >
            {webCapabilities?.webSearch ? (
              <Check size={12} />
            ) : (
              <Unplug size={12} />
            )}
            {webCapabilities === null
              ? "读取中"
              : webCapabilities.webSearch
                ? "已就绪"
                : "未启用"}
          </span>
        </div>
        <div className="setup-guide">
          <b>搜索默认可用</b>
          <p>
            默认通过 Exa MCP 搜索，无需搜索密钥。如需使用 Exa API，可在
            <code>.env</code> 中设置 <code>EXA_API_KEY</code>，然后
            {desktop ? (
              "从 macOS 的 Panel 菜单重启本地服务。"
            ) : (
              <>
                重启 <code>npm run dev</code>。
              </>
            )}
          </p>
          <p>
            联网请求沿用顶部审批模式。请求批准时逐次确认；自动审批时先由所选安全模型审核。
            网页与 PDF
            仅读取文本，不执行页面脚本，不读取登录态或访问本机与内网地址。
          </p>
        </div>
      </section>
      <div className="settings-note">
        <span className="tiny-green-dot" /> 当前工作台运行在本机 · 同时支持 3
        个运行任务
      </div>
    </>
  );
}

function DesktopSettingsActions() {
  const [busy, setBusy] = useState<"settings" | "data" | null>(null);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const open = async (target: "settings" | "data") => {
    const desktop = getDesktopBridge();
    if (!desktop || pending.current) return;
    pending.current = true;
    setBusy(target);
    setError("");
    try {
      if (target === "settings") await desktop.openSettings();
      else await desktop.openDataDirectory();
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : "无法打开本地文件");
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  return (
    <>
      <div className="desktop-actions">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void open("settings")}
        >
          {busy === "settings" ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <Settings2 size={13} />
          )}
          打开模型配置
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void open("data")}
        >
          {busy === "data" ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <FileText size={13} />
          )}
          打开应用数据文件夹
        </button>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function Help() {
  return (
    <>
      <div className="modal-illustration">
        <Network size={26} />
      </div>
      <div className="eyebrow">THINK IN BRANCHES</div>
      <h2>让思考自由生长</h2>
      <p className="modal-intro">对话是一张地图，每个节点都是新的出发点。</p>
      <div className="help-steps">
        <div>
          <span>01</span>
          <section>
            <b>从任意完成的节点出发</b>
            <p>点击卡片上的 ＋，或选中节点后在右侧写下问题，即可创建新分支。</p>
          </section>
        </div>
        <div>
          <span>02</span>
          <section>
            <b>沿着路径继承上下文</b>
            <p>
              每次调用只读根到当前父节点的问答。打开「上下文路径」即可查看，其他分支保持独立。
            </p>
          </section>
        </div>
        <div>
          <span>03</span>
          <section>
            <b>让多个方向一起推进</b>
            <p>
              一个节点生成时，切换到其他节点继续探索。各分支可以使用不同模型与思考强度。
            </p>
          </section>
        </div>
        <div>
          <span>04</span>
          <section>
            <b>使用临时目录，或连接本地项目</b>
            <p>
              空间默认使用按固定 ID
              分配的临时目录，真实模型可以直接下载文件、编写代码和执行命令。目录在首次真实任务时创建，重启后保留，不会自动清理。在根节点可查看空间
              ID
              和完整路径，也可选择本地项目或恢复临时目录；切换目录不会迁移或删除文件。
            </p>
            <p>
              执行模型与思考深度在输入框下方选择，审批方式与安全模型在顶部调整。请求批准模式下，文件读取由只读策略放行，修改文件、执行命令和联网请求需要你批准。
            </p>
            <p>
              自动审批需独立选择安全模型，每次工具调用都先交给它审核；明确批准后才执行。拒绝、审核异常或配置不可用时会请求你批准，工具活动中保留审核模型与理由。安全审核也会产生模型用量。
            </p>
            <p>
              审核期间可以停止节点。更改审批方式或安全模型后，当前审核转为人工审批，新设置用于后续操作；待批准操作不会自动放行。
            </p>
            <p>
              命令在本机执行，非沙箱。同一目录的编码任务依次运行，所有分支共享当前文件，切换分支不会回滚修改。演示模型不执行工具。
            </p>
          </section>
        </div>
        <div>
          <span>05</span>
          <section>
            <b>搜索资料，读取网页与 PDF</b>
            <p>
              选择真实模型后即可让 Agent 搜索资料、读取公开网页和
              PDF，无需选择本地项目。网页搜索默认使用无需密钥的 Exa
              MCP，在「模型连接」中查看连接状态。
              工具活动显示查询、读取结果与可点击的来源链接。网页读取仅提取 PDF
              文本；下载原文件由批准后的命令保存到当前工作目录。
            </p>
          </section>
        </div>
      </div>
      <div className="shortcuts">
        <span>
          搜索节点<kbd>⌘ / Ctrl K</kbd>
        </span>
        <span>
          发送问题<kbd>⌘ / Ctrl Enter</kbd>
        </span>
        <span>
          聚焦输入<kbd>B</kbd>
        </span>
      </div>
    </>
  );
}
