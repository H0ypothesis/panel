import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Code, LoaderCircle, Sparkles } from "lucide-react";
import { responseParts } from "../shared/response-parts";
import type { TurnNode } from "../shared/types";
import { Markdown } from "./Markdown";

function ThinkingBox({
  text,
  active,
  interrupted,
}: {
  text: string;
  active: boolean;
  interrupted: boolean;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const open = expanded ?? active;
  const content = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (open && active && follow.current && content.current)
      content.current.scrollTop = content.current.scrollHeight;
  }, [text, active, open]);

  return (
    <section
      className={`thinking-box${active ? " is-thinking" : ""}`}
      aria-label="思考过程"
    >
      <button
        type="button"
        className="thinking-box-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setExpanded(!open)}
      >
        <Sparkles size={14} aria-hidden="true" />
        <span className="thinking-box-title">思考过程</span>
        <span className="thinking-box-status">
          {active && (
            <LoaderCircle size={11} className="spin" aria-hidden="true" />
          )}
          {active ? "思考中" : interrupted ? "已中断" : "已结束"}
        </span>
        <ChevronDown
          size={13}
          className={open ? "expanded" : ""}
          aria-hidden="true"
        />
      </button>
      {!open && text && (
        <div className="thinking-box-preview" aria-hidden="true">
          {text
            .replace(/[#*`>\n]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 160)}
        </div>
      )}
      <div
        id={id}
        ref={content}
        hidden={!open}
        className="thinking-box-content"
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            32;
        }}
      >
        {text ? (
          <Markdown text={text} />
        ) : (
          <span className="thinking-box-empty">正在思考…</span>
        )}
      </div>
    </section>
  );
}

export function AssistantResponse({
  response,
  thinking,
  status,
}: Pick<TurnNode, "response" | "thinking" | "status">) {
  const running = status === "running";
  const parts = useMemo(
    () => responseParts(response, running),
    [response, running],
  );
  const tagged = parts.filter((part) => part.type === "thinking");
  const toolText = parts.filter((part) => part.type === "tool-call");
  const thoughts = [thinking?.text, ...tagged.map((part) => part.text)]
    .filter((text) => text?.trim())
    .join("\n\n");
  const answer = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  const incomplete = Boolean(
    thinking?.active || tagged.some((part) => !part.complete),
  );

  return (
    <div className="assistant-response">
      {(thoughts || tagged.length > 0) && (
        <ThinkingBox
          text={thoughts}
          active={running && incomplete}
          interrupted={
            !running &&
            incomplete &&
            (status === "cancelled" || status === "failed")
          }
        />
      )}
      {answer.trim() && <Markdown text={answer} />}
      {toolText.length > 0 && (
        <details className="response-tool-text">
          <summary>
            <Code size={13} aria-hidden="true" />
            <span>工具调用原文</span>
            <span className="response-tool-text-count">
              {toolText.length} 段
            </span>
            <ChevronDown size={12} aria-hidden="true" />
          </summary>
          <div>
            <p>模型以文本返回的工具调用片段。执行情况请查看上方工具记录。</p>
            {toolText.map((part, index) => (
              <pre key={index}>
                <code>{part.text}</code>
              </pre>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
