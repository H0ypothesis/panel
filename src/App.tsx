import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
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
import {
  ComposerModelControls,
  RootDirectoryCard,
  WorkbenchControls,
} from "./WorkspaceControls";
import { useTheme, type ThemePreference } from "./useTheme";
import { BrandHint } from "./BrandHint";
import {
  NodeActionsDialog,
  subtreeIds,
  type NodeActionTarget,
} from "./NodeActionsDialog";

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

function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
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
    Record<string, { text: string; requestId: string }>
  >({});
  const [config, setConfig] = useState<RunConfig>({ ...DEFAULT_CONFIG });
  const configSelection = useRef({ nodeId: "", revision: -1, resolved: false });
  const [submitting, setSubmitting] = useState(false);
  const [nodeAction, setNodeAction] = useState<NodeActionTarget | null>(null);
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
  const selected =
    workspace?.nodes.find((node) => node.id === selectedId) ??
    workspace?.nodes[0];
  const parent =
    selected && workspace?.nodes.find((node) => node.id === selected.parentId);
  const canBranch =
    !selected?.contextStale &&
    (selected?.status === "root" || selected?.status === "completed");
  const draftKey = `${workspace?.id}:${selected?.id}`;
  const draft = drafts[draftKey]?.text ?? "";
  const model = models.find((item) => item.id === config.model);
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
      setTab("conversation");
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
      !approvalFocus ||
      selected?.id !== approvalFocus.nodeId ||
      tab !== "conversation"
    )
      return;
    const frame = requestAnimationFrame(() => {
      detailRef.current
        ?.querySelector(
          `[data-tool-call-id="${CSS.escape(approvalFocus.toolId)}"]`,
        )
        ?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [approvalFocus, selected?.id, tab]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (modal === "directory" || nodeAction) return;
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
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement) &&
        !modal
      )
        inputRef.current?.focus();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [modal, closeSidebar, nodeAction]);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    setTab("conversation");
  }, []);
  const branch = useCallback(
    (id: string) => {
      select(id);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [select],
  );
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
      [draftKey]: { text, requestId: crypto.randomUUID() },
    }));

  const changeConfig = (next: RunConfig) => {
    configSelection.current.resolved = true;
    setConfig(next);
    setDrafts((current) => ({
      ...current,
      [draftKey]: {
        text: current[draftKey]?.text ?? "",
        requestId: crypto.randomUUID(),
      },
    }));
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (
      !workspace ||
      !selected ||
      !draft.trim() ||
      !canBranch ||
      submitting ||
      directoryDirty ||
      directoryBusy ||
      changingApproval
    )
      return;
    const key = draftKey;
    const submittedText = draft;
    const requestId = drafts[key]?.requestId ?? crypto.randomUUID();
    setSubmitting(true);
    try {
      const result = await api<MutationResult>(
        `/workspaces/${workspace.id}/nodes`,
        { parentId: selected.id, prompt: draft, config, requestId },
      );
      apply(result.state);
      setDrafts((current) =>
        current[key]?.text === submittedText
          ? { ...current, [key]: { text: "", requestId: crypto.randomUUID() } }
          : current,
      );
      select(result.nodeId!);
      setFocus((current) => ({
        id: result.nodeId!,
        version: current.version + 1,
      }));
    } catch (reason) {
      fail(reason);
    } finally {
      setSubmitting(false);
    }
  };

  const retry = () => {
    if (!parent || !selected || !workspace) return;
    const key = `${workspace.id}:${parent.id}`;
    setDrafts((current) => ({
      ...current,
      [key]: { text: selected.prompt, requestId: crypto.randomUUID() },
    }));
    select(parent.id);
    requestAnimationFrame(() => {
      configSelection.current.resolved = true;
      setConfig({ ...selected.config });
      inputRef.current?.focus();
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

  const decideApproval = async (
    toolId: string,
    decision: "approve" | "deny",
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
      await navigator.clipboard.writeText(selected?.response ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("无法访问剪贴板，请直接选择文本复制。");
    }
  };

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
  const contextEstimate = Math.ceil(
    contextNodes.reduce(
      (sum, node) => sum + node.prompt.length + node.response.length,
      0,
    ) * 1.2,
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
            <button
              key={item.id}
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
              colorMode={colorMode}
              onSelect={select}
              onBranch={branch}
              onEdit={(id) => openNodeAction("edit", id)}
              onDelete={(id) => openNodeAction("delete", id)}
              nodeActionsDisabled={
                !online ||
                submitting ||
                changingApproval ||
                directoryBusy ||
                directoryDirty
              }
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
            {workspace.nodes.length === 1 && (
              <div className="empty-canvas-note">
                <GitBranch size={18} />
                <b>每一个好问题，都可以是新的起点。</b>
                <span>在右侧写下第一个问题，开始你的探索。</span>
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
            <div className="inspector-content" ref={detailRef}>
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
                    <div className="answer-heading">
                      <span className="answer-logo">π</span>
                      <b>
                        {selectedModel?.name ??
                          selected.config.model.split("/").at(-1)}
                      </b>
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
                        calls={selected.toolCalls}
                        workingDirectory={selected.execution?.workingDirectory}
                        onDecision={decideApproval}
                      />
                    )}
                    {selected.response ? (
                      <Markdown text={selected.response} />
                    ) : (
                      <div className="waiting-response">
                        {selected.status === "running" ||
                        selected.status === "queued" ? (
                          <>
                            <span className="thinking-dots">
                              <i />
                              <i />
                              <i />
                            </span>
                            {selectedPendingApproval
                              ? "工具操作等待你的批准…"
                              : selectedSafetyReview
                                ? "安全模型正在审核工具操作…"
                                : selected.status === "running"
                                  ? "正在展开这个方向…"
                                  : "已进入队列，稍后开始…"}
                          </>
                        ) : (
                          "这次运行没有生成回答。"
                        )}
                      </div>
                    )}
                    {selected.error && (
                      <div className="inline-error">{selected.error}</div>
                    )}
                    {selected.usage && (
                      <div className="usage">
                        {selected.usage.total.toLocaleString()} tokens
                        {selected.usage.cost !== undefined
                          ? ` · $${selected.usage.cost.toFixed(4)}`
                          : ""}
                        {selected.finishedAt && selected.startedAt
                          ? ` · ${((selected.finishedAt - selected.startedAt) / 1000).toFixed(1)} 秒`
                          : ""}
                      </div>
                    )}
                    <div className="answer-actions">
                      {selected.response && (
                        <button onClick={copyAnswer}>
                          {copied ? <Check size={13} /> : <Copy size={13} />}
                          {copied ? "已复制" : "复制"}
                        </button>
                      )}
                      {selected.status !== "running" &&
                        selected.status !== "queued" && (
                          <button onClick={retry}>
                            <GitBranch size={13} />
                            新分支重试
                          </button>
                        )}
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
                  <div className="context-explainer">
                    <Layers size={17} />
                    <b>
                      {selected.contextStale
                        ? "更新后的上下文路径"
                        : canBranch
                          ? "下一轮将继承这条路径"
                          : "本轮使用的上下文路径"}
                    </b>
                    <p>
                      {selected.contextStale
                        ? "当前回答仍基于修改前的上下文。请先更新上游待生成节点，再重新生成这一轮。"
                        : "从起点到当前分支，按时间顺序传递。其他分支的内容不会被带入。"}
                    </p>
                    <span>
                      约 {contextEstimate.toLocaleString()} tokens · 估算
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
                        <Markdown text={node.response || "没有额外背景。"} />
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

            <form className="composer" onSubmit={send}>
              <div className="branch-from">
                <GitBranch size={13} />
                <span>
                  {selected.contextStale
                    ? "上游指令已更新"
                    : canBranch
                      ? "从这里，探索新分支"
                      : selected.status === "running" ||
                          selected.status === "queued"
                        ? "这个节点正在生成"
                        : "从上一个节点重新出发"}
                </span>
                {canBranch && (
                  <span
                    className="context-count"
                    title="查看将被继承的上下文"
                    onClick={() => setTab("context")}
                  >
                    {path.length} 层上下文
                    <ChevronRight size={11} />
                  </span>
                )}
              </div>
              {canBranch ? (
                <>
                  <div className="compose-box">
                    <textarea
                      ref={inputRef}
                      aria-label="新分支问题"
                      placeholder={
                        selected.status === "root"
                          ? "你想先探索哪个方向？"
                          : "追问一个细节，或打开新的可能…"
                      }
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
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
                          !draft.trim() ||
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
                  <ComposerModelControls
                    models={models}
                    config={config}
                    onConfigChange={changeConfig}
                    disabled={!online || submitting}
                  />
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
                        {workspace.workingDirectory ? "本地项目" : "临时目录"} ·
                        本机执行 · 分支共享文件
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
                        : "这轮内容不完整。保留当前记录，从父节点创建新分支。"}
                  </p>
                  <button
                    type="button"
                    onClick={() =>
                      selected.contextStale
                        ? staleAncestor
                          ? locate(staleAncestor.id)
                          : openNodeAction("edit", selected.id)
                        : retry()
                    }
                  >
                    <GitBranch size={14} />
                    {selected.contextStale
                      ? staleAncestor
                        ? "前往上游待更新节点"
                        : "编辑并重新生成"
                      : selected.status === "running" ||
                          selected.status === "queued"
                        ? "从父节点再开一个方向"
                        : "准备重试"}
                    <ArrowRight size={13} />
                  </button>
                </div>
              )}
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
                    !nodeAction.subtreeIds.some(
                      (id) => key === `${nodeAction.workspaceId}:${id}`,
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
      {modal && modal !== "directory" && (
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
                onCreate={async (title, description) => {
                  const result = await api<MutationResult>("/workspaces", {
                    title,
                    description,
                  });
                  apply(result.state);
                  setWorkspaceId(result.workspaceId!);
                  setSelectedId(null);
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
      )}
    </div>
  );
}

function NewWorkspace({
  onCreate,
}: {
  onCreate: (title: string, description: string) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          await onCreate(title, description);
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : "创建失败");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="modal-illustration">
        <GitBranch size={27} />
      </div>
      <div className="eyebrow">START WITH A QUESTION</div>
      <h2>开启一个新的探索</h2>
      <p className="modal-intro">
        每个空间自带临时目录，可直接开始；也可在根节点选择本地项目。
      </p>
      <label className="form-label">
        探索主题
        <input
          autoFocus
          required
          maxLength={80}
          placeholder="例如：下一代 AI 工作台应该是什么样？"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label className="form-label">
        背景与目标 <span>选填</span>
        <textarea
          maxLength={10000}
          placeholder="补充一些背景。这些信息会被所有分支继承。"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      <button className="primary-button" disabled={!title.trim() || busy}>
        {busy ? (
          <LoaderCircle size={15} className="spin" />
        ) : (
          <Plus size={15} />
        )}
        创建探索
        <ArrowRight size={15} />
      </button>
    </form>
  );
}

function Settings({
  models,
  webCapabilities,
}: {
  models: ModelOption[];
  webCapabilities: WebCapabilities | null;
}) {
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
        <p>
          将项目中的 <code>.env.example</code> 复制为 <code>.env</code>
          ，填入供应商 API Key，然后重启 <code>npm run dev</code>
          。已配置的模型可在输入框下方选择。
        </p>
        <p>密钥只由本地服务读取，不会保存到浏览器或随探索导出。</p>
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
            默认通过 Exa MCP 搜索，无需搜索密钥。如需使用 Exa API，可在项目
            <code>.env</code> 中设置 <code>EXA_API_KEY</code>，然后重启
            <code>npm run dev</code>。
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
