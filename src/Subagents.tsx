import { Code2, FileCheck2, Search, Users } from "lucide-react";
import type {
  SubagentRun,
  ToolApprovalDecision,
  TurnNode,
} from "../shared/types";
import { AssistantResponse } from "./AssistantResponse";
import { ToolActivity } from "./CodingControls";

const roleIcons = { scout: Search, worker: Code2, reviewer: FileCheck2 };
const roleLabels = { scout: "调查", worker: "执行", reviewer: "审查" };
const statuses = {
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
};

export function hasSubagents(node: TurnNode) {
  return !!(
    node.subagentsEnabled ||
    node.subagents?.length ||
    node.toolRequests?.includes("subagents")
  );
}

function Avatar({ run, index }: { run: SubagentRun; index: number }) {
  const Icon = roleIcons[run.agent];
  return (
    <span className={`subagent-avatar tone-${index % 4} ${run.status}`}>
      <Icon size={15} aria-hidden="true" />
      <i aria-hidden="true" />
    </span>
  );
}

export function SubagentAvatars({
  runs,
  onSelect,
}: {
  runs: SubagentRun[];
  onSelect: (id: string) => void;
}) {
  if (!runs.length) return null;
  const completed = runs.filter((run) => run.status === "completed").length;
  return (
    <div
      className="card-subagents nodrag nopan"
      aria-label={`${runs.length} 个子代理，${completed} 个完成`}
    >
      <div className="subagent-avatar-stack">
        {runs.slice(0, 5).map((run, index) => (
          <button
            key={run.id}
            type="button"
            title={`${roleLabels[run.agent]} ${index + 1} · ${statuses[run.status]}\n${run.task}`}
            aria-label={`查看子代理 ${index + 1}：${run.task}`}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(run.id);
            }}
          >
            <Avatar run={run} index={index} />
          </button>
        ))}
        {runs.length > 5 && (
          <button
            type="button"
            className="subagent-overflow"
            aria-label={`查看全部 ${runs.length} 个子代理`}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(runs[5].id);
            }}
          >
            +{runs.length - 5}
          </button>
        )}
      </div>
      <span className="subagent-card-count">
        {completed}/{runs.length}
      </span>
    </div>
  );
}

export function SubagentsPanel({
  node,
  selectedId,
  onSelect,
  onDecision,
  batchApprovalAvailable,
}: {
  node: TurnNode;
  selectedId?: string;
  onSelect: (id: string) => void;
  onDecision: (id: string, decision: ToolApprovalDecision) => Promise<void>;
  batchApprovalAvailable: boolean;
}) {
  const runs = node.subagents ?? [];
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
  if (!selected)
    return (
      <div className="subagents-empty">
        <Users size={26} />
        <strong>Subagents</strong>
        <p>
          {node.status === "running" || node.status === "queued"
            ? node.subagentsEnabled
              ? "已开启，等待主模型分配子任务…"
              : "本轮将开启子代理协作…"
            : "本轮未创建子代理。"}
        </p>
        <small>主模型会根据任务调用子代理，结果将显示在这里。</small>
      </div>
    );
  const calls = (node.toolCalls ?? []).filter(
    (call) => call.subagentId === selected.id,
  );
  return (
    <section className="subagents-panel" aria-label="Subagents 子代理详情">
      <div className="subagents-heading">
        <Users size={15} />
        <b>子代理协作</b>
        <span>{runs.length} 个</span>
      </div>
      <div className="subagent-list" aria-label="子代理列表">
        {runs.map((run, index) => {
          const pending = node.toolCalls?.some(
            (call) =>
              call.subagentId === run.id && call.status === "awaiting_approval",
          );
          return (
            <button
              key={run.id}
              type="button"
              aria-pressed={selected.id === run.id}
              className={`subagent-list-item${selected.id === run.id ? " selected" : ""}`}
              onClick={() => onSelect(run.id)}
            >
              <Avatar run={run} index={index} />
              <span>
                <b>
                  {roleLabels[run.agent]} {index + 1}
                  <small className={pending ? "needs-approval" : ""}>
                    {pending ? "等待批准" : statuses[run.status]}
                  </small>
                </b>
                <em>{run.task}</em>
              </span>
            </button>
          );
        })}
      </div>
      <div className="subagent-detail" key={selected.id}>
        <div className="subagent-meta">
          <span>{selected.agent}</span>
          <span>{selected.model}</span>
          {selected.usage && (
            <span>{selected.usage.total.toLocaleString()} tokens</span>
          )}
        </div>
        <h3>委派任务</h3>
        <p className="subagent-task">{selected.task}</p>
        {calls.length > 0 && (
          <ToolActivity
            calls={calls}
            workingDirectory={node.execution?.workingDirectory}
            onDecision={onDecision}
            batchApprovalAvailable={batchApprovalAvailable}
          />
        )}
        <h3>子代理结果</h3>
        {selected.error && (
          <p className="subagent-error" role="status">
            {selected.error}
          </p>
        )}
        <AssistantResponse
          response={selected.response}
          thinking={selected.thinking}
          status={selected.status}
        />
        {!selected.response && (
          <p className="subagent-empty-output">
            {selected.status === "queued"
              ? "等待其他子代理完成…"
              : selected.status === "running"
                ? "正在处理任务…"
                : "未产生回答。"}
          </p>
        )}
      </div>
    </section>
  );
}
