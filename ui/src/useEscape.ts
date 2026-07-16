import { useEffect, useRef } from "react";

// useEscape — Escape dismisses whatever is visually on top, and only that.
//
// Every surface with a close X registers here instead of adding its own keydown
// listener: with several open at once (a dialog over the expanded player, say)
// independent listeners would all fire and close the whole stack on one press.
// Handlers live in a module-level stack and only the last one registered — the
// most recently opened, i.e. the topmost — runs.
//
// Deliberately NOT wired to the mini-bar's "Stop and close": Escape dismisses an
// overlay, it never stops playback.

type Entry = { run: () => void };

const stack: Entry[] = [];

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || stack.length === 0) return;
  e.stopPropagation();
  stack[stack.length - 1].run();
}

// enabled lets a caller register unconditionally and stay ordered correctly: a
// surface that is mounted-but-closed holds no slot in the stack. Stack position
// is fixed when the surface opens — the latest onEscape is read through a ref so
// re-renders (an inline arrow prop) can't shuffle a background surface to the top.
export function useEscape(enabled: boolean, onEscape: () => void) {
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    if (!enabled) return;
    if (stack.length === 0) window.addEventListener("keydown", onKey);
    const entry: Entry = { run: () => latest.current() };
    stack.push(entry);
    return () => {
      const i = stack.lastIndexOf(entry);
      if (i !== -1) stack.splice(i, 1);
      if (stack.length === 0) window.removeEventListener("keydown", onKey);
    };
  }, [enabled]);
}
