import type { CSSProperties } from "react";
import {
  Send, Copy, SquarePen, Feather, Trash2, Search, Settings, SlidersHorizontal,
  Paperclip, Square, Play, Pause, RotateCw, Undo2, Check, CircleCheck, TriangleAlert,
  LoaderCircle, Star, StarOff, User, Users, Folder, FolderPlus, PanelLeft, Ellipsis,
  ChevronDown, ChevronLeft, ChevronRight, ChevronUp, X, CircleX, MessageSquare,
  CirclePlus, Eye, Globe, Clock, EllipsisVertical, Plus, Upload, Download, Share2,
  ExternalLink, Volume2, ArrowUpNarrowWide, ArrowDownWideNarrow, List, ListEnd,
  Music, Shuffle,
  type LucideIcon,
} from "lucide-react";

/**
 * Icon — thin wrapper over lucide-react (ISC-licensed, self-contained SVG).
 *
 * Replaces the former proprietary "Anthropic Icons" variable font: the public
 * surface (name/size/label/style) is unchanged, so every call site — including
 * Menu.tsx's `icon?: IconName` prop — keeps working. Lucide is the same visual
 * language the SVG <Glyph> set was already drawn in (24×24 grid, rounded caps),
 * so nothing needs restyling.
 *
 * Usage:
 *   <Icon name="star" />
 *   <Icon name="trash" size="19px" label="Delete" />
 */
const COMPONENTS = {
  send: Send,
  copy: Copy,
  edit: SquarePen,
  feather: Feather,
  trash: Trash2,
  search: Search,
  settings: Settings,
  sliders: SlidersHorizontal,
  attach: Paperclip,
  stop: Square,
  play: Play,
  pause: Pause,
  retry: RotateCw,
  undo: Undo2,
  check: Check,
  checkCircle: CircleCheck,
  warning: TriangleAlert,
  spinner: LoaderCircle,
  star: Star,
  starFilled: Star, // rendered solid via the FILLED set below
  starOff: StarOff,
  user: User,
  users: Users,
  folder: Folder,
  folderPlus: FolderPlus,
  sidebar: PanelLeft,
  more: Ellipsis,
  chevronDown: ChevronDown,
  chevronLeft: ChevronLeft,
  chevronRight: ChevronRight,
  chevronUp: ChevronUp,
  close: X,
  closeCircle: CircleX,
  message: MessageSquare,
  addCircle: CirclePlus,
  eye: Eye,
  globe: Globe,
  clock: Clock,
  moreVertical: EllipsisVertical,
  moreHorizontal: Ellipsis,
  plus: Plus,
  upload: Upload,
  download: Download,
  share: Share2,
  externalLink: ExternalLink,
  volume: Volume2,
  sortUp: ArrowUpNarrowWide,
  sortDown: ArrowDownWideNarrow,
  allThreads: List,
  openItems: ListEnd,
  music: Music,
  shuffle: Shuffle,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof COMPONENTS;

/** Names rendered as a solid (filled) glyph rather than an outline. */
const FILLED = new Set<IconName>(["starFilled"]);

export function Icon({
  name,
  size = "1.33rem",
  label,
  style,
}: {
  name: IconName;
  /** font-size-equivalent of the glyph (px/rem string). Kept for call-site compat. */
  size?: string;
  /** When set, the icon is meaningful (role=img); otherwise it is decorative. */
  label?: string;
  style?: CSSProperties;
}) {
  const C = COMPONENTS[name];
  return (
    <C
      size={size}
      strokeWidth={1.9}
      fill={FILLED.has(name) ? "currentColor" : "none"}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ display: "inline-block", flexShrink: 0, verticalAlign: "middle", ...style }}
    />
  );
}
