import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "./Icon";

// HScrollRail wraps a horizontal cover rail (the scrollbar is hidden by design)
// and signals where more content lies: whichever edge has off-screen cards fades
// out and grows a ‹/› button that nudges the rail that way. Indicators appear
// only for the directions that can actually scroll, so a short (non-overflowing)
// rail looks exactly as before, and a mid-scrolled rail shows both.
export function HScrollRail({ children, innerStyle, coverSize }: { children: ReactNode; innerStyle?: CSSProperties; coverSize?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const sync = () => {
    const el = ref.current;
    if (!el) return;
    // >1px slack absorbs sub-pixel rounding at either true end of the range.
    setEdges({
      left: el.scrollLeft > 1,
      right: el.scrollWidth - el.clientWidth - el.scrollLeft > 1,
    });
  };

  useEffect(() => {
    sync();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children]);

  const nudge = (dir: 1 | -1) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: "smooth" });
  };

  const { left, right } = edges;
  // Fade only the edges that can scroll, keeping the gradient stops roughly under
  // the ‹/› buttons so the chevrons sit in the faded band.
  const mask =
    left && right
      ? "linear-gradient(90deg, transparent, #000 12%, #000 88%, transparent)"
      : right
        ? "linear-gradient(90deg, #000 82%, transparent)"
        : left
          ? "linear-gradient(90deg, transparent, #000 18%)"
          : undefined;

  return (
    <div
      style={
        {
          position: "relative",
          // Center the ‹/› buttons on the cover art, not the whole tile (art +
          // title + artist). Falls back to 50% when the rail's tiles aren't
          // fixed-height covers.
          ...(coverSize ? { "--rail-art-center": `${coverSize / 2}px` } : {}),
        } as CSSProperties
      }
    >
      <div
        ref={ref}
        className="hscroll"
        onScroll={sync}
        style={{ display: "flex", ...innerStyle, WebkitMaskImage: mask, maskImage: mask }}
      >
        {children}
      </div>
      {left && (
        <button className="rail-more rail-more-left" aria-label="Scroll left" onClick={() => nudge(-1)}>
          <Icon name="chevronLeft" size="20px" />
        </button>
      )}
      {right && (
        <button className="rail-more rail-more-right" aria-label="Scroll right" onClick={() => nudge(1)}>
          <Icon name="chevronRight" size="20px" />
        </button>
      )}
    </div>
  );
}
