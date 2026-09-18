import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  FolderOpen,
  LoaderCircle,
  ShieldCheck,
  Zap,
  X,
} from "lucide-react";
import {
  thinkingLabels,
  type ApprovalMode,
  type ModelOption,
  type RunConfig,
  type Workspace,
} from "../shared/types";
import { ApprovalModeSwitch, DirectoryField } from "./CodingControls";
import { formatContextWindow } from "./model-context";

function modelContextTitle(model: ModelOption | undefined): string {
  const capacity = model?.contextWindow;
  if (capacity == null || !Number.isFinite(capacity) || capacity <= 0)
    return "上下文容量未知";
  return `上下文容量：${capacity.toLocaleString("zh-CN", { maximumFractionDigits: 20 })} tokens`;
}

function DirectoryDialog({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialogRef}
      className="root-directory-dialog"
      aria-label="设置工作目录"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="root-directory-dialog-content">
        <button
          type="button"
          className="icon-button"
          aria-label="关闭项目选择"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        {children}
      </div>
    </dialog>,
    document.body,
  );
}

export function RootDirectoryCard({
  workspace,
  onSave,
  onBusyChange,
  onDirtyChange,
  disabled = false,
  dialogOpen = false,
  onDialogClose,
}: {
  workspace: Workspace;
  onSave: (directory: string | null) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  disabled?: boolean;
  dialogOpen?: boolean;
  onDialogClose?: () => void;
}) {
  const savedDirectory = workspace.workingDirectory ?? "";
  const effectiveDirectory =
    workspace.workingDirectory ?? workspace.temporaryDirectory;
  const [directory, setDirectory] = useState(savedDirectory);
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const dirty = directory.trim() !== savedDirectory;
  const active = workspace.nodes.some(
    (node) => node.status === "running" || node.status === "queued",
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!edited) setDirectory(savedDirectory);
  }, [savedDirectory, edited]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  const save = async () => {
    if (!dirty || busy || disabled || active) return;
    setBusy(true);
    setError("");
    try {
      await onSave(directory.trim() || null);
      if (mounted.current) {
        setEdited(false);
        if (dialogOpen) onDialogClose?.();
      }
    } catch (reason) {
      if (mounted.current)
        setError(reason instanceof Error ? reason.message : "工作目录保存失败");
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const editor = (
    <section className="root-directory-card" aria-label="工作目录确认">
      <div className="root-directory-heading">
        <FolderOpen size={17} />
        <div className="root-directory-copy">
          <b>空间工作目录</b>
          <p>默认使用临时目录，也可以选择本地项目。所有分支共用文件。</p>
        </div>
        <span className="root-directory-status" title={effectiveDirectory}>
          {dirty ? "待确认" : savedDirectory ? "本地项目" : "临时目录"}
        </span>
      </div>
      <dl className="workspace-directory-details">
        <div>
          <dt>空间 ID</dt>
          <dd>
            <code title="空间 ID 固定不变，可选中复制">{workspace.id}</code>
          </dd>
        </div>
        <div>
          <dt>当前目录</dt>
          <dd>
            <code>{effectiveDirectory ?? "首次真实任务时自动准备"}</code>
          </dd>
        </div>
      </dl>
      <DirectoryField
        value={directory}
        autoBrowse={dialogOpen}
        disabled={disabled || active || busy}
        onChange={(value) => {
          setDirectory(value);
          setEdited(true);
          setError("");
        }}
      />
      {savedDirectory && directory.trim() && (
        <div className="root-directory-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={disabled || active || busy}
            onClick={() => {
              setDirectory("");
              setEdited(true);
              setError("");
            }}
          >
            使用临时目录
          </button>
        </div>
      )}
      <p className="root-directory-hint">
        临时目录按空间 ID 分配，首次真实任务时创建，重启后保留，不会自动清理。
        切换目录不会迁移或删除文件。
      </p>
      {active && (
        <p className="root-directory-hint">
          当前有任务运行或排队，请结束或停止任务后再更换目录。
        </p>
      )}
      {error && (
        <p className="root-directory-error inline-error" role="alert">
          {error}
        </p>
      )}
      {dirty && (
        <div className="root-directory-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              setDirectory(savedDirectory);
              setEdited(false);
              setError("");
            }}
          >
            取消修改
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={disabled || busy || active}
            onClick={() => void save()}
          >
            {busy ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Check size={14} />
            )}
            {busy
              ? "正在保存…"
              : !directory.trim()
                ? "恢复临时目录"
                : savedDirectory
                  ? "保存工作目录"
                  : "确认工作目录"}
          </button>
        </div>
      )}
      <p className="root-directory-hint">
        命令在本机执行，非沙箱。分支共享文件，停止任务不会回滚修改。
      </p>
    </section>
  );
  return dialogOpen && onDialogClose ? (
    <DirectoryDialog onClose={onDialogClose}>{editor}</DirectoryDialog>
  ) : (
    editor
  );
}

const modelOptions = (items: ModelOption[]) =>
  [...new Set(items.map((model) => model.provider))].map((provider) => (
    <optgroup
      key={provider}
      label={
        items.find((model) => model.provider === provider)?.providerName ??
        provider
      }
    >
      {items
        .filter((model) => model.provider === provider)
        .map((model) => (
          <option
            key={model.id}
            value={model.id}
            disabled={!model.available}
            title={modelContextTitle(model)}
          >
            {model.name} · {formatContextWindow(model.contextWindow)}
            {model.demo ? " · 演示" : !model.available ? " · 未连接" : ""}
          </option>
        ))}
    </optgroup>
  ));

export function ComposerModelControls({
  models,
  config,
  onConfigChange,
  disabled = false,
}: {
  models: ModelOption[];
  config: RunConfig;
  onConfigChange: (config: RunConfig) => void;
  disabled?: boolean;
}) {
  const selectedModel = models.find((model) => model.id === config.model);
  return (
    <div
      className="model-controls"
      role="group"
      aria-label="本轮模型与思考设置"
    >
      <label
        className="model-select"
        title={`执行模型：${selectedModel?.name ?? config.model} · ${modelContextTitle(selectedModel)}`}
      >
        <span className="pi-small">π</span>
        <select
          aria-label="选择模型"
          title={`${selectedModel?.name ?? config.model} · ${modelContextTitle(selectedModel)}`}
          value={config.model}
          disabled={disabled}
          onChange={(event) => {
            const next = models.find(
              (model) => model.id === event.target.value,
            );
            if (!next) return;
            onConfigChange({
              model: next.id,
              thinking: next.thinkingLevels.includes(config.thinking)
                ? config.thinking
                : next.thinkingLevels.includes("medium")
                  ? "medium"
                  : next.thinkingLevels[0],
            });
          }}
        >
          {!selectedModel && (
            <option value={config.model} disabled>
              {config.model} · 未知 · 不可用
            </option>
          )}
          {modelOptions(models)}
        </select>
        <ChevronDown size={11} />
      </label>
      <label className="thinking-select" title="思考深度">
        <Zap size={12} />
        <select
          aria-label="思考强度"
          value={config.thinking}
          disabled={disabled}
          onChange={(event) =>
            onConfigChange({
              ...config,
              thinking: event.target.value as RunConfig["thinking"],
            })
          }
        >
          {(selectedModel?.thinkingLevels ?? [config.thinking]).map((level) => (
            <option key={level} value={level}>
              {thinkingLabels[level]}
            </option>
          ))}
        </select>
        <ChevronDown size={11} />
      </label>
    </div>
  );
}

export function WorkbenchControls({
  models,
  approvalMode,
  safetyModel,
  onApprovalModeChange,
  onSafetyModelChange,
  disabled = false,
  approvalBusy = false,
  safetyModelRequired = false,
}: {
  models: ModelOption[];
  approvalMode: ApprovalMode;
  safetyModel: string;
  onApprovalModeChange: (mode: ApprovalMode) => void;
  onSafetyModelChange: (model: string) => void;
  disabled?: boolean;
  approvalBusy?: boolean;
  safetyModelRequired?: boolean;
}) {
  const safetyOptions = models.filter((model) => !model.demo);
  const selectedSafetyModel = safetyOptions.find(
    (model) => model.id === safetyModel,
  );
  const safetyRef = useRef<HTMLSelectElement>(null);
  useEffect(() => {
    if (safetyModelRequired) safetyRef.current?.focus();
  }, [safetyModelRequired]);
  return (
    <div className="workbench-controls" role="group" aria-label="运行设置">
      <div className="toolbar-approval-controls">
        <ApprovalModeSwitch
          mode={approvalMode}
          onChange={onApprovalModeChange}
          disabled={disabled || approvalBusy}
        />
        <label className="toolbar-field toolbar-safety-field">
          <span>
            <ShieldCheck size={12} /> 安全模型
          </span>
          <select
            ref={safetyRef}
            aria-label="选择安全模型"
            aria-invalid={safetyModelRequired || undefined}
            aria-describedby={
              safetyModelRequired ? "safety-model-required-hint" : undefined
            }
            title={`${selectedSafetyModel?.name ?? "安全模型"} · ${modelContextTitle(selectedSafetyModel)}。独立审核每次工具调用，通过后才执行；审核产生额外模型用量。`}
            value={safetyModel}
            disabled={disabled || approvalBusy}
            onChange={(event) => onSafetyModelChange(event.target.value)}
          >
            <option value="" disabled={approvalMode === "auto"}>
              选择安全模型
            </option>
            {safetyModel &&
              !safetyOptions.some((model) => model.id === safetyModel) && (
                <option value={safetyModel} disabled>
                  {safetyModel} · 未知 · 不可用
                </option>
              )}
            {modelOptions(safetyOptions)}
          </select>
        </label>
      </div>
      {safetyModelRequired && (
        <p
          className="toolbar-settings-hint"
          id="safety-model-required-hint"
          role="alert"
        >
          请先选择可用的安全模型，再开启自动审批。
        </p>
      )}
    </div>
  );
}
