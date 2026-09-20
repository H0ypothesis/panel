import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { AtSign, Check, X } from "lucide-react";
import type { TurnNode } from "../shared/types";
import {
  MAX_CARD_REFERENCES,
  cardReferenceLabel,
  cardReferenceQuery,
  cardReferenceTitle,
  filterCardReferences,
  insertCardReference,
  type CardReferenceQuery,
} from "./card-reference-input";
import "./card-reference-input.css";

export type CardReferenceInputProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange"
> & {
  value: string;
  onChange: (value: string) => void;
  referenceNodeIds: string[];
  onReferencesChange: (nodeIds: string[]) => void;
  candidates: TurnNode[];
  /** Full canvas order, before availability and search filtering. */
  workspaceNodes: TurnNode[];
  inputRef?: Ref<HTMLTextAreaElement>;
};

export function CardReferenceInput({
  value,
  onChange,
  referenceNodeIds,
  onReferencesChange,
  candidates,
  workspaceNodes,
  inputRef,
  disabled,
  onKeyDown,
  onSelect,
  onBlur,
  onCompositionStart,
  onCompositionEnd,
  ...textareaProps
}: CardReferenceInputProps) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const dismissedQuery = useRef<CardReferenceQuery | null>(null);
  const pendingSelection = useRef<{ value: string; caret: number } | null>(
    null,
  );
  const [query, setQuery] = useState<CardReferenceQuery | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const [notice, setNotice] = useState("");
  const listId = useId();
  const hintId = useId();
  const options = filterCardReferences(candidates, query?.text ?? "");
  const conversationNumbers = new Map(
    workspaceNodes.map((node, index) => [
      node.id,
      String(index).padStart(2, "0"),
    ]),
  );
  const open = Boolean(query) && !disabled;
  const selectedIndex = Math.min(activeIndex, Math.max(0, options.length - 1));
  const uniqueReferences = [...new Set(referenceNodeIds)];
  const atLimit = uniqueReferences.length >= MAX_CARD_REFERENCES;

  const attachInput = useCallback(
    (element: HTMLTextAreaElement | null) => {
      input.current = element;
      if (typeof inputRef === "function") inputRef(element);
      else if (inputRef) inputRef.current = element;
    },
    [inputRef],
  );

  function updateQuery(element: HTMLTextAreaElement) {
    if (
      pendingSelection.current ||
      disabled ||
      document.activeElement !== element
    )
      return;
    const next = cardReferenceQuery(
      element.value,
      element.selectionStart,
      element.selectionEnd,
    );
    const dismissed = dismissedQuery.current;
    // A keyup/selection event can arrive after Escape. Remember that exact
    // query until the user changes text or moves the caret elsewhere.
    if (
      dismissed &&
      next?.start === dismissed.start &&
      next.end === dismissed.end &&
      next.text === dismissed.text
    )
      return;
    dismissedQuery.current = null;
    setQuery((previous) => {
      if (
        previous?.start === next?.start &&
        previous?.end === next?.end &&
        previous?.text === next?.text
      )
        return previous;
      return next;
    });
  }

  function dismissMenu() {
    dismissedQuery.current = query;
    setQuery(null);
  }

  useEffect(() => setActiveIndex(0), [query?.text, query?.start]);
  useEffect(() => {
    if (disabled || !value) setQuery(null);
  }, [disabled, value]);
  useLayoutEffect(() => {
    const pending = pendingSelection.current;
    if (!pending || pending.value !== value || !input.current) return;
    input.current.focus({ preventScroll: true });
    input.current.setSelectionRange(pending.caret, pending.caret);
    pendingSelection.current = null;
  }, [value]);

  useLayoutEffect(() => {
    if (!open) return;
    function positionMenu() {
      const rect = input.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 6;
      const spaceAbove = rect.top - 12;
      const spaceBelow = window.innerHeight - rect.bottom - 12;
      const above = spaceAbove >= Math.min(260, Math.max(180, spaceBelow));
      const maxHeight = Math.max(
        100,
        Math.min(280, above ? spaceAbove : spaceBelow),
      );
      const width = Math.min(Math.max(rect.width, 240), window.innerWidth - 24);
      setMenuStyle({
        width,
        maxHeight,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        ...(above
          ? { bottom: window.innerHeight - rect.top + gap }
          : { top: rect.bottom + gap }),
      });
    }
    positionMenu();
    window.addEventListener("resize", positionMenu);
    document.addEventListener("scroll", positionMenu, true);
    const observer = new ResizeObserver(positionMenu);
    if (input.current) observer.observe(input.current);
    return () => {
      window.removeEventListener("resize", positionMenu);
      document.removeEventListener("scroll", positionMenu, true);
      observer.disconnect();
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      menu.current
        ?.querySelector<HTMLElement>(`[data-option-index="${selectedIndex}"]`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [open, selectedIndex, query?.text]);

  function selectReference(node: TurnNode) {
    if (!query || disabled) return;
    const alreadySelected = uniqueReferences.includes(node.id);
    if (atLimit && !alreadySelected) {
      setNotice(`最多引用 ${MAX_CARD_REFERENCES} 张卡片，请先移除一张。`);
      return;
    }
    const insertion = insertCardReference(value, query, node);
    if (
      textareaProps.maxLength &&
      insertion.value.length > textareaProps.maxLength
    ) {
      setNotice("问题已达到字数上限，请缩短后再引用卡片。");
      return;
    }
    pendingSelection.current = insertion;
    dismissMenu();
    setNotice("");
    onChange(insertion.value);
    if (!alreadySelected) onReferencesChange([...uniqueReferences, node.id]);
  }

  function removeReference(id: string) {
    const node = candidates.find((candidate) => candidate.id === id);
    const remaining = uniqueReferences.filter((candidate) => candidate !== id);
    onReferencesChange(remaining);
    // Keep same-titled mentions if another selected card still owns the label.
    if (
      node &&
      !candidates.some(
        (candidate) =>
          remaining.includes(candidate.id) &&
          cardReferenceLabel(candidate) === cardReferenceLabel(node),
      )
    ) {
      onChange(value.replaceAll(cardReferenceLabel(node), ""));
    }
    setNotice("");
  }

  return (
    <div className="card-reference-input">
      <textarea
        {...textareaProps}
        ref={attachInput}
        value={value}
        disabled={disabled}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && options.length ? `${listId}-${selectedIndex}` : undefined
        }
        aria-describedby={[textareaProps["aria-describedby"], hintId]
          .filter(Boolean)
          .join(" ")}
        onChange={(event) => {
          dismissedQuery.current = null;
          setNotice("");
          onChange(event.target.value);
          updateQuery(event.currentTarget);
        }}
        onSelect={(event) => {
          updateQuery(event.currentTarget);
          onSelect?.(event);
        }}
        onBlur={(event) => {
          dismissMenu();
          onBlur?.(event);
        }}
        onCompositionStart={(event) => {
          composing.current = true;
          onCompositionStart?.(event);
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          updateQuery(event.currentTarget);
          onCompositionEnd?.(event);
        }}
        onKeyDown={(event) => {
          if (
            composing.current ||
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          ) {
            event.stopPropagation();
            return;
          }
          if (open && !event.metaKey && !event.ctrlKey && !event.altKey) {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              dismissMenu();
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              event.stopPropagation();
              if (options.length) {
                const direction = event.key === "ArrowDown" ? 1 : -1;
                setActiveIndex(
                  (selectedIndex + direction + options.length) % options.length,
                );
              }
              return;
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.stopPropagation();
              if (options[selectedIndex])
                selectReference(options[selectedIndex]);
              return;
            }
          }
          onKeyDown?.(event);
        }}
      />
      <span id={hintId} className="card-reference-sr-only">
        输入 @ 选择卡片，将其问题和回答加入上下文；方向键选择，Enter
        确认，Escape 关闭。
      </span>
      {uniqueReferences.length > 0 && (
        <div className="card-reference-selection">
          <span className="card-reference-selection-label">
            引用卡片的问题与回答
          </span>
          <ul aria-label="已引用的卡片" className="card-reference-chips">
            {uniqueReferences.map((id) => {
              const node = candidates.find((candidate) => candidate.id === id);
              const title = node ? cardReferenceTitle(node) : "不可用的卡片";
              return (
                <li
                  key={id}
                  className={`card-reference-chip${node ? "" : " is-unavailable"}`}
                  title={
                    node?.prompt || "卡片已删除或需要重新生成，请移除此引用"
                  }
                >
                  <AtSign size={11} aria-hidden="true" />
                  <span>{title}</span>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`移除卡片引用「${title}」`}
                    onClick={() => removeReference(id)}
                  >
                    <X size={11} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {notice && (
        <p className="card-reference-notice" role="status">
          {notice}
        </p>
      )}
      {open &&
        createPortal(
          <div
            ref={menu}
            className="card-reference-menu nodrag nopan nowheel"
            style={menuStyle}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.preventDefault()}
            onWheel={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="card-reference-menu-heading">
              <strong>
                <AtSign size={13} />
                引用卡片
              </strong>
              <span>
                {uniqueReferences.length}/{MAX_CARD_REFERENCES}
              </span>
            </div>
            <div
              id={listId}
              role="listbox"
              aria-label="选择要引用的卡片"
              className="card-reference-options"
            >
              {options.map((node, index) => {
                const selected = uniqueReferences.includes(node.id);
                return (
                  <button
                    type="button"
                    key={node.id}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === selectedIndex}
                    aria-disabled={atLimit && !selected}
                    tabIndex={-1}
                    data-option-index={index}
                    className={`card-reference-option${index === selectedIndex ? " is-active" : ""}`}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectReference(node)}
                  >
                    <span
                      className={`card-reference-color color-${node.color}`}
                    />
                    <span className="card-reference-option-content">
                      <span className="card-reference-option-heading">
                        <strong>{cardReferenceTitle(node)}</strong>
                        <span className="card-reference-option-meta">
                          {selected && <Check size={12} aria-label="已引用" />}
                          <span className="card-reference-option-number">
                            {conversationNumbers.has(node.id)
                              ? `对话 ${conversationNumbers.get(node.id)}`
                              : "来源已删除"}
                          </span>
                        </span>
                      </span>
                      <span className="card-reference-option-preview">
                        {node.response.replace(/\s+/g, " ").slice(0, 100) ||
                          "暂无文字回答"}
                      </span>
                    </span>
                  </button>
                );
              })}
              {!options.length && (
                <p className="card-reference-empty">
                  {query?.text.trim()
                    ? "没有匹配的卡片，试试其他关键词。"
                    : "暂无可引用的卡片，完成一轮对话后即可引用。"}
                </p>
              )}
            </div>
            <div className="card-reference-menu-footer">
              ↑ ↓ 选择 · Enter 引用 · Esc 关闭
            </div>
          </div>,
          input.current?.closest("dialog") ?? document.body,
        )}
    </div>
  );
}
