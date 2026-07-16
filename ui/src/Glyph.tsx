import type { CSSProperties } from "react";
import {
  House, Search, Disc3, Library, Upload, Sparkles,
  Play, Pause, SkipForward, SkipBack, Plus, ListEnd, ListVideo, User,
  type LucideIcon,
} from "lucide-react";

/**
 * Glyph — the immersive-surface icons (rail, home, players, detail, search),
 * now backed by lucide-react like <Icon>. Kept as a distinct component so its
 * numeric `size` (px) call sites stay unchanged; both sets are one library now.
 *
 * 24×24 grid, currentColor, rounded caps — the same look the paths were drawn to.
 */
const COMPONENTS = {
  home: House,
  search: Search,
  disc: Disc3,
  library: Library,
  upload: Upload,
  spark: Sparkles,
  play: Play,
  pause: Pause,
  next: SkipForward,
  prev: SkipBack,
  plus: Plus,
  queue: ListEnd, // same mark the "Add to queue" menu item uses (Icon.openItems)
  playlist: ListVideo,
  user: User,
} satisfies Record<string, LucideIcon>;

export type GlyphName = keyof typeof COMPONENTS;

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
  const C = COMPONENTS[name];
  return (
    <C
      size={size}
      strokeWidth={1.9}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ display: "block", flexShrink: 0, ...style }}
    />
  );
}
