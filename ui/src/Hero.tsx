import { fanartUrl } from "./fanart";
import { coverUrl } from "./cover";
import { Glyph } from "./Glyph";
import { Icon } from "./Icon";
import type { HomeHero, Song } from "./api";

// Hero is the full-bleed featured panel at the top of Home. The background is
// the starred is_hero fanart (presented as ordinary art — never any AI/prompt
// reference). When a featured song is available its Play/Download/Share act on
// it; the panel degrades to a quiet gradient when no imagery exists.
export function Hero({
  hero,
  featured,
  onPlay,
  onShare,
}: {
  hero: HomeHero | null;
  featured: Song | null;
  onPlay: (s: Song) => void;
  onShare: (s: Song) => void;
}) {
  const heroBg = hero ? fanartUrl(hero.fanartId, "hero") : "";
  // With no starred fanart, fall back to the featured song's own cover, blurred
  // to fill the wide banner (a square cover can't) — instead of a flat gradient.
  const coverBg = !hero && featured?.coverArtId ? coverUrl(featured.coverArtId, "card") : "";
  const accent = hero?.accentColor || "var(--color-accent)";
  const title = hero?.title || featured?.title || "Your library";
  const subtitle = featured
    ? `${featured.artistName} · the most-played track`
    : hero?.subtitle || "Songs, playlists, and the sounds you keep coming back to.";

  return (
    <header
      style={{
        position: "relative",
        borderRadius: 20,
        overflow: "hidden",
        minHeight: "clamp(320px, 52vh, 560px)",
        display: "flex",
        alignItems: "flex-end",
        background: `radial-gradient(120% 120% at 30% 20%, ${accent} 0%, var(--color-panel) 70%)`,
      }}
    >
      {heroBg ? (
        <div style={{ position: "absolute", inset: 0, background: `url(${heroBg}) center/cover no-repeat` }} />
      ) : coverBg ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `url(${coverBg}) center/cover no-repeat`,
            filter: "blur(38px) saturate(1.15)",
            transform: "scale(1.3)",
          }}
        />
      ) : null}
      <div className="scrim" />
      <div style={{ position: "relative", padding: "clamp(1.25rem, 3vw, 2.5rem)", maxWidth: 640 }}>
        <div
          style={{
            fontSize: "0.8rem",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "rgba(255,255,255,0.8)",
            marginBottom: "0.5rem",
          }}
        >
          {featured ? "Featured song" : "Featured"}
        </div>
        <h1
          style={{
            margin: 0,
            fontFamily: "var(--font-serif)",
            fontSize: "clamp(2rem, 5vw, 3.4rem)",
            lineHeight: 1.05,
            color: "#fff",
            textShadow: "0 2px 24px rgba(0,0,0,0.55)",
          }}
        >
          {title}
        </h1>
        <p style={{ color: "rgba(255,255,255,0.86)", margin: "0.5rem 0 1.1rem", fontSize: "1.05rem" }}>{subtitle}</p>
        {featured && (
          <div style={{ display: "flex", gap: "0.7rem", flexWrap: "wrap" }}>
            <button
              onClick={() => onPlay(featured)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.5rem",
                background: "var(--color-accent-strong)",
                color: "var(--color-ink)",
                border: "none",
                borderRadius: 999,
                padding: "0.65rem 1.4rem",
                fontSize: "1rem",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              <Glyph name="play" size={18} /> Play
            </button>
            <a
              href={`/api/songs/${featured.id}/download`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.5rem",
                background: "rgba(0,0,0,0.35)",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.35)",
                borderRadius: 999,
                padding: "0.65rem 1.2rem",
                textDecoration: "none",
              }}
            >
              <Icon name="download" size="18px" /> Download
            </a>
            <button
              onClick={() => onShare(featured)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.5rem",
                background: "rgba(0,0,0,0.35)",
                color: "#fff",
                border: "1px solid rgba(255,255,255,0.35)",
                borderRadius: 999,
                padding: "0.65rem 1.2rem",
                cursor: "pointer",
              }}
            >
              <Icon name="share" size="18px" /> Share
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
