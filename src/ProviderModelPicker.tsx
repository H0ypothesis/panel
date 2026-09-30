import { useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export function ProviderModelPicker({
  value,
  models,
  onChange,
  disabled = false,
}: {
  value: string;
  models: { id: string; name: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = models.filter((model) =>
    `${model.id} ${model.name}`.toLowerCase().includes(query.toLowerCase()),
  );
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));
  const choose = (id: string) => {
    if (disabled) return;
    onChange(id);
    setOpen(false);
    setQuery("");
  };
  return (
    <div
      className="provider-model-picker"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className="provider-model-input">
        <input
          ref={input}
          id="provider-model"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={
            open && matches.length ? `${listId}-${activeIndex}` : undefined
          }
          aria-describedby="provider-model-hint"
          required
          disabled={disabled}
          maxLength={240}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder="选择或输入模型 ID"
          onFocus={() => {
            setOpen(true);
            setQuery("");
            setActive(0);
          }}
          onChange={(event) => {
            onChange(event.target.value);
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              const next = open
                ? Math.max(
                    0,
                    Math.min(
                      matches.length - 1,
                      activeIndex + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  )
                : 0;
              setActive(next);
              requestAnimationFrame(() =>
                document
                  .getElementById(`${listId}-${next}`)
                  ?.scrollIntoView({ block: "nearest" }),
              );
            }
            if (event.key === "Enter" && open) {
              event.preventDefault();
              if (matches.length) choose(matches[activeIndex].id);
              else setOpen(false);
            }
          }}
        />
        <button
          type="button"
          disabled={disabled}
          aria-label="展开模型列表"
          title="展开模型列表"
          aria-expanded={open}
          aria-controls={listId}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            input.current?.focus();
            setQuery("");
            setActive(0);
            setOpen(!open);
          }}
        >
          <ChevronDown size={16} />
        </button>
      </div>
      {open && !disabled && (
        <ul
          id={listId}
          role="listbox"
          aria-label="模型列表"
          className="provider-model-options"
        >
          {matches.length ? (
            matches.map((model, index) => (
              <li
                key={model.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={model.id === value}
                className={index === activeIndex ? "is-active" : ""}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(model.id)}
              >
                <span>
                  <b>{model.id}</b>
                  {model.name !== model.id && <small>{model.name}</small>}
                </span>
                {model.id === value && <Check size={14} />}
              </li>
            ))
          ) : (
            <li className="provider-model-empty" role="presentation">
              没有匹配项
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
