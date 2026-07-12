import { navigate, type Route } from "./router";
import { Glyph, type GlyphName } from "./Glyph";

type Item = { key: string; icon: GlyphName; label: string; path: string; match: (r: Route) => boolean };

const ITEMS: Item[] = [
  { key: "home", icon: "home", label: "Home", path: "/", match: (r) => r.name === "home" },
  { key: "search", icon: "search", label: "Search", path: "/search", match: (r) => r.name === "search" },
  { key: "genres", icon: "disc", label: "Genres", path: "/genres", match: (r) => r.name === "genres" || r.name === "genre" },
  { key: "library", icon: "library", label: "Library", path: "/library", match: (r) => r.name === "library" || r.name === "favorites" },
  { key: "playlists", icon: "playlist", label: "Playlists", path: "/playlists", match: (r) => r.name === "playlists" },
];

// AccountSlot is the unobtrusive owner affordance in the rail's top avatar
// position. In dev mode it stays a decorative accent mark (autologin, nothing to
// do). In oidc mode it is a plain accent avatar that links to login when
// anonymous and to logout when signed in — no lock icon, no visible "sign in"
// copy, so an anonymous visitor sees nothing more than an avatar dot.
function AccountSlot({ authMode, authenticated, username }: { authMode?: string; authenticated: boolean; username: string }) {
  const base = { width: 28, height: 28, borderRadius: 999, background: "var(--color-accent)", marginBottom: "0.75rem" } as const;
  if (authMode !== "oidc") {
    return <span aria-hidden style={{ ...base, borderRadius: 8 }} />;
  }
  const href = authenticated ? "/api/auth/logout" : "/api/auth/login";
  const label = authenticated ? "Log out" : "Log in";
  return (
    <a
      href={href}
      aria-label={label}
      title={label}
      style={{ ...base, display: "grid", placeItems: "center", color: "var(--color-ink)", textDecoration: "none", fontFamily: "var(--font-serif)", fontSize: "var(--text-label)", fontWeight: 600 }}
    >
      {authenticated && username ? username.charAt(0).toUpperCase() : null}
    </a>
  );
}

// Rail is the slim, icon-only left navigation on desktop and a bottom tab bar on
// mobile. No wordmark (spec §15). The Upload action appears when authenticated;
// the Studio slot appears only when authenticated AND Studio is configured
// (studioEnabled) — a key-less instance shows nothing there (spec §2, presence
// vs absence). The rail intentionally stays on the SVG <Glyph> set (Phase 8).
export function Rail({ route, authenticated, studioEnabled = false, authMode, username = "", onUpload, onQueue }: { route: Route; authenticated: boolean; studioEnabled?: boolean; authMode?: string; username?: string; onUpload: () => void; onQueue: () => void }) {
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
        style={{ flex: 1, display: "grid", placeItems: "center", gap: 2, background: "none", border: "none", color: active ? "var(--color-accent-fill)" : "var(--color-muted)", cursor: "pointer", padding: "0.5rem 0" }}
      >
        <Glyph name={it.icon} size={22} />
        <span style={{ fontSize: "var(--text-micro)" }}>{it.label}</span>
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
        <AccountSlot authMode={authMode} authenticated={authenticated} username={username} />
        {ITEMS.map(desktopItem)}
        <button aria-label="Queue" title="Queue" onClick={onQueue} style={{ display: "grid", placeItems: "center", width: 44, height: 44, borderRadius: 12, background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer" }}>
          <Glyph name="queue" size={22} />
        </button>
        {authenticated && (
          <button aria-label="Upload" onClick={onUpload} style={{ display: "grid", placeItems: "center", width: 44, height: 44, borderRadius: 12, background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer" }}>
            <Glyph name="upload" size={22} />
          </button>
        )}
        {authenticated && studioEnabled && desktopItem({ key: "studio", icon: "spark", label: "Studio", path: "/studio", match: (r) => r.name === "studio" })}
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
        <button
          key="queue"
          aria-label="Queue"
          onClick={onQueue}
          style={{ flex: 1, display: "grid", placeItems: "center", gap: 2, background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", padding: "0.5rem 0" }}
        >
          <Glyph name="queue" size={22} />
          <span style={{ fontSize: "var(--text-micro)" }}>Queue</span>
        </button>
        {authenticated && studioEnabled && tabItem({ key: "studio", icon: "spark", label: "Studio", path: "/studio", match: (r) => r.name === "studio" })}
        {authenticated && tabItem({ key: "upload", icon: "upload", label: "Upload", path: "__upload", match: () => false })}
      </nav>
    </>
  );
}
