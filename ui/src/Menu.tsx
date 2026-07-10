import { useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";

// Shared context-menu surface + item, mirroring loom's ThreadActionsMenu exactly:
// warm-charcoal surface (#363632 / border #454540), inset rounded hover fill baked
// into every entry (#3f3f3a) so no entry can forget it, a leading icon in a 21px
// grid at 19px, and the destructive entry in loom's danger treatment (#ec7e7e
// resting text, #d03b3b fill + white on hover).
export const MENU_SURFACE_BG = "#363632";
export const MENU_SURFACE_BORDER = "#454540";
export const MENU_ITEM_INK = "#f3f0e8";
export const MENU_ITEM_HOVER = "#3f3f3a";
export const MENU_SEPARATOR = "#4a4741";
export const MENU_DANGER_INK = "#ec7e7e";
export const MENU_DANGER_FILL = "#d03b3b";

export const menuSurface: React.CSSProperties = {
  minWidth: 210,
  background: MENU_SURFACE_BG,
  border: `1px solid ${MENU_SURFACE_BORDER}`,
  borderRadius: 10,
  padding: "4px 0",
  boxShadow: "0 18px 32px rgba(0,0,0,0.38)",
  overflow: "hidden",
};

export function MenuSeparator() {
  return <div role="separator" style={{ height: 1, background: MENU_SEPARATOR, margin: "5px 14px" }} />;
}

type MenuItemProps = {
  icon?: IconName;
  danger?: boolean;
  href?: string;
  onClick?: () => void;
  children: React.ReactNode;
  trailing?: React.ReactNode;
};

export function MenuItem({ icon, danger, href, onClick, children, trailing }: MenuItemProps) {
  const [hover, setHover] = useState(false);
  const style: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    minHeight: 30,
    padding: "4px 12px",
    margin: "0 4px",
    borderRadius: 6,
    width: "calc(100% - 8px)",
    textAlign: "left",
    cursor: "pointer",
    fontSize: "0.9rem",
    border: "none",
    textDecoration: "none",
    transition: "background .12s, color .12s",
    background: hover ? (danger ? MENU_DANGER_FILL : MENU_ITEM_HOVER) : "transparent",
    color: danger ? (hover ? "#fff" : MENU_DANGER_INK) : MENU_ITEM_INK,
  };
  const inner = (
    <>
      <span aria-hidden style={{ display: "grid", placeItems: "center", width: 21, height: 21, flexShrink: 0 }}>
        {icon && <Icon name={icon} size="19px" />}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {trailing !== undefined && <span style={{ flexShrink: 0, opacity: 0.7 }}>{trailing}</span>}
    </>
  );
  const handlers = {
    role: "menuitem" as const,
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
  };
  if (href) return <a href={href} style={style} {...handlers}>{inner}</a>;
  return <button type="button" style={style} onClick={onClick} {...handlers}>{inner}</button>;
}

// useMenuPlacement flips a menu above its trigger when it would overflow the
// viewport bottom, so a menu opened on a bottom row is never truncated (loom).
export function useMenuPlacement<T extends HTMLElement>() {
  const menuRef = useRef<T>(null);
  const [dropUp, setDropUp] = useState(false);
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setDropUp(rect.bottom > window.innerHeight - 8 && rect.top - rect.height > 8);
  }, []);
  return { menuRef, dropUp };
}
