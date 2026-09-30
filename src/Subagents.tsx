import {
  ArrowDown,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Download,
  FileCheck2,
  GitBranch,
  Network,
  Search,
  Settings2,
  Users,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  SubagentRun,
  ToolApprovalDecision,
  TurnNode,
} from "../shared/types";
import { responseText } from "../shared/response-parts";
import { AssistantResponse } from "./AssistantResponse";
import { ToolActivity } from "./CodingControls";
import { subagentMarkdownComponents } from "./SubagentOutput";
import { GenerationIndicator } from "./GenerationIndicator";
import { getGenerationActivity } from "./generation-activity";
import { getSubagentCurves, subagentLoadingKey } from "./subagent-loading";

const roleIcons: Record<string, typeof Search> = {
  scout: Search,
  researcher: Search,
  worker: Code2,
  reviewer: FileCheck2,
  planner: GitBranch,
};
const roleLabels: Record<string, string> = {
  scout: "调查",
  researcher: "研究",
  worker: "执行",
  reviewer: "审查",
  planner: "规划",
};
const statuses = {
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
};

// Native workflow records describe orchestration, not an additional model session.
export function isWorkflowRun(run: SubagentRun) {
  return run.agent === "workflow" && run.id.startsWith("native:");
}
export function agentRuns(runs: SubagentRun[] = []) {
  return runs.filter((run) => !isWorkflowRun(run));
}
export function hasSubagents(node: TurnNode) {
  return !!(
    node.subagentsEnabled ||
    node.subagents?.length ||
    node.toolRequests?.includes("subagents")
  );
}
export function roleName(run: SubagentRun, index: number) {
  return `${roleLabels[run.agent] ?? run.agent} ${index + 1}`;
}
function taskPreview(task: string) {
  if (!task || task === "[prompt redacted]") return "任务说明未公开";
  // Prefer an explicit assignment over a shared prompt preamble; keep the full task below.
  const assignment = task.match(
    /【(?:你的类别|你的任务|任务|分工)】([^\n]+)/,
  )?.[1];
  const followup = task.match(/Follow-up:\s*([^\n]+)/)?.[1];
  return (assignment ?? (followup ? `继续任务：${followup}` : task))
    .replace(/^Task:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}
function download(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Avatar({ run, index }: { run: SubagentRun; index: number }) {
  const Icon = roleIcons[run.agent] ?? Users;
  return (
    <span className={`subagent-avatar tone-${index % 4} ${run.status}`}>
      <Icon size={15} aria-hidden="true" />
      <i aria-hidden="true" />
    </span>
  );
}
function Status({
  run,
  approval = false,
}: {
  run: SubagentRun;
  approval?: boolean;
}) {
  return (
    <span
      className={`subagent-status ${approval ? "needs-approval" : run.status}`}
    >
      <i aria-hidden="true" />
      {approval ? "等待批准" : statuses[run.status]}
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
  const children = agentRuns(runs);
  if (!children.length) {
    const workflow = runs.find(isWorkflowRun);
    return workflow ? (
      <div className="card-subagents nodrag nopan">
        <button
          className="subagent-workflow-launch"
          title="查看任务编排"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(workflow.id);
          }}
        >
          <Network size={14} />
          任务编排 · {statuses[workflow.status]}
        </button>
      </div>
    ) : null;
  }
  const completed = children.filter((run) => run.status === "completed").length;
  return (
    <div
      className="card-subagents nodrag nopan"
      aria-label={`${children.length} 个子代理，${completed} 个完成`}
    >
      <div className="subagent-avatar-stack">
        {children.slice(0, 5).map((run, index) => (
          <button
            key={run.id}
            type="button"
            title={`${roleName(run, index)} · ${statuses[run.status]}\n${taskPreview(run.task)}`}
            aria-label={`查看子代理 ${index + 1}：${taskPreview(run.task)}`}
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
        {children.length > 5 && (
          <button
            type="button"
            className="subagent-overflow"
            aria-label={`查看全部 ${children.length} 个子代理`}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(children[5].id);
            }}
          >
            +{children.length - 5}
          </button>
        )}
      </div>
      <span className="subagent-card-count">
        {completed}/{children.length}
      </span>
    </div>
  );
}

type PanelProps = {
  node: TurnNode;
  selectedId?: string;
  onSelect: (id: string) => void;
  onDecision: (id: string, decision: ToolApprovalDecision) => Promise<void>;
  batchApprovalAvailable: boolean;
  onCommand?: (input: Record<string, unknown>) => Promise<unknown>;
  onAnswer?: (id: string, answer: unknown) => Promise<unknown>;
};

export function SubagentsPanel({
  node,
  selectedId,
  onSelect,
  onDecision,
  batchApprovalAvailable,
  onCommand,
  onAnswer,
}: PanelProps) {
  const runs = node.subagents ?? [];
  const children = agentRuns(runs);
  const workflows = runs.filter(isWorkflowRun);
  const loadingCurves = getSubagentCurves(node.id, children);
  const selected =
    runs.find((run) => run.id === selectedId) ?? children[0] ?? workflows[0];
  const workflow = selected && isWorkflowRun(selected);
  const selectedIndex = selected
    ? children.findIndex((run) => run.id === selected.id)
    : -1;
  const selectedName = selected
    ? workflow
      ? "任务编排"
      : roleName(selected, selectedIndex)
    : "子代理";
  const [overview, setOverview] = useState(!selectedId);
  const [pending, setPending] = useState(0);
  const busy = pending > 0;
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [following, setFollowing] = useState(true);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const previousId = useRef(selected?.id);

  async function send(input: Record<string, unknown>) {
    if (!onCommand) return false;
    setPending((count) => count + 1);
    setError("");
    try {
      const response = await onCommand(input);
      if (
        response &&
        typeof response === "object" &&
        "isError" in response &&
        response.isError
      ) {
        const content =
          "content" in response && Array.isArray(response.content)
            ? response.content
            : [];
        setError(
          content
            .filter(
              (part) => part?.type === "text" && typeof part.text === "string",
            )
            .map((part) => part.text)
            .join("\n") || "操作未完成，请稍后重试。",
        );
        return false;
      }
      const target = runs.find((run) => run.nativeRunId === input.id);
      const name = target
        ? isWorkflowRun(target)
          ? "任务编排"
          : roleName(target, children.indexOf(target))
        : "子代理";
      setFeedback(
        `${name}：${input.action === "stop" ? "停止请求已发送" : input.action === "interrupt" ? "暂停请求已发送" : input.tool === "subagent_detach" ? "后台运行请求已发送" : "指令已发送"}`,
      );
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setPending((count) => count - 1);
    }
  }
  const pendingCalls = (node.toolCalls ?? []).filter(
    (call) =>
      call.status === "awaiting_approval" &&
      (call.subagentId || call.name.startsWith("subagent")),
  );
  const calls = (node.toolCalls ?? []).filter(
    (call) => call.subagentId === selected?.id,
  );
  const otherApprovals = pendingCalls.filter(
    (call) => !selected || call.subagentId !== selected.id,
  );
  const notices = node.subagentNotices ?? [];
  const questions = notices.filter(
    (notice) =>
      notice.kind === "ui-request" &&
      !notices.some(
        (other) =>
          other.kind === "ui-response" &&
          (other.value as { id?: string })?.id ===
            (notice.value as { id?: string })?.id,
      ),
  );
  const completed = children.filter((run) => run.status === "completed").length;
  const failed = children.filter((run) => run.status === "failed").length;
  const active = children.filter((run) =>
    ["running", "queued"].includes(run.status),
  ).length;
  const answer = selected
    ? responseText(selected.response, selected.status === "running")
    : "";

  useEffect(() => {
    if (previousId.current !== selected?.id) {
      previousId.current = selected?.id;
      follow.current = true;
      setFollowing(true);
      setCopied(false);
      setCopyError("");
      scroll.current?.scrollTo({ top: 0 });
    } else if (
      !questions.length &&
      !pendingCalls.length &&
      follow.current &&
      selected?.status === "running"
    ) {
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
    }
  }, [selected?.id, selected?.response, selected?.thinking?.text]);

  return (
    <section className="subagents-panel" aria-label="Subagents 子代理详情">
      <div className="subagents-toolbar">
        <div>
          <Users size={15} />
          <strong>子代理协作</strong>
          <span>{children.length} 个代理</span>
        </div>
        {runs.length > 0 && (
          <button
            className="subagent-quiet-button"
            aria-expanded={overview}
            aria-controls="subagent-overview"
            onClick={() => setOverview(!overview)}
          >
            <ChevronDown size={13} className={overview ? "expanded" : ""} />
            {overview ? "收起分工" : "查看分工"}
          </button>
        )}
      </div>
      <div
        className="subagents-scroll"
        ref={scroll}
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            64;
          setFollowing(follow.current);
        }}
      >
        {onAnswer &&
          questions.map((notice) => (
            <SubagentQuestion
              key={(notice.value as { id: string }).id}
              question={notice.value as NativeQuestion}
              onAnswer={onAnswer}
            />
          ))}
        {otherApprovals.length > 0 && (
          <div className="subagent-attention">
            <strong>有操作需要批准</strong>
            <ToolActivity
              calls={otherApprovals}
              workingDirectory={node.execution?.workingDirectory}
              onDecision={onDecision}
              batchApprovalAvailable={batchApprovalAvailable}
            />
          </div>
        )}
        <div id="subagent-overview" hidden={!overview}>
          {workflows.length > 0 && (
            <div className="subagent-workflows" aria-label="任务编排">
              {workflows.map((run, index) => (
                <button
                  type="button"
                  key={run.id}
                  className={`subagent-workflow-item${selected?.id === run.id ? " selected" : ""}`}
                  aria-pressed={selected?.id === run.id}
                  onClick={() => onSelect(run.id)}
                >
                  <span className="subagent-workflow-icon">
                    <Network size={17} />
                  </span>
                  <span>
                    <b>任务编排{workflows.length > 1 ? ` ${index + 1}` : ""}</b>
                    <small>协调子任务与结果交接</small>
                  </span>
                  <Status run={run} />
                  <ChevronDown size={13} />
                </button>
              ))}
            </div>
          )}
          {children.length > 0 && (
            <>
              <div className="subagent-progress-label">
                <span>执行代理</span>
                <span>
                  {completed} 已完成{active > 0 ? ` · ${active} 进行中` : ""}
                  {failed > 0 ? ` · ${failed} 失败` : ""}
                </span>
              </div>
              <div
                className="subagent-progress-track"
                role="progressbar"
                aria-label="子代理完成进度"
                aria-valuemin={0}
                aria-valuemax={children.length}
                aria-valuenow={completed}
              >
                <span
                  style={{ width: `${(completed / children.length) * 100}%` }}
                />
              </div>
              <div className="subagent-list" aria-label="子代理列表">
                {children.map((run, index) => (
                  <button
                    key={run.id}
                    type="button"
                    aria-pressed={selected?.id === run.id}
                    className={`subagent-list-item${selected?.id === run.id ? " selected" : ""}`}
                    onClick={() => onSelect(run.id)}
                  >
                    <Avatar run={run} index={index} />
                    <span className="subagent-list-text">
                      <b>
                        {roleName(run, index)}
                        <Status
                          run={run}
                          approval={pendingCalls.some(
                            (call) => call.subagentId === run.id,
                          )}
                        />
                      </b>
                      <em title={taskPreview(run.task)}>
                        {run.parentRunId ? "↳ " : ""}
                        {taskPreview(run.task)}
                      </em>
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        {!selected ? (
          <div className="subagents-empty">
            <Users size={26} />
            <strong>等待协作开始</strong>
            <p>
              {node.status === "running" || node.status === "queued"
                ? node.subagentsEnabled
                  ? "已开启，等待主模型分配子任务…"
                  : "本轮将开启子代理协作…"
                : "本轮未创建子代理。"}
            </p>
            <small>分工、执行进度和结果将显示在这里。</small>
          </div>
        ) : (
          <div className="subagent-detail" key={selected.id}>
            <div className="subagent-detail-heading">
              <div>
                {workflow ? (
                  <Network size={17} />
                ) : (
                  <Avatar run={selected} index={selectedIndex} />
                )}
                <strong>{selectedName}</strong>
                <Status
                  run={selected}
                  approval={calls.some(
                    (call) => call.status === "awaiting_approval",
                  )}
                />
              </div>
              {onCommand &&
                selected.nativeRunId &&
                ["running", "queued"].includes(selected.status) && (
                  <details className="subagent-actions-menu">
                    <summary aria-label="运行操作">
                      <Settings2 size={14} />
                      <span>操作</span>
                    </summary>
                    <div>
                      {["running", "queued"].includes(selected.status) && (
                        <>
                          <button
                            onClick={() =>
                              void send({
                                action: "interrupt",
                                id: selected.nativeRunId,
                                index: selected.childIndex,
                              })
                            }
                          >
                            暂停
                          </button>
                          {!selected.background && (
                            <button
                              onClick={() =>
                                void send({
                                  tool: "subagent_detach",
                                  id: selected.nativeRunId,
                                  index: selected.childIndex,
                                })
                              }
                            >
                              转入后台
                            </button>
                          )}
                          <button
                            onClick={() =>
                              void send({
                                action: "stop",
                                id: selected.nativeRunId,
                                index: selected.childIndex,
                              })
                            }
                          >
                            停止
                          </button>
                        </>
                      )}
                    </div>
                  </details>
                )}
            </div>
            <div className="subagent-meta">
              {workflow ? (
                <span>工作流协调器</span>
              ) : (
                <span title={selected.model}>{selected.model}</span>
              )}
              {selected.background && <span>后台运行</span>}
              {selected.usage && !workflow && (
                <span>{selected.usage.total.toLocaleString()} tokens</span>
              )}
            </div>
            {workflow && (
              <p className="subagent-workflow-explanation">
                这里记录整组任务的协调进度。选择上方子代理，可以查看各自的任务和输出。
              </p>
            )}
            {!workflow && (
              <details className="subagent-task-disclosure">
                <summary>
                  <FileCheck2 size={13} />
                  <span>任务与工具</span>
                  <ChevronDown size={13} />
                </summary>
                <div className="subagent-task">
                  {selected.task === "[prompt redacted]"
                    ? "此工作流未公开任务说明。"
                    : selected.task}
                </div>
                <dl className="subagent-config">
                  <dt>角色</dt>
                  <dd>{workflow ? "工作流" : selected.agent}</dd>
                  {selected.workingDirectory && (
                    <>
                      <dt>工作目录</dt>
                      <dd>{selected.workingDirectory}</dd>
                    </>
                  )}
                  {selected.profile && (
                    <>
                      <dt>角色来源</dt>
                      <dd>
                        {selected.profile.source} ·{" "}
                        {selected.profile.description}
                      </dd>
                      <dt>思考强度</dt>
                      <dd>
                        {String(selected.profile.thinking ?? "继承主模型")}
                      </dd>
                      <dt>工具</dt>
                      <dd>
                        {(selected.tools ?? selected.profile.tools)?.join(
                          ", ",
                        ) ?? "Pi 默认工具"}
                      </dd>
                      <dt>技能</dt>
                      <dd>
                        {selected.profile.skills?.join(", ") || "未单独指定"}
                      </dd>
                    </>
                  )}
                </dl>
              </details>
            )}
            {calls.length > 0 && (
              <ToolActivity
                calls={calls}
                workingDirectory={
                  selected.workingDirectory ?? node.execution?.workingDirectory
                }
                onDecision={onDecision}
                batchApprovalAvailable={batchApprovalAvailable}
              />
            )}
            {selected.error && (
              <p className="subagent-error" role="alert">
                {selected.error}
              </p>
            )}
            {workflow ? (
              <div className="subagent-workflow-output">
                <div className="subagent-section-label">
                  <Network size={14} />
                  {selected.status === "completed"
                    ? "编排已结束"
                    : selected.status === "running"
                      ? "正在协调任务"
                      : statuses[selected.status]}
                </div>
                <p>
                  工作流状态表示编排进度。每个子代理的成功、失败和后续恢复记录会单独保留。
                </p>
              </div>
            ) : (
              <>
                <div className="subagent-output-heading">
                  <span>
                    {selected.status === "running" ? "实时输出" : "输出正文"}
                  </span>
                  {answer.trim() && (
                    <div>
                      <button
                        className="subagent-quiet-button"
                        aria-label="复制子代理输出"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(answer);
                            setCopied(true);
                            setCopyError("");
                          } catch {
                            setCopyError("复制失败，可以使用下载保存输出。");
                          }
                        }}
                      >
                        {copied ? <Check size={13} /> : <Copy size={13} />}
                        {copied ? "已复制" : "复制"}
                      </button>
                      <button
                        className="subagent-quiet-button"
                        aria-label="下载子代理输出"
                        onClick={() =>
                          download(
                            answer,
                            `subagent-${selected.id.replace(/[^a-z0-9_-]/gi, "-")}.md`,
                            "text/markdown;charset=utf-8",
                          )
                        }
                      >
                        <Download size={13} />
                        下载
                      </button>
                    </div>
                  )}
                </div>
                {copyError && (
                  <p className="subagent-error" role="alert">
                    {copyError}
                  </p>
                )}
                <div className="subagent-output">
                  <AssistantResponse
                    response={selected.response}
                    thinking={selected.thinking}
                    status={selected.status}
                    defaultThinkingExpanded={false}
                    markdownComponents={subagentMarkdownComponents}
                  />
                </div>
                {selected.status === "running" ||
                selected.status === "queued" ? (
                  <div className="subagent-live-status">
                    <GenerationIndicator
                      key={subagentLoadingKey(selected)}
                      hasResponse={Boolean(selected.response)}
                      active={true}
                      activityKey={
                        getGenerationActivity({
                          ...selected,
                          toolCalls: calls,
                        }).key
                      }
                      curve={loadingCurves.get(subagentLoadingKey(selected))}
                      message={
                        calls.some(
                          (call) => call.status === "awaiting_approval",
                        )
                          ? "等待批准后继续"
                          : calls.some((call) => call.status === "reviewing")
                            ? "安全模型正在审核工具操作…"
                            : selected.status === "queued"
                              ? "已进入队列，等待执行"
                              : "正在处理任务，输出会自动更新"
                      }
                    />
                  </div>
                ) : (
                  !answer.trim() && (
                    <p className="subagent-empty-output">
                      本次运行未产生正文。
                    </p>
                  )
                )}
              </>
            )}
          </div>
        )}
      </div>
      <div className="subagent-feedback" hidden={!error && !busy && !feedback}>
        {error ? (
          <p className="subagent-error" role="alert">
            {error}
          </p>
        ) : (
          <span role="status">
            {busy ? "操作处理中，待批准事项会显示在上方" : feedback}
          </span>
        )}
      </div>
      {!following && selected?.status === "running" && (
        <button
          className="subagent-follow"
          onClick={() => {
            follow.current = true;
            setFollowing(true);
            scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
          }}
        >
          <ArrowDown size={12} />
          回到最新输出
        </button>
      )}
    </section>
  );
}

interface NativeQuestion {
  id: string;
  kind: string;
  title: string;
  value: string | string[];
}
function SubagentQuestion({
  question,
  onAnswer,
}: {
  question: NativeQuestion;
  onAnswer: (id: string, answer: unknown) => Promise<unknown>;
}) {
  const [value, setValue] = useState(
    typeof question.value === "string" && question.kind === "editor"
      ? question.value
      : "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function reply(value: unknown) {
    setBusy(true);
    setError("");
    try {
      await onAnswer(question.id, value);
    } catch (error) {
      setError(String(error));
      setBusy(false);
    }
  }
  return (
    <div className="subagent-question" role="group" aria-label={question.title}>
      <strong>{question.title}</strong>
      {question.kind === "confirm" ? (
        <>
          <p>{question.value}</p>
          <button disabled={busy} onClick={() => void reply(true)}>
            确认
          </button>
        </>
      ) : question.kind === "select" && Array.isArray(question.value) ? (
        question.value.map((option) => (
          <button
            key={option}
            disabled={busy}
            onClick={() => void reply(option)}
          >
            {option}
          </button>
        ))
      ) : (
        <>
          <textarea
            aria-label={question.title}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <button disabled={busy} onClick={() => void reply(value)}>
            提交
          </button>
        </>
      )}
      <button
        disabled={busy}
        onClick={() => void reply(question.kind === "confirm" ? false : null)}
      >
        取消
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
