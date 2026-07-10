import type { CSSProperties } from "react";

/**
 * Anthropicons — icon-font component, ported from loom.
 *
 * Renders a glyph from the "Anthropic Icons" variable font (see the @font-face
 * in index.css). Codepoints live in the Private-Use area U+E000–U+E11E and have
 * no speaking names in the font — the mapping below was verified visually in loom.
 *
 * Usage:
 *   <Icon name="star" />
 *   <Icon name="trash" size="19px" label="Delete" />
 */
const CODEPOINTS = {
  send: 0xe09e,
  copy: 0xe056,
  edit: 0xe064,
  feather: 0xe0ed,
  trash: 0xe101,
  search: 0xe0d3,
  settings: 0xe0d6,
  sliders: 0xe070,
  attach: 0xe019,
  stop: 0xe0ec,
  play: 0xe0c4,
  pause: 0xe0bb,
  retry: 0xe11d,
  undo: 0xe11e,
  check: 0xe03b,
  checkCircle: 0xe03c,
  warning: 0xe109,
  spinner: 0xe0c1,
  star: 0xe0e7,
  starFilled: 0xe0e8,
  starOff: 0xe0e9,
  user: 0xe104,
  users: 0xe106,
  folder: 0xe072,
  folderPlus: 0xe074,
  sidebar: 0xe0dd,
  more: 0xe05f,
  chevronDown: 0xe027,
  chevronLeft: 0xe029,
  chevronRight: 0xe02a,
  close: 0xe10f,
  closeCircle: 0xe110,
  message: 0xe037,
  addCircle: 0xe032,
  eye: 0xe069,
  globe: 0xe082,
  clock: 0xe068,
  moreVertical: 0xe062,
  moreHorizontal: 0xe061,
  plus: 0xe001,
  upload: 0xe06d,
  externalLink: 0xe00e,
  volume: 0xe0e4,
  sortUp: 0xe013,
  sortDown: 0xe009,
  allThreads: 0xe060,
  openItems: 0xe0f1,
} as const;

export type IconName = keyof typeof CODEPOINTS;

/** Name → glyph string (for direct use in content/CSS when a component is overkill). */
export const ICONS = Object.fromEntries(
  Object.entries(CODEPOINTS).map(([name, cp]) => [name, String.fromCodePoint(cp)]),
) as Record<IconName, string>;

export function Icon({
  name,
  size = "1.33rem",
  label,
  style,
}: {
  name: IconName;
  /** font-size of the glyph (controls the icon size). loom defaults to 1.33rem. */
  size?: string;
  /** When set, the icon is meaningful (role=img); otherwise it is decorative. */
  label?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        fontFamily: '"Anthropic Icons"',
        fontSize: size,
        lineHeight: 1,
        fontStyle: "normal",
        fontWeight: 400,
        display: "inline-block",
        flexShrink: 0,
        ...style,
      }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {String.fromCodePoint(CODEPOINTS[name])}
    </span>
  );
}
