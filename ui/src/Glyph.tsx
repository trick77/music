import type { CSSProperties } from "react";

/**
 * Glyph — inline SVG icons for the immersive Phase 6 surfaces (rail, home,
 * players, detail, search). The Anthropic Icons font lacks home/download/share/
 * heart/skip/disc glyphs, and the design mockup itself uses stroke SVGs, so
 * these match its look. The font-based <Icon> stays in the existing menus.
 *
 * All icons are self-hosted (inline paths — no external assets). 24×24 grid,
 * currentColor stroke.
 */
export type GlyphName =
  | "home"
  | "search"
  | "disc"
  | "library"
  | "upload"
  | "spark"
  | "download"
  | "share"
  | "heart"
  | "heartFilled"
  | "play"
  | "pause"
  | "next"
  | "prev"
  | "plus"
  | "close"
  | "chevronLeft"
  | "chevronUp"
  | "dots";

const PATHS: Record<GlyphName, { fill?: boolean; body: React.ReactNode }> = {
  home: { body: <path d="M3 10.5 12 3l9 7.5M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" /> },
  search: { body: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></> },
  disc: { body: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.5" /></> },
  library: { body: <path d="M4 5v14M9 5v14M14 6l5 13M14 6l-1 .3M14 6 9 7.6" /> },
  upload: { body: <path d="M12 16V4m0 0-5 5m5-5 5 5M4 20h16" /> },
  spark: { body: <path d="M12 3v6m0 6v6M3 12h6m6 0h6M6 6l3 3m6 6 3 3M18 6l-3 3m-6 6-3 3" /> },
  download: { body: <path d="M12 4v12m0 0-5-5m5 5 5-5M4 20h16" /> },
  share: { body: <><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="m8.2 10.8 7.6-3.6m0 9.6L8.2 13.2" /></> },
  heart: { body: <path d="M12 20s-7-4.6-9.2-9C1.4 8 3 4.8 6.2 4.8c2 0 3.2 1.2 3.8 2.2h4c.6-1 1.8-2.2 3.8-2.2 3.2 0 4.8 3.2 3.4 6.2C19 15.4 12 20 12 20Z" /> },
  heartFilled: { fill: true, body: <path d="M12 20s-7-4.6-9.2-9C1.4 8 3 4.8 6.2 4.8c2 0 3.2 1.2 3.8 2.2h4c.6-1 1.8-2.2 3.8-2.2 3.2 0 4.8 3.2 3.4 6.2C19 15.4 12 20 12 20Z" /> },
  play: { fill: true, body: <path d="M7 4.5v15l13-7.5z" /> },
  pause: { body: <path d="M8 4.5v15M16 4.5v15" /> },
  next: { fill: true, body: <path d="M6 4.5v15l10-7.5zM17 4.5v15h2.5v-15z" /> },
  prev: { fill: true, body: <path d="M18 4.5v15L8 12zM7 4.5v15H4.5v-15z" /> },
  plus: { body: <path d="M12 5v14M5 12h14" /> },
  close: { body: <path d="M6 6l12 12M18 6 6 18" /> },
  chevronLeft: { body: <path d="m15 5-7 7 7 7" /> },
  chevronUp: { body: <path d="m5 15 7-7 7 7" /> },
  dots: { fill: true, body: <><circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" /></> },
};

export function Glyph({
  name,
  size = 20,
  label,
  style,
}: {
  name: GlyphName;
  size?: number;
  label?: string;
  style?: CSSProperties;
}) {
  const g = PATHS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={g.fill ? "currentColor" : "none"}
      stroke={g.fill ? "none" : "currentColor"}
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ display: "block", flexShrink: 0, ...style }}
    >
      {g.body}
    </svg>
  );
}
