type Event = { type: string; [key: string]: unknown };

/** The native runner starts its deadline on this event, after the host grants execution. */
export class SubagentExecutionEvents {
  private starts = new Map<
    string,
    { event: Event; listeners: Set<(event: Event) => void> }
  >();

  receive(event: Event, listener: (event: Event) => void) {
    const id = String(event.toolCallId ?? "");
    if (event.type === "tool_execution_start") {
      const pending = this.starts.get(id) ?? { event, listeners: new Set() };
      pending.listeners.add(listener);
      this.starts.set(id, pending);
      return;
    }
    if (
      event.type === "tool_execution_end" ||
      event.type === "tool_result_end"
    ) {
      this.starts.delete(
        id ||
          String((event.message as { toolCallId?: string })?.toolCallId ?? ""),
      );
    }
    listener(event);
  }

  granted(id: string) {
    const pending = this.starts.get(id);
    if (!pending) return;
    this.starts.delete(id);
    for (const listener of pending.listeners) listener(pending.event);
  }

  unsubscribe(listener: (event: Event) => void) {
    for (const pending of this.starts.values())
      pending.listeners.delete(listener);
  }
}
