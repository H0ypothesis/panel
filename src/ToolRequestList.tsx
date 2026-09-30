import { Globe, MousePointer2, Users } from "lucide-react";
import { useId } from "react";
import type {
  ComputerUseTakeoverOptions,
  ToolRequest,
  TurnNode,
} from "../shared/types";
import { TOOL_REQUEST_OPTIONS } from "./card-reference-input";

const computerUseTools = new Set([
  "computer_use_tools",
  "computer_use_call",
  "computer_use_release",
]);

export function canShowComputerUseTakeover(
  node: Pick<TurnNode, "status" | "toolRequests" | "toolCalls">,
) {
  return (
    (node.status === "queued" || node.status === "running") &&
    (node.toolRequests?.includes("computer_use") === true ||
      node.toolCalls?.some((call) => computerUseTools.has(call.name)) === true)
  );
}

const takeoverHint =
  "仅本卡片本轮。查看、截图、后台滚动、移动指针免逐次安全模型审核；点击和输入仍审核。";

export function ToolRequestList({
  requests,
  node,
  takeoverBusy = false,
  takeoverDisabled = false,
  onComputerUseTakeoverChange,
}: {
  requests?: ToolRequest[];
  node?: TurnNode;
  takeoverBusy?: boolean;
  takeoverDisabled?: boolean;
  onComputerUseTakeoverChange?: (
    enabled: boolean,
    options?: ComputerUseTakeoverOptions,
  ) => void;
}) {
  const hintId = useId();
  const taskScope = node?.computerUseTaskScope;
  const currentScope = node?.computerUseScope;
  const taskMode = node?.computerUseTakeover === true && !!taskScope;
  const showTakeover = !!(
    node &&
    onComputerUseTakeoverChange &&
    canShowComputerUseTakeover(node)
  );
  const visibleRequests = [
    ...new Set<ToolRequest>([
      ...(requests ?? []),
      ...(showTakeover ? (["computer_use"] as const) : []),
    ]),
  ];
  if (!visibleRequests.length) return null;
  const pendingApproval = node?.toolCalls?.some(
    (call) =>
      call.status === "reviewing" || call.status === "awaiting_approval",
  );
  return (
    <div className="saved-tool-requests" aria-label="本轮指定工具">
      {visibleRequests.map((request) => {
        const option = TOOL_REQUEST_OPTIONS.find((item) => item.id === request);
        return option ? (
          <div className="saved-tool-request" key={request}>
            <span className="saved-tool-request-badge">
              {request === "web_search" ? (
                <Globe size={11} />
              ) : request === "subagents" ? (
                <Users size={11} />
              ) : (
                <MousePointer2 size={11} />
              )}
              {option.label}
            </span>
            {request === "computer_use" && showTakeover && (
              <label
                className="cua-takeover-toggle"
                title={
                  taskMode
                    ? "本任务控制：仅所选窗口/页面和网站，重要操作仍需批准。"
                    : takeoverHint
                }
              >
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="CUA 接管"
                  aria-describedby={hintId}
                  aria-busy={takeoverBusy}
                  checked={node?.computerUseTakeover === true}
                  disabled={takeoverBusy || takeoverDisabled}
                  onChange={(event) =>
                    onComputerUseTakeoverChange?.(event.target.checked)
                  }
                />
                <span>CUA 接管</span>
                {takeoverBusy && <small role="status">正在更新…</small>}
              </label>
            )}
          </div>
        ) : null;
      })}
      {showTakeover && node?.computerUseTakeover && (
        <div className="cua-task-controls">
          <label>
            接管范围
            <select
              aria-label="CUA 接管模式"
              disabled={takeoverBusy || takeoverDisabled}
              value={taskMode ? "task" : "observe"}
              onChange={(event) =>
                onComputerUseTakeoverChange?.(
                  true,
                  event.target.value === "task"
                    ? { mode: "task", scopeId: currentScope?.id }
                    : { mode: "observe" },
                )
              }
            >
              <option value="observe">基础查看</option>
              <option value="task" disabled={!currentScope}>
                本任务控制
              </option>
            </select>
          </label>
          <span
            className="cua-task-scope"
            title={(taskMode ? taskScope : currentScope)?.label}
          >
            {taskMode
              ? `已授权：${taskScope.label}`
              : currentScope
                ? `可授权：${currentScope.label}`
                : "观察窗口或页面后，可开启本任务控制。"}
          </span>
          {taskMode && currentScope && taskScope.id !== currentScope.id && (
            <span className="cua-task-scope">
              当前目标：{currentScope.label}
            </span>
          )}
          {taskMode && currentScope && taskScope.id !== currentScope.id && (
            <button
              type="button"
              disabled={takeoverBusy || takeoverDisabled}
              onClick={() =>
                onComputerUseTakeoverChange?.(true, {
                  mode: "task",
                  scopeId: currentScope.id,
                })
              }
            >
              改为授权当前目标
            </button>
          )}
        </div>
      )}
      {showTakeover && (
        <p className="cua-takeover-hint" id={hintId}>
          {taskMode
            ? "仅本卡片本轮、所选窗口/页面和网站。查看、滚动、可识别的搜索输入、搜索/翻页及普通链接免逐次审核。发送、付款、删除等重要操作需单次批准；其他输入、坐标点击或越界仍审核。关闭或任务结束即失效。"
            : takeoverHint}
          {pendingApproval && (
            <span>
              从后续符合范围的操作生效，当前审核或待批准操作保持原流程。
            </span>
          )}
        </p>
      )}
    </div>
  );
}
