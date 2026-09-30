import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, ShieldQuestion, Users, X } from "lucide-react";
import type {
  ToolApprovalDecision,
  ToolCall,
  TurnNode,
  Workspace,
} from "../shared/types";
import { ToolCallCard, toolCallLabel, toolCallTarget } from "./CodingControls";
import { agentRuns, roleName } from "./Subagents";

export interface PendingApproval {
  workspace: Workspace;
  node: TurnNode;
  call: ToolCall;
}

function keyOf(item: PendingApproval) {
  return `${item.workspace.id}:${item.node.id}:${item.node.revision ?? 0}:${item.call.id}`;
}

function sourceName({ node, call }: PendingApproval) {
  if (!call.subagentId) return "主代理";
  const runs = agentRuns(node.subagents);
  const index = runs.findIndex((run) => run.id === call.subagentId);
  return index >= 0 ? `子代理 · ${roleName(runs[index], index)}` : "子代理";
}

/** One approval surface for all live cards, independent of the open inspector. */
export function PendingApprovals({
  items,
  onDecision,
  onLocate,
  batchApprovalAvailable,
}: {
  items: PendingApproval[];
  onDecision: (
    item: PendingApproval,
    decision: ToolApprovalDecision,
  ) => Promise<void>;
  onLocate: (item: PendingApproval) => void;
  batchApprovalAvailable: boolean;
}) {
  const [openKey, setOpenKey] = useState<string>();
  const [top, setTop] = useState(16);
  const bar = useRef<HTMLDivElement>(null);
  const selected = items.find((item) => keyOf(item) === openKey);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (openKey && !selected) setOpenKey(undefined);
  }, [openKey, selected]);
  useEffect(() => {
    if (selected) panel.current?.focus();
  }, [openKey]);
  useLayoutEffect(() => {
    if (!openKey || !bar.current) return;
    const anchor = bar.current;
    const reposition = () =>
      setTop(
        Math.max(
          16,
          Math.min(
            anchor.getBoundingClientRect().bottom + 6,
            window.innerHeight - 260,
          ),
        ),
      );
    const observer = new ResizeObserver(reposition);
    observer.observe(anchor);
    if (anchor.previousElementSibling)
      observer.observe(anchor.previousElementSibling);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    reposition();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [openKey]);
  const close = () => {
    setOpenKey(undefined);
    trigger.current?.focus();
  };
  if (!items.length) return null;
  return (
    <div className="pending-approvals" aria-label="待审批操作" ref={bar}>
      <span>
        <ShieldQuestion size={14} />
        {items.length} 项操作等待批准
      </span>
      <div className="pending-approval-list">
        {items.map((item) => {
          const key = keyOf(item);
          const target = toolCallTarget(item.call);
          return (
            <button
              className="pending-approval-trigger"
              type="button"
              key={key}
              aria-expanded={key === openKey}
              title={`${item.workspace.title} · ${item.node.prompt}\n${sourceName(item)} · ${toolCallLabel(item.call)}${target ? `\n${target}` : ""}`}
              onClick={(event) => {
                trigger.current = event.currentTarget;
                setOpenKey(key === openKey ? undefined : key);
              }}
            >
              {item.call.subagentId && <Users size={12} />}
              <b>{sourceName(item)}</b>
              <span>
                {toolCallLabel(item.call)}
                {target ? ` · ${target}` : ""}
              </span>
            </button>
          );
        })}
      </div>
      {selected && (
        <div
          className="pending-approval-panel"
          style={{ top, maxHeight: `min(620px, calc(100dvh - ${top + 16}px))` }}
          role="region"
          aria-label="审批操作详情"
          tabIndex={-1}
          ref={panel}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <div className="pending-approval-heading">
            <b>{sourceName(selected)}</b>
            <button type="button" aria-label="关闭审批详情" onClick={close}>
              <X size={15} />
            </button>
          </div>
          <p className="pending-approval-context">
            {selected.workspace.title} · {selected.node.prompt}
          </p>
          {selected.call.workingDirectory && (
            <p className="pending-approval-directory">
              工作目录：{selected.call.workingDirectory}
            </p>
          )}
          <ToolCallCard
            key={keyOf(selected)}
            call={selected.call}
            batchApprovalAvailable={batchApprovalAvailable}
            onDecision={(_id, decision) => onDecision(selected, decision)}
          />
          <button
            className="pending-approval-locate"
            type="button"
            onClick={() => {
              onLocate(selected);
              setOpenKey(undefined);
            }}
          >
            查看{selected.call.subagentId ? "子代理" : "主代理"}详情
            <ArrowUpRight size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
