import type { ContextReference, TurnNode } from "../shared/types";
import { ArrowUpRight, AtSign } from "lucide-react";
import { AssistantResponse } from "./AssistantResponse";
import "./card-reference-list.css";

/** Show the saved input, even when the source has since changed or disappeared. */
export function CardReferenceList({
  references,
  nodes,
  onLocate,
}: {
  references: ContextReference[];
  nodes: TurnNode[];
  onLocate: (id: string) => void;
}) {
  if (!references.length) return null;
  return (
    <section className="card-reference-list" aria-label="本轮引用的卡片">
      <div className="card-reference-list-heading">
        <AtSign size={14} />
        <b>引用卡片 · {references.length}</b>
        <span>引用时的内容快照</span>
      </div>
      {references.map((reference) => {
        const sourceIndex = nodes.findIndex(
          (node) => node.id === reference.nodeId,
        );
        const source = nodes[sourceIndex];
        const changed = source && (source.revision ?? 0) !== reference.revision;
        return (
          <details key={reference.nodeId} className="card-reference-snapshot">
            <summary title={reference.prompt}>
              <span className="card-reference-snapshot-number">
                {source
                  ? `对话 ${String(sourceIndex).padStart(2, "0")}`
                  : "来源已删除"}
              </span>
              {reference.prompt || "未命名卡片"}
            </summary>
            <div className="card-reference-snapshot-body">
              <div className="card-reference-origin">
                <span>
                  来源版本 {reference.revision} ·{" "}
                  {!source
                    ? "来源已删除，快照保留"
                    : changed
                      ? "来源已更新，本轮使用此前快照"
                      : "已保存来源问题与回答"}
                </span>
                {source && (
                  <button type="button" onClick={() => onLocate(source.id)}>
                    定位来源
                    <ArrowUpRight size={12} />
                  </button>
                )}
              </div>
              <b>问题</b>
              <p className="card-reference-question">{reference.prompt}</p>
              <b>回答</b>
              <AssistantResponse
                response={reference.response || "（空回答）"}
                status="completed"
              />
            </div>
          </details>
        );
      })}
    </section>
  );
}
