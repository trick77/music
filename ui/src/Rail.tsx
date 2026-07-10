import { navigate, type Route } from "./router";
import { Glyph, type GlyphName } from "./Glyph";

type Item = { key: string; icon: GlyphName; label: string; path: string; match: (r: Route) => boolean };

const ITEMS: Item[] = [
  { key: "home", icon: "home", label: "Home", path: "/", match: (r) => r.name === "home" },
  { key: "search", icon: "search", label: "Search", path: "/search", match: (r) => r.name === "search" },
  { key: "genres", icon: "disc", label: "Genres", path: "/genres", match: (r) => r.name === "genres" || r.name === "genre" },
  { key: "library", icon: "library", label: "Library", path: "/favorites", match: (r) => r.name === "favorites" || r.name === "playlists" },
];

// Rail is the slim, icon-only left navigation on desktop and a bottom tab bar on
// mobile. No wordmark (spec §15). The Upload action and the greyed "Studio —
// soon" slot appear only when authenticated.
export function Rail({ route, authenticated, onUpload }: { route: Route; authenticated: boolean; onUpload: () => void }) {
  const nav = (path: string) => navigate(path);

  const desktopItem = (it: Item) => {
    const active = it.match(route);
    return (
      <button
        key={it.key}
        aria-label={it.label}
        onClick={() => nav(it.path)}
        style={{
          display: "grid",
          placeItems: "center",
          width: 44,
          height: 44,
          borderRadius: 12,
          background: active ? "var(--color-active)" : "none",
          border: "none",
          color: active ? "var(--color-ink)" : "var(--color-muted)",
          cursor: "pointer",
        }}
      >
        <Glyph name={it.icon} size={22} />
      </button>
    );
  };

  const tabItem = (it: Item) => {
    const active = it.match(route);
    return (
      <button
        key={it.key}
        aria-label={it.label}
        onClick={() => nav(it.path)}
        style={{ flex: 1, display: "grid", placeItems: "center", gap: 2, background: "none", border: "none", color: active ? "var(--color-accent-strong)" : "var(--color-muted)", cursor: "pointer", padding: "0.5rem 0" }}
      >
        <Glyph name={it.icon} size={22} />
        <span style={{ fontSize: "0.65rem" }}>{it.label}</span>
      </button>
    );
  };

  return (
    <>
      {/* Desktop slim rail */}
      <nav
        className="rail-desktop"
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          bottom: 0,
          width: 64,
          flexDirection: "column",
          alignItems: "center",
          gap: "0.4rem",
          padding: "1rem 0",
          background: "var(--color-panel)",
          borderRight: "1px solid var(--color-border)",
          zIndex: 50,
        }}
      >
        <span aria-hidden style={{ width: 28, height: 28, borderRadius: 8, background: "var(--color-accent)", marginBottom: "0.75rem" }} />
        {ITEMS.map(desktopItem)}
        {authenticated && (
          <button aria-label="Upload" onClick={onUpload} style={{ display: "grid", placeItems: "center", width: 44, height: 44, borderRadius: 12, background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer" }}>
            <Glyph name="upload" size={22} />
          </button>
        )}
        {authenticated && (
          <span aria-label="Studio — soon" title="Studio — soon" style={{ display: "grid", placeItems: "center", width: 44, height: 44, borderRadius: 12, color: "color-mix(in srgb, var(--color-muted) 45%, transparent)" }}>
            <Glyph name="spark" size={22} />
          </span>
        )}
      </nav>

      {/* Mobile bottom tab bar */}
      <nav
        className="tabbar-mobile"
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          background: "color-mix(in srgb, var(--color-panel) 95%, transparent)",
          backdropFilter: "blur(12px)",
          borderTop: "1px solid var(--color-border)",
          zIndex: 55,
          paddingBottom: "env(safe-area-inset-bottom, 0)",
        }}
      >
        {ITEMS.map(tabItem)}
        {authenticated && tabItem({ key: "upload", icon: "upload", label: "Upload", path: "__upload", match: () => false })}
      </nav>
    </>
  );
}
