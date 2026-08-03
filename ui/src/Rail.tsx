import { navigate, type Route } from "./router";
import { Glyph, type GlyphName } from "./Glyph";

type Item = {
  key: string;
  icon: GlyphName;
  label: string;
  path: string;
  match: (r: Route) => boolean;
};

const ITEMS: Item[] = [
  {
    key: "home",
    icon: "home",
    label: "Home",
    path: "/",
    match: (r) => r.name === "home",
  },
  {
    key: "search",
    icon: "search",
    label: "Search",
    path: "/search",
    match: (r) => r.name === "search",
  },
  {
    key: "genres",
    icon: "disc",
    label: "Genres",
    path: "/genres",
    match: (r) => r.name === "genres" || r.name === "genre",
  },
  {
    key: "library",
    icon: "library",
    label: "Library",
    path: "/library",
    match: (r) =>
      r.name === "library" ||
      r.name === "recent" ||
      r.name === "favorites" ||
      r.name === "unpublished",
  },
  {
    key: "playlists",
    icon: "playlist",
    label: "Playlists",
    path: "/playlists",
    match: (r) => r.name === "playlists",
  },
];

// AccountSlot is the owner affordance anchored at the bottom of the rail. In dev
// mode it stays a decorative accent mark (autologin, nothing to do). In oidc mode
// it reads its state at a glance (Option B, ghost ↔ filled): signed out is a hollow
// ring + person glyph that links to login; signed in is a filled accent avatar with
// the username initial and a small presence dot, and clicking it logs out.
function AccountSlot({
  authMode,
  authenticated,
  username,
}: {
  authMode?: string;
  authenticated: boolean;
  username: string;
}) {
  const ring = { width: 32, height: 32, borderRadius: 999 } as const;
  if (authMode !== "oidc") {
    return (
      <span
        aria-hidden
        style={{ ...ring, borderRadius: 8, background: "var(--color-accent)" }}
      />
    );
  }
  if (!authenticated) {
    return (
      <a
        href="/api/auth/login"
        aria-label="Log in"
        title="Log in"
        style={{
          ...ring,
          display: "grid",
          placeItems: "center",
          background: "transparent",
          border: "1.5px solid var(--color-border)",
          color: "var(--color-muted)",
          textDecoration: "none",
        }}
      >
        <Glyph name="user" size={16} />
      </a>
    );
  }
  return (
    <a
      href="/api/auth/logout"
      aria-label="Log out"
      title="Log out"
      style={{
        ...ring,
        position: "relative",
        display: "grid",
        placeItems: "center",
        background: "var(--color-accent)",
        color: "var(--color-ink)",
        textDecoration: "none",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-label)",
        fontWeight: 600,
      }}
    >
      {username ? (
        username.charAt(0).toUpperCase()
      ) : (
        <Glyph name="user" size={16} />
      )}
      <span
        aria-hidden
        style={{
          position: "absolute",
          right: -1,
          bottom: -1,
          width: 9,
          height: 9,
          borderRadius: 999,
          background: "var(--color-online)",
          border: "2px solid var(--color-panel)",
        }}
      />
    </a>
  );
}

// Rail is the slim, icon-only left navigation on desktop and a bottom tab bar on
// mobile. No wordmark (spec §15). The Upload action appears when authenticated;
// the Studio slot appears only when authenticated AND Studio is configured
// (studioEnabled) — a key-less instance shows nothing there (spec §2, presence
// vs absence). The rail intentionally stays on the SVG <Glyph> set (Phase 8).
export function Rail({
  route,
  authenticated,
  studioEnabled = false,
  authMode,
  username = "",
  playerActive = false,
  onUpload,
  onQueue,
}: {
  route: Route;
  authenticated: boolean;
  studioEnabled?: boolean;
  authMode?: string;
  username?: string;
  playerActive?: boolean;
  onUpload: () => void;
  onQueue: () => void;
}) {
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

  // Hairline that separates the rail's purpose groups.
  const Sep = () => (
    <div
      aria-hidden
      style={{
        width: 28,
        height: 1,
        background: "var(--color-border)",
        margin: "4px 0",
      }}
    />
  );

  const iconButton = (label: string, icon: GlyphName, onClick: () => void) => (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        display: "grid",
        placeItems: "center",
        width: 44,
        height: 44,
        borderRadius: 12,
        background: "none",
        border: "none",
        color: "var(--color-muted)",
        cursor: "pointer",
      }}
    >
      <Glyph name={icon} size={22} />
    </button>
  );

  const tabItem = (it: Item) => {
    const active = it.match(route);
    return (
      <button
        key={it.key}
        aria-label={it.label}
        onClick={() => nav(it.path)}
        style={{
          flex: 1,
          display: "grid",
          placeItems: "center",
          gap: 2,
          background: "none",
          border: "none",
          color: active ? "var(--color-accent-fill)" : "var(--color-muted)",
          cursor: "pointer",
          padding: "0.5rem 0",
        }}
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
          // Reserve room for the fixed PlayerBar (~90px) when a track is loaded,
          // so the bottom-anchored Upload/Studio/account block clears it.
          padding: playerActive
            ? "1rem 0 calc(6.5rem + var(--safe-b))"
            : "1rem 0",
          background: "var(--color-panel)",
          borderRight: "1px solid var(--color-border)",
          zIndex: 50,
        }}
      >
        {/* Discover */}
        {ITEMS.slice(0, 3).map(desktopItem)}
        <Sep />
        {/* Your music */}
        {ITEMS.slice(3).map(desktopItem)}
        {iconButton("Queue", "queue", onQueue)}
        {/* Make (owner) + account, anchored to the bottom */}
        <div
          style={{
            marginTop: "auto",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "0.4rem",
          }}
        >
          {authenticated && iconButton("Upload", "upload", onUpload)}
          {authenticated &&
            studioEnabled &&
            desktopItem({
              key: "studio",
              icon: "spark",
              label: "Studio",
              path: "/studio",
              match: (r) => r.name === "studio",
            })}
          <Sep />
          <AccountSlot
            authMode={authMode}
            authenticated={authenticated}
            username={username}
          />
        </div>
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
          // Height (incl. this inset) is pinned in .tabbar-mobile, so the dock
          // can offset itself above the bar exactly. See index.css.
          paddingBottom: "var(--safe-b)",
        }}
      >
        {ITEMS.map(tabItem)}
        <button
          key="queue"
          aria-label="Queue"
          onClick={onQueue}
          style={{
            flex: 1,
            display: "grid",
            placeItems: "center",
            gap: 2,
            background: "none",
            border: "none",
            color: "var(--color-muted)",
            cursor: "pointer",
            padding: "0.5rem 0",
          }}
        >
          <Glyph name="queue" size={22} />
          <span style={{ fontSize: "var(--text-micro)" }}>Queue</span>
        </button>
        {authenticated &&
          studioEnabled &&
          tabItem({
            key: "studio",
            icon: "spark",
            label: "Studio",
            path: "/studio",
            match: (r) => r.name === "studio",
          })}
        {authenticated &&
          tabItem({
            key: "upload",
            icon: "upload",
            label: "Upload",
            path: "__upload",
            match: () => false,
          })}
      </nav>
    </>
  );
}
