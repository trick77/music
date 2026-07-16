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
export const NO_DISMISS_SELECTOR = 'button, a, input, select, textarea, label, [role="button"], [data-player-ui]';

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

// useBackgroundDismiss returns props for an immersive view's root element.
//
// Dismissal needs BOTH the press and the release to land on background. Without
// that, dragging the seek slider and letting go over the backdrop — an easy miss
// on a touch screen — would close the view mid-scrub.
export function useBackgroundDismiss(onDismiss: () => void) {
  const pressedBackground = useRef(false);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      pressedBackground.current = isBackgroundTarget(e.target);
    },
    onClick: (e: React.MouseEvent) => {
      const dismiss = pressedBackground.current && isBackgroundTarget(e.target);
      pressedBackground.current = false;
      if (dismiss) onDismiss();
    },
  };
}
