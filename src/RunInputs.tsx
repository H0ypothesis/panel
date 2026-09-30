import type { RefObject } from "react";
import { ArrowUp, LoaderCircle } from "lucide-react";
import type { RunInput, RunInputMode } from "../shared/types";
import "./run-inputs.css";

export function RunInputHistory({ inputs }: { inputs?: RunInput[] }) {
  if (!inputs?.length) return null;
  return (
    <section className="run-input-history" aria-label="本轮追加消息">
      <b>本轮追加消息</b>
      <ol>
        {inputs.map((input) => (
          <li key={input.id}>
            <div>
              <span>
                {input.mode === "steer" ? "引导当前任务" : "完成后继续"}
              </span>
              <span className={`run-input-status is-${input.status}`}>
                {input.status === "delivered"
                  ? "已接收"
                  : input.status === "cancelled"
                    ? "未送达"
                    : "等待接收"}
              </span>
            </div>
            <p>{input.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function RunInputComposer({
  value,
  mode,
  onChange,
  onModeChange,
  onSend,
  inputRef,
  pending,
  disabled,
  queued,
}: {
  value: string;
  mode: RunInputMode;
  onChange: (text: string) => void;
  onModeChange: (mode: RunInputMode) => void;
  onSend: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  pending: boolean;
  disabled: boolean;
  queued: boolean;
}) {
  return (
    <div className="run-input-composer">
      <div className="compose-box">
        <textarea
          ref={inputRef}
          aria-label="追加任务消息"
          placeholder="补充要求或调整方向…"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={pending}
          maxLength={20000}
          rows={3}
          onKeyDown={(event) => {
            if (
              (event.metaKey || event.ctrlKey) &&
              event.key === "Enter" &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        <div className="compose-bottom">
          <select
            aria-label="追加消息发送方式"
            value={mode}
            disabled={pending}
            onChange={(event) =>
              onModeChange(event.target.value as RunInputMode)
            }
          >
            <option value="steer">引导当前任务</option>
            <option value="followUp">完成后继续</option>
          </select>
          <button
            type="submit"
            className="send-button"
            aria-label="发送追加消息"
            title="发送追加消息（⌘/Ctrl + Enter）"
            disabled={disabled || queued || pending || !value.trim()}
          >
            {pending ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <ArrowUp size={18} />
            )}
          </button>
        </div>
      </div>
      <p className="run-input-hint" role="status">
        {queued
          ? "任务开始后即可发送，草稿会保留。"
          : mode === "steer"
            ? "当前回复和这一轮工具执行结束后，接收你的调整。"
            : "当前任务完成后，在这张卡片中继续处理这条消息。"}
      </p>
    </div>
  );
}
