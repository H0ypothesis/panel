import type {
  RunConfig,
  ToolCall,
  ToolRequest,
  TurnNode,
} from "../shared/types";
import { automaticLongTask } from "./run-config";

const longTaskHint = "允许超过40次模型回复；使用电脑控制时自动开启";

export function LongTaskToggle({
  config,
  toolRequests,
  disabled = false,
  onConfigChange,
}: {
  config: RunConfig;
  toolRequests?: ToolRequest[];
  disabled?: boolean;
  onConfigChange: (config: RunConfig) => void;
}) {
  const automatic = automaticLongTask(toolRequests);
  return (
    <div className="long-task-setting" title={longTaskHint}>
      <label className="long-task-toggle">
        <input
          type="checkbox"
          role="switch"
          aria-label={automatic ? "长程任务，电脑控制自动开启" : "长程任务"}
          checked={automatic || config.longTask === true}
          disabled={disabled || automatic}
          onChange={(event) =>
            onConfigChange({ ...config, longTask: event.target.checked })
          }
        />
        <span>长程任务</span>
        {automatic && <span className="long-task-auto">自动</span>}
      </label>
      <span className="long-task-hint">
        {automatic ? "电脑控制已自动开启" : "允许超过40次模型回复"}
      </span>
    </div>
  );
}

export function LongTaskBadge({
  config,
  status,
  toolRequests,
  toolCalls,
  compact = false,
}: {
  config: RunConfig;
  status: TurnNode["status"];
  toolRequests?: ToolRequest[];
  toolCalls?: ToolCall[];
  compact?: boolean;
}) {
  // Historic computer calls do not prove that that run used the current limit
  // policy. Only persisted manual settings remain visible after completion.
  const automatic =
    (status === "queued" || status === "running") &&
    automaticLongTask(toolRequests, toolCalls);
  if (!config.longTask && !automatic) return null;
  const label = `长程任务${automatic && !config.longTask ? " · 自动" : ""}`;
  return (
    <span
      className="long-task-badge"
      aria-label={label}
      title={`${label}：${longTaskHint}`}
    >
      {compact ? "长程" : label}
    </span>
  );
}
