import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "./Icon";

// HScrollRail wraps a horizontal cover rail (the scrollbar is hidden by design)
// and signals that more content lies off the right edge: the trailing cards fade
// out (.rail-fade) and a › button appears that nudges the rail rightward. Both
// disappear once the rail is scrolled to its end (or when nothing overflows), so
// short rails look exactly as before.
export function HScrollRail({ children, innerStyle }: { children: ReactNode; innerStyle?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);

  const sync = () => {
    const el = ref.current;
    if (!el) return;
    // >1px slack absorbs sub-pixel rounding at the true end of the scroll range.
    setMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
  };

  useEffect(() => {
    sync();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children]);

  const nudge = () => {
    const el = ref.current;
    if (el) el.scrollBy({ left: el.clientWidth * 0.8, behavior: "smooth" });
  };

  return (
    <div style={{ position: "relative" }}>
      <div ref={ref} className={`hscroll${more ? " rail-fade" : ""}`} onScroll={sync} style={{ display: "flex", ...innerStyle }}>
        {children}
      </div>
      {more && (
        <button className="rail-more" aria-label="Scroll right" onClick={nudge}>
          <Icon name="chevronRight" size="20px" />
        </button>
      )}
    </div>
  );
}
