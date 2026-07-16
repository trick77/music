import { useEffect, useRef } from "react";

// useEscape — Escape dismisses whatever is visually on top, and only that.
//
// Every surface with a close X registers here instead of adding its own keydown
// listener: with several open at once (a dialog over the queue drawer, say)
// independent listeners would all fire and close the whole stack on one press.
// Handlers live in a module-level stack and only the last one registered — the
// most recently opened, i.e. the topmost — runs.
//
// Deliberately NOT wired to the mini-bar's "Stop and close": Escape dismisses an
// overlay, it never stops playback.

type Entry = { run: () => void };

const stack: Entry[] = [];

// Exported for tests: the ordering rules below are the whole point of the module,
// and they're pure — no DOM needed to check them.
export function dispatchEscape(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.run();
  return true;
}

export function pushEscape(run: () => void): Entry {
  const entry: Entry = { run };
  stack.push(entry);
  return entry;
}

export function removeEscape(entry: Entry): void {
  const i = stack.lastIndexOf(entry);
  if (i !== -1) stack.splice(i, 1);
}

export function escapeDepth(): number {
  return stack.length;
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Escape") dispatchEscape();
}

// enabled means "this surface is up and blocking", NOT "Escape should act right
// now": a visible surface must hold its slot even when the press should do
// nothing (a save in flight), or Escape falls through to whatever sits beneath
// it. Gate that inside onEscape instead. Stack position is fixed when the
// surface opens — the latest onEscape is read through a ref so re-renders (an
// inline arrow prop) can't shuffle a background surface to the top.
export function useEscape(enabled: boolean, onEscape: () => void) {
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    if (!enabled) return;
    if (stack.length === 0) window.addEventListener("keydown", onKey);
    const entry = pushEscape(() => latest.current());
    return () => {
      removeEscape(entry);
      if (stack.length === 0) window.removeEventListener("keydown", onKey);
    };
  }, [enabled]);
}
