export type ResponsePart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; complete: boolean }
  | { type: "tool-call"; text: string; complete: boolean };

function pendingProtocolTag(text: string): boolean {
  const prefix = /^<\/?([a-z_]*)(\s*)$/i.exec(text);
  if (!prefix) return false;
  const name = prefix[1].toLowerCase();
  return ["think", "tool_call"].some(
    (tag) => tag.startsWith(name) && (!prefix[2] || tag === name),
  );
}

/** Display-only separation; protocol text can never authorize or execute tools. */
export function responseParts(text: string, streaming = false): ResponsePart[] {
  const parts: ResponsePart[] = [];
  let buffer = "";
  let depth = 0;
  let fence: { marker: string; length: number } | undefined;
  const flush = (complete = false) => {
    if (depth) parts.push({ type: "thinking", text: buffer, complete });
    else if (buffer) parts.push({ type: "text", text: buffer });
    buffer = "";
  };

  for (let index = 0; index < text.length; ) {
    if (index === 0 || text[index - 1] === "\n") {
      const end = text.indexOf("\n", index);
      const line = text.slice(index, end === -1 ? undefined : end + 1);
      const codeLine = line
        .replace(/^(?: {0,3}> ?)+/, "")
        .replace(/^ {0,3}(?:[-+*]|\d+[.)]) +/, "");
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(codeLine);
      if (fence) {
        if (
          marker &&
          marker[1][0] === fence.marker &&
          marker[1].length >= fence.length &&
          !marker[2].trim()
        )
          fence = undefined;
        buffer += line;
        index += line.length;
        continue;
      }
      if (marker && (marker[1][0] !== "`" || !marker[2].includes("`"))) {
        fence = { marker: marker[1][0], length: marker[1].length };
        buffer += line;
        index += line.length;
        continue;
      }
      // Markdown's indented code is also literal.
      if (/^(?: {4}|\t)/.test(line)) {
        buffer += line;
        index += line.length;
        continue;
      }
    }

    if (text[index] === "\\") {
      buffer += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (text[index] === "`") {
      const ticks = /^`+/.exec(text.slice(index))![0];
      const closing = new RegExp(`(?<!\x60)\x60{${ticks.length}}(?!\x60)`, "g");
      closing.lastIndex = index + ticks.length;
      const match = closing.exec(text);
      const end = match
        ? match.index + ticks.length
        : streaming
          ? text.length
          : index + ticks.length;
      buffer += text.slice(index, end);
      index = end;
      continue;
    }
    if (text[index] === "<") {
      const rest = text.slice(index);
      const tool = /^<tool_call\s*>/i.exec(rest);
      if (tool) {
        // Preserve the entire payload as inert text, including broken JSON,
        // HTML, or think tags inside arguments. Do not parse it as an action.
        flush(depth > 0);
        const closing = /<\/tool_call\s*>/gi;
        closing.lastIndex = index + tool[0].length;
        const end = closing.exec(text);
        const next = end ? end.index + end[0].length : text.length;
        parts.push({
          type: "tool-call",
          text: text.slice(index, next),
          complete: Boolean(end),
        });
        index = next;
        continue;
      }
      const tag = /^<(\/?)think\s*>/i.exec(rest);
      if (tag && (!tag[1] || depth > 0)) {
        if (!tag[1]) {
          if (!depth) flush();
          depth++;
        } else {
          if (depth === 1) flush(true);
          depth--;
        }
        index += tag[0].length;
        continue;
      }
      // Hold a tag prefix while its remaining characters are still arriving.
      if (streaming && pendingProtocolTag(rest)) break;
    }
    buffer += text[index++];
  }
  flush();
  return parts;
}

export function responseText(text: string, streaming = false): string {
  return responseParts(text, streaming)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}
