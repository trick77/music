import { useEffect, useState } from "react";
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * ui — shared design-system primitives (docs/design-system.md).
 *
 * The whole app styles through these instead of ad-hoc inline font sizes:
 * one type scale, one 40px control, three accent roles, one button set.
 */

/** Type scale. Serif for content headings, sans for everything else. */
export const t = {
  display: { fontFamily: "var(--font-serif)", fontWeight: 500, fontSize: "var(--text-display)" },
  title: { fontFamily: "var(--font-serif)", fontWeight: 500, fontSize: "var(--text-title)" },
  body: { fontSize: "var(--text-body)" },
  ui: { fontSize: "var(--text-ui)" },
  label: { fontSize: "var(--text-label)", color: "var(--color-muted)", fontWeight: 500 },
  micro: {
    fontSize: "var(--text-micro)", textTransform: "uppercase",
    letterSpacing: "0.06em", color: "var(--color-muted)",
  },
} satisfies Record<string, CSSProperties>;

/** Field label: 13px muted, 6px above its control. */
export const fieldLabel: CSSProperties = { display: "block", ...t.label, marginBottom: 6 };

/**
 * The 40px form control. Prefer the `ui-control` class (it carries the accent-fill
 * focus ring); `controlStyle` is the same look as an inline object for composition.
 */
export const controlClass = "ui-control";
export const controlStyle: CSSProperties = {
  width: "100%", minHeight: 40, padding: "0 12px",
  background: "var(--color-panel)", border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-ui)", color: "var(--color-ink)",
  fontFamily: "var(--font-sans)", fontSize: "var(--text-ui)", outline: "none",
};

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const variantStyle: Record<ButtonVariant, CSSProperties> = {
  primary: { background: "var(--color-accent-fill)", color: "var(--color-ink)", fontWeight: 600, border: "1px solid transparent" },
  secondary: { background: "var(--color-active)", color: "var(--color-ink)", fontWeight: 500, border: "1px solid var(--color-border)" },
  ghost: { background: "transparent", color: "var(--color-accent-strong)", fontWeight: 500, border: "1px solid transparent" },
  danger: { background: "var(--color-danger)", color: "var(--color-ink)", fontWeight: 600, border: "1px solid transparent" },
};

/** Raw button style object (height 40 / radius 10 / 15px), for call sites that need a style. */
export function buttonStyle(variant: ButtonVariant = "primary", opts?: { small?: boolean }): CSSProperties {
  const small = opts?.small ?? false;
  return {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7,
    height: small ? 32 : 40, padding: small ? "0 12px" : "0 16px",
    borderRadius: "var(--radius-ui)", fontFamily: "var(--font-sans)",
    fontSize: small ? "var(--text-label)" : "var(--text-ui)", cursor: "pointer",
    ...variantStyle[variant],
  };
}

/** Spinner — every async wait spins. */
export function Spinner({ size = "15px" }: { size?: string }) {
  return <span className="ui-spin"><Icon name="spinner" size={size} /></span>;
}

type ButtonProps = {
  variant?: ButtonVariant;
  small?: boolean;
  /** Busy shows a leading spinner and disables the button (label stays, no ellipsis). */
  busy?: boolean;
  children?: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">;

/** Button — the one button primitive. Disabled/busy convention: opacity 0.6, spinner when busy. */
export function Button({ variant = "primary", small, busy, disabled, children, style, ...rest }: ButtonProps) {
  const off = disabled || busy;
  return (
    <button
      {...rest}
      disabled={off}
      style={{
        ...buttonStyle(variant, { small }),
        ...(off ? { opacity: 0.6, cursor: "default" } : null),
        ...style,
      }}
    >
      {busy && <Spinner size={small ? "13px" : "15px"} />}
      {children}
    </button>
  );
}

/**
 * Overlay sizing against the software keyboard.
 *
 * iOS/iPadOS never shrinks the layout viewport when the software keyboard opens — and
 * `dvh` is derived from the layout viewport, so it keeps reporting the full height while
 * the keyboard covers the bottom ~40%. A modal capped at `90dvh` therefore sizes itself
 * into space that isn't on screen, stranding its pinned footer (and any field near the
 * bottom) in a band nothing can reach: scrolling moves content *inside* a box, and every
 * box here has its bottom edge below the fold.
 *
 * WebKit implements neither `interactive-widget=resizes-content` nor the VirtualKeyboard
 * API, so `visualViewport` is the only surface that reports the genuinely visible band.
 * Sizing `.ui-overlay` to it makes `max-height: 100%` on `.ui-modal` mean what it says.
 * Do not "simplify" this back to `dvh` — see docs/design-system.md.
 */
type ViewportReading = Pick<VisualViewport, "offsetTop" | "offsetLeft" | "width" | "height">;

/** Maps a VisualViewport reading to the inline style pinning an overlay to it. */
export function visualViewportBox(vv: ViewportReading | null | undefined): CSSProperties {
  if (!vv) return {}; // unsupported — the stylesheet's `inset: 0` stands unchanged
  return {
    top: vv.offsetTop,
    left: vv.offsetLeft,
    width: vv.width,
    height: vv.height,
    right: "auto", // override `inset: 0`, which would otherwise fight top/left/size
    bottom: "auto",
  };
}

/** True when two boxes describe the same band — lets us skip no-op re-renders. */
export function sameViewportBox(a: CSSProperties, b: CSSProperties): boolean {
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

/**
 * Tracks the visible band. Returns `{}` where visualViewport is unavailable (SSR, older
 * browsers), leaving the CSS to stand. The equality guard matters: iOS fires resize/scroll
 * continuously through the keyboard animation, and re-rendering the whole dialog on every
 * frame is what makes this technique feel janky.
 */
export function useVisualViewportBox(): CSSProperties {
  const [box, setBox] = useState<CSSProperties>({});
  useEffect(() => {
    const vv = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!vv) return;
    const sync = () => {
      const next = visualViewportBox(vv);
      setBox((prev) => (sameViewportBox(prev, next) ? prev : next));
    };
    sync();
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);
  return box;
}
