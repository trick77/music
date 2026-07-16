import { useRef } from "react";

// Tap-anywhere-to-close for the immersive views (big player, karaoke, visualizer):
// tapping the view's background leaves it exactly as its X does. Everything that
// isn't a control counts as background — the scrim, the artwork, the lyrics, the
// title — so the target is big and forgiving on a phone.
//
// What must NEVER close the view: the controls themselves, and the dead space
// around and between them. A button is caught by the element selectors below; the
// gaps beside/between them are covered by marking the whole docked control cluster
// `data-player-ui`, so a near-miss while reaching for pause doesn't dismiss.
export const NO_DISMISS_SELECTOR = 'button, a, input, [role="button"], [data-player-ui]';

// Duck-typed so the rule stays unit-testable without a DOM; the real caller
// always passes an Element.
type ClosestTarget = { closest(selectors: string): unknown };

function hasClosest(t: unknown): t is ClosestTarget {
  return !!t && typeof (t as ClosestTarget).closest === "function";
}

// isBackgroundTarget reports whether a tap on `target` should dismiss the view.
// Anything that isn't (or isn't inside) a control is background.
export function isBackgroundTarget(target: unknown): boolean {
  if (!hasClosest(target)) return true; // not an element — nothing can exclude it
  return !target.closest(NO_DISMISS_SELECTOR);
}

// How far the pointer may travel between press and release and still count as a
// tap. Anything further is a drag — scrubbing, or selecting a line of lyrics —
// and a drag must never dismiss.
export const TAP_SLOP_PX = 5;

export type Press = { x: number; y: number; background: boolean };

// shouldDismiss decides a completed press→release gesture. Pure, so the rule is
// testable without a DOM: both ends must be background, and the pointer must
// have stayed put.
export function shouldDismiss(press: Press | null, release: Press): boolean {
  if (!press || !press.background || !release.background) return false;
  return Math.hypot(release.x - press.x, release.y - press.y) <= TAP_SLOP_PX;
}

// useBackgroundDismiss returns props for an immersive view's root element.
export function useBackgroundDismiss(onDismiss: () => void) {
  const press = useRef<Press | null>(null);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      // Only a primary press can dismiss. Anything else (secondary/middle button,
      // a second finger) clears the record rather than leaving a stale one behind
      // for some later click to consume.
      press.current = e.isPrimary && e.button === 0
        ? { x: e.clientX, y: e.clientY, background: isBackgroundTarget(e.target) }
        : null;
    },
    // A press that never becomes a click — a touch pan, a drag off-window — must
    // not leave its record armed.
    onPointerCancel: () => { press.current = null; },
    onClick: (e: React.MouseEvent) => {
      const p = press.current;
      press.current = null;
      // detail 0 = keyboard-synthesized (Enter/Space on a focused control). Those
      // report clientX/clientY 0,0, which lands on the full-screen root and would
      // read as a background tap. Esc is the keyboard way out, not this.
      if (e.detail === 0) return;
      // NOT e.target: a click's target is the nearest common ancestor of the
      // pressed and released elements, so pressing beside a button and releasing
      // on it reports the root — which would read as background and dismiss
      // instead of pressing the button. Resolve what is actually under the
      // release point.
      const released = typeof document !== "undefined" ? document.elementFromPoint(e.clientX, e.clientY) : null;
      if (shouldDismiss(p, { x: e.clientX, y: e.clientY, background: isBackgroundTarget(released ?? e.target) })) {
        onDismiss();
      }
    },
  };
}
