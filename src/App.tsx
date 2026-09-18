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
  Circle,
  CircleHelp,
  Command,
  Copy,
  FileJson,
  FileText,
  GitBranch,
  Layers,
  LoaderCircle,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Square,
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
  type ModelOption,
  type RunConfig,
  type TurnNode,
  type Workspace,
} from "../shared/types";
import {
  api,
  readPreference,
  savePreference,
  type MutationResult,
} from "./api";
import { Graph, StatusIcon } from "./Graph";

function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`logo ${small ? "small" : ""}`}>
      <svg width="30" height="30" viewBox="0 0 36 36" fill="none">
        <rect width="36" height="36" rx="10" fill="currentColor" />
        <path
          d="M11 11v14m0-7h8m0 0v-7m0 7 7 7"
          stroke="#d7e8c8"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <circle cx="11" cy="11" r="2.2" fill="#d7e8c8" />
        <circle cx="19" cy="11" r="2.2" fill="#d7e8c8" />
        <circle cx="26" cy="25" r="2.2" fill="#d7e8c8" />
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
  const [state, setState] = useState<AppState | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [workspaceId, setWorkspaceId] = useState(readPreference("workspace"));
  const [selectedId, setSelectedId] = useState(readPreference("node"));
  const [online, setOnline] = useState(false);
  const [error, setError] = useState("");
  const [modal, setModal] = useState<"new" | "settings" | "help" | null>(null);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [tab, setTab] = useState<"conversation" | "context">("conversation");
  const [drafts, setDrafts] = useState<
    Record<string, { text: string; requestId: string }>
  >({});
  const [config, setConfig] = useState<RunConfig>({ ...DEFAULT_CONFIG });
  const [submitting, setSubmitting] = useState(false);
  const [sidebar, setSidebar] = useState(window.innerWidth > 1000);
  const [focus, setFocus] = useState<{ id: string | null; version: number }>({
    id: null,
    version: 0,
  });
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
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
    void Promise.all([api<AppState>("/state"), api<ModelOption[]>("/models")])
      .then(([next, options]) => {
        if (mounted) {
          apply(next);
          setModels(options);
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
      void api<ModelOption[]>("/models")
        .then((options) => {
          if (mounted) setModels(options);
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
    selected?.status === "root" || selected?.status === "completed";
  const draftKey = `${workspace?.id}:${selected?.id}`;
  const draft = drafts[draftKey]?.text ?? "";
  const model = models.find((item) => item.id === config.model);
  const selectedModel = models.find(
    (item) => item.id === selected?.config.model,
  );
  const path =
    workspace && selected ? ancestorPath(workspace.nodes, selected.id) : [];
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

  useEffect(() => {
    if (!selected) return;
    setConfig({ ...selected.config });
    setTab("conversation");
    detailRef.current?.scrollTo({ top: 0 });
    savePreference("node", selected.id);
  }, [selected?.id]);
  useEffect(() => {
    if (workspace) savePreference("workspace", workspace.id);
  }, [workspace?.id]);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setModal(null);
        setSearchOpen(false);
        setExportOpen(false);
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
  }, [modal]);

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
  const setDraft = (text: string) =>
    setDrafts((current) => ({
      ...current,
      [draftKey]: { text, requestId: crypto.randomUUID() },
    }));

  const changeConfig = (next: RunConfig) => {
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
    if (!workspace || !selected || !draft.trim() || !canBranch || submitting)
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
      {sidebar && (
        <button
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Logo />
          <button
            className="icon-button"
            aria-label="收起侧栏"
            onClick={() => setSidebar(false)}
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
              }}
            >
              <Network size={16} />
              <span>
                {item.title}
                <small>
                  {item.nodes.length} 个节点{" "}
                  {item.example ? "· 示例探索" : "· 自动保存"}
                </small>
              </span>
              {item.nodes.some((node) => node.status === "running") && (
                <span className="tiny-green-dot pulse" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        <div className="thought-card">
          <div className="mini-tree">
            <i />
            <i />
            <i />
            <i />
            <svg viewBox="0 0 150 42">
              <path d="M8 22H43Q53 22 61 11H89M53 22H108M53 22Q61 35 81 35H134" />
            </svg>
          </div>
          <b>好想法，值得多走一条路。</b>
          <p>
            从任意节点出发，
            <br />
            让不同的可能同时生长。
          </p>
          <button onClick={() => setModal("help")}>
            认识非线性对话 <ArrowUpRight size={12} />
          </button>
        </div>
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
          <div className="breadcrumbs">
            {!sidebar && (
              <button
                className="icon-button"
                aria-label="展开侧栏"
                onClick={() => setSidebar(true)}
              >
                <PanelLeftOpen size={17} />
              </button>
            )}
            <Layers size={15} />
            <span>探索空间</span>
            <ChevronRight size={13} />
            <strong>{workspace.title}</strong>
            {workspace.example && <span className="example-badge">示例</span>}
          </div>
          <div className="topbar-actions">
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
        </header>
        <div className="exploration-heading">
          <div>
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
        <div className="workspace-body">
          <section className="canvas-section" aria-label="非线性对话画布">
            <Graph
              key={workspace.id}
              workspace={workspace}
              selectedId={selected.id}
              models={models}
              onSelect={select}
              onBranch={branch}
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

          <aside className="inspector" aria-label="节点详情">
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
                <StatusIcon status={selected.status} />
                {statusLabels[selected.status]}
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
              {tab === "conversation" ? (
                <>
                  <div className="question-label">
                    <span className="user-dot">S</span>
                    {selected.status === "root" ? "探索主题" : "你的问题"}
                  </div>
                  <h2 className="node-question">{selected.prompt}</h2>
                  {selected.status === "root" ? (
                    <>
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
                          <span>02</span>选择模型与思考强度
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
                              {selected.status === "running"
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
                          {selected.usage.total.toLocaleString()} tokens · $
                          {selected.usage.cost.toFixed(4)}
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
                </>
              ) : (
                <div className="context-view">
                  <div className="context-explainer">
                    <Layers size={17} />
                    <b>
                      {canBranch
                        ? "下一轮将继承这条路径"
                        : "本轮使用的上下文路径"}
                    </b>
                    <p>
                      从起点到当前分支，按时间顺序传递。其他分支的内容不会被带入。
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
                  {canBranch
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
                  <div className="model-controls">
                    <label className="model-select">
                      <span className="pi-small">π</span>
                      <select
                        aria-label="选择模型"
                        value={config.model}
                        onChange={(event) => {
                          const next = models.find(
                            (item) => item.id === event.target.value,
                          )!;
                          changeConfig({
                            model: next.id,
                            thinking: next.thinkingLevels.includes(
                              config.thinking,
                            )
                              ? config.thinking
                              : next.thinkingLevels.includes("medium")
                                ? "medium"
                                : next.thinkingLevels[0],
                          });
                        }}
                      >
                        {["demo", "anthropic", "openai", "google"].map(
                          (provider) => (
                            <optgroup
                              key={provider}
                              label={
                                models.find(
                                  (item) => item.provider === provider,
                                )?.providerName ?? provider
                              }
                            >
                              {models
                                .filter((item) => item.provider === provider)
                                .map((item) => (
                                  <option
                                    key={item.id}
                                    value={item.id}
                                    disabled={!item.available}
                                  >
                                    {item.name}
                                    {item.demo
                                      ? " · 演示"
                                      : !item.available
                                        ? " · 未连接"
                                        : ""}
                                  </option>
                                ))}
                            </optgroup>
                          ),
                        )}
                      </select>
                      <ChevronDown size={11} />
                    </label>
                    <label className="thinking-select">
                      <Zap size={12} />
                      <select
                        aria-label="思考强度"
                        value={config.thinking}
                        onChange={(event) =>
                          changeConfig({
                            ...config,
                            thinking: event.target
                              .value as RunConfig["thinking"],
                          })
                        }
                      >
                        {(model?.thinkingLevels ?? ["medium"]).map((level) => (
                          <option key={level} value={level}>
                            {thinkingLabels[level]}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={11} />
                    </label>
                  </div>
                  <div className="composer-footnote">
                    {model?.demo ? (
                      <span>演示模式，不调用远程模型</span>
                    ) : (
                      <span>仅继承当前分支的上下文</span>
                    )}
                    <span>
                      <Command size={10} /> Enter
                    </span>
                  </div>
                </>
              ) : (
                <div className="blocked-composer">
                  <p>
                    {selected.status === "running" ||
                    selected.status === "queued"
                      ? "等待完成后继续深入。现在可以切换到其他节点，同时探索。"
                      : "这轮内容不完整。保留当前记录，从父节点创建新分支。"}
                  </p>
                  <button type="button" onClick={retry}>
                    <GitBranch size={14} />
                    {selected.status === "running" ||
                    selected.status === "queued"
                      ? "从父节点再开一个方向"
                      : "准备重试"}
                    <ArrowRight size={13} />
                  </button>
                </div>
              )}
            </form>
          </aside>
        </div>
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
      {modal && (
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
                }}
              />
            ) : modal === "settings" ? (
              <Settings models={models} />
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
      <p className="modal-intro">一个问题，可以通向很多种可能。</p>
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
      {error && <div className="inline-error">{error}</div>}
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

function Settings({ models }: { models: ModelOption[] }) {
  const providers = ["anthropic", "openai", "google"];
  return (
    <>
      <div className="modal-illustration">
        <Settings2 size={25} />
      </div>
      <h2>连接你的模型</h2>
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
                  : "G"}
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
          。已配置的模型将出现在节点选择器中。
        </p>
        <p>密钥只由本地服务读取，不会保存到浏览器或随探索导出。</p>
      </div>
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
