import type { TurnNode } from "../shared/types";

export const MAX_CARD_REFERENCES = 20;

export type CardReferenceQuery = { start: number; end: number; text: string };

/** Only inspect the text before the caret, leaving the rest of the draft intact. */
export function cardReferenceQuery(
  value: string,
  start: number,
  end = start,
): CardReferenceQuery | null {
  if (start !== end) return null;
  const before = value.slice(0, start);
  const marker = before.lastIndexOf("@");
  if (marker < 0 || (marker > 0 && /[\w.]/.test(before[marker - 1]))) {
    return null;
  }
  const text = before.slice(marker + 1);
  // Completed references have explicit brackets so ordinary follow-up text
  // cannot accidentally reopen the picker after a selection.
  if (text.length > 100 || /[\n\r@「」]/.test(text)) return null;
  return { start: marker, end: start, text };
}

export function cardReferenceTitle(node: Pick<TurnNode, "prompt">): string {
  const title = node.prompt.replace(/\s+/g, " ").trim() || "无文字问题";
  return title.length > 42 ? `${title.slice(0, 42)}…` : title;
}

export function cardReferenceLabel(node: Pick<TurnNode, "prompt">): string {
  return `@「${cardReferenceTitle(node)}」`;
}

export function filterCardReferences(
  candidates: TurnNode[],
  query: string,
): TurnNode[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  return candidates.filter((node) => {
    if (node.status !== "completed" || node.contextStale || seen.has(node.id)) {
      return false;
    }
    seen.add(node.id);
    const text = `${node.prompt}\n${node.response}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function insertCardReference(
  value: string,
  query: CardReferenceQuery,
  node: Pick<TurnNode, "prompt">,
): { value: string; caret: number } {
  const label = `${cardReferenceLabel(node)} `;
  return {
    value: value.slice(0, query.start) + label + value.slice(query.end),
    caret: query.start + label.length,
  };
}
