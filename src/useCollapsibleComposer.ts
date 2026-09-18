import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  type TouchEvent,
  type TransitionEvent,
  type UIEvent,
  type WheelEvent,
} from "react";

// A scrollable tool output or code block should consume its own upward gesture.
function scrollsWithin(target: EventTarget | null, boundary: HTMLElement) {
  let element = target instanceof Element ? target : null;
  while (element && element !== boundary) {
    if (
      element.scrollTop > 0 &&
      element.scrollHeight > element.clientHeight &&
      /auto|scroll/.test(getComputedStyle(element).overflowY)
    )
      return true;
    element = element.parentElement;
  }
  return false;
}

export function useCollapsibleComposer(
  contextKey: string,
  enabled: boolean,
  inputRef: RefObject<HTMLTextAreaElement | null>,
) {
  const [collapsed, setCollapsed] = useState(false);
  const composerRef = useRef<HTMLFormElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const focusFrame = useRef<number | null>(null);
  const touchY = useRef<number | null>(null);
  const wheel = useRef({ distance: 0, time: 0 });
  const scrollbar = useRef({ dragging: false, top: 0, distance: 0 });

  useEffect(() => {
    setCollapsed(false);
    touchY.current = null;
    wheel.current = { distance: 0, time: 0 };
    scrollbar.current.dragging = false;
  }, [contextKey, enabled]);

  useEffect(() => {
    const stopDrag = () => {
      scrollbar.current.dragging = false;
    };
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    window.addEventListener("blur", stopDrag);
    return () => {
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
      window.removeEventListener("blur", stopDrag);
      if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    };
  }, []);

  const expand = useCallback(() => {
    setCollapsed(false);
    wheel.current = { distance: 0, time: 0 };
    scrollbar.current.dragging = false;
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = null;
      const input = inputRef.current;
      if (!input || input.closest("[hidden], [inert]")) return;
      input.focus({ preventScroll: true });
      if (window.matchMedia("(max-width: 650px)").matches) {
        input.scrollIntoView({ block: "nearest" });
      }
    });
  }, [inputRef]);

  const collapse = useCallback(() => {
    if (!enabled) return;
    scrollbar.current.dragging = false;
    if (focusFrame.current !== null) {
      cancelAnimationFrame(focusFrame.current);
      focusFrame.current = null;
    }
    if (composerRef.current?.contains(document.activeElement)) {
      toggleRef.current?.focus({ preventScroll: true });
    }
    setCollapsed(true);
  }, [enabled]);

  const onTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (
      event.target === event.currentTarget &&
      event.propertyName === "grid-template-rows" &&
      !collapsed &&
      document.activeElement === inputRef.current &&
      window.matchMedia("(max-width: 650px)").matches
    ) {
      inputRef.current?.scrollIntoView({ block: "nearest" });
    }
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (
      event.ctrlKey ||
      event.deltaY >= 0 ||
      Math.abs(event.deltaX) > Math.abs(event.deltaY) ||
      scrollsWithin(event.target, event.currentTarget)
    ) {
      wheel.current.distance = 0;
      return;
    }
    const now = Date.now();
    if (now - wheel.current.time > 250) wheel.current.distance = 0;
    wheel.current.time = now;
    wheel.current.distance +=
      -event.deltaY *
      (event.deltaMode === 1
        ? 16
        : event.deltaMode === 2
          ? event.currentTarget.clientHeight
          : 1);
    if (wheel.current.distance >= 16) collapse();
  };

  const onTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    touchY.current =
      event.touches.length === 1 ? event.touches[0].clientY : null;
  };

  const onTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1 || touchY.current === null) return;
    const next = event.touches[0].clientY;
    if (
      next - touchY.current >= 16 &&
      !scrollsWithin(event.target, event.currentTarget)
    ) {
      collapse();
      touchY.current = next;
    } else if (next < touchY.current) {
      touchY.current = next;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      !(target instanceof HTMLElement) ||
      target.closest("input, textarea, select, [contenteditable]") ||
      (event.key === " " && target.closest("button, summary, a"))
    )
      return;
    if (
      ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
      (event.key === " " && event.shiftKey)
    ) {
      if (!scrollsWithin(target, event.currentTarget)) collapse();
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Native scrollbar drags target the scroller itself, not its content.
    if (
      event.pointerType === "mouse" &&
      event.button === 0 &&
      event.target === event.currentTarget
    ) {
      scrollbar.current = {
        dragging: true,
        top: event.currentTarget.scrollTop,
        distance: 0,
      };
    }
  };

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const drag = scrollbar.current;
    if (!drag.dragging) return;
    const top = event.currentTarget.scrollTop;
    drag.distance = top < drag.top ? drag.distance + drag.top - top : 0;
    drag.top = top;
    if (drag.distance >= 16) collapse();
  };

  return {
    collapsed: enabled && collapsed,
    composerRef,
    toggleRef,
    expand,
    collapse,
    onTransitionEnd,
    readingHandlers: {
      onWheel,
      onTouchStart,
      onTouchMove,
      onTouchEnd: () => {
        touchY.current = null;
      },
      onTouchCancel: () => {
        touchY.current = null;
      },
      onKeyDown,
      onPointerDown,
      onScroll,
    },
  };
}
