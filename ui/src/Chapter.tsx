import { fanartUrl, genreInitial } from "./fanart";
import { SongCover } from "./SongCover";
import { HScrollRail } from "./HScrollRail";
import { Glyph } from "./Glyph";
import { navigate } from "./router";
import { genreLabel } from "./titleCase";
import type { GenreChapter, Song } from "./api";

// Chapter is one immersive genre "chapter" on Home: a full-bleed active
// background fanart with the genre's auto-sampled accent, a heading, and a
// horizontal cover rail of its songs. Degrades to an accent gradient when the
// genre has no background image.
export function Chapter({ chapter, onPlay }: { chapter: GenreChapter; onPlay: (s: Song, tail: Song[]) => void }) {
  const bg = fanartUrl(chapter.backgroundFanartId, "hero");
  const accent = chapter.accentColor || "var(--color-accent)";
  return (
    <section
      style={{
        position: "relative",
        borderRadius: 18,
        overflow: "hidden",
        background: bg
          ? `linear-gradient(180deg, rgba(20,20,18,0.22), rgba(20,20,18,0.66)), url(${bg}) center/cover no-repeat`
          : `linear-gradient(135deg, ${accent}, var(--color-panel))`,
      }}
    >
      <div className="scrim" />
      <div style={{ position: "relative", padding: "clamp(1rem, 2.4vw, 1.75rem)" }}>
        <button
          onClick={() => navigate(`/genre/${chapter.id}`)}
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}
        >
          <div style={{ fontSize: "var(--text-micro)", letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(255,255,255,0.8)" }}>
            Genre
          </div>
          <h3 style={{ margin: "0.15rem 0 0", fontFamily: "var(--font-serif)", fontSize: "clamp(1.5rem, 3vw, 2.1rem)", color: "#fff", textShadow: "0 2px 16px rgba(0,0,0,0.55)" }}>
            {genreLabel(chapter.name)}
          </h3>
        </button>
        <div style={{ color: "rgba(255,255,255,0.82)", fontSize: "var(--text-label)", marginBottom: "0.9rem" }}>
          {chapter.songCount} {chapter.songCount === 1 ? "track" : "tracks"}
        </div>
        <HScrollRail innerStyle={{ gap: "0.9rem", paddingBottom: "0.25rem" }}>
          {chapter.songs.map((s, i) => (
            <button
              key={s.id}
              className="rail-cv"
              onClick={() => onPlay(s, chapter.songs.slice(i + 1))}
              style={{ background: "none", border: "none", padding: 0, cursor: "pointer", width: 128, flexShrink: 0, textAlign: "left" }}
            >
              <SongCover song={s} size={128} radius={12} imgSize="card" background="rgba(0,0,0,0.35)" fallbackFontSize="2rem" fallbackColor="rgba(255,255,255,0.7)" barsScale={2}>
                <span className="playfab" style={{ position: "absolute", right: 8, bottom: 8, width: 34, height: 34, borderRadius: 999, background: "var(--color-accent-fill)", color: "var(--color-ink)", display: "grid", placeItems: "center" }}>
                  <Glyph name="play" size={16} />
                </span>
              </SongCover>
              <div style={{ color: "#fff", fontSize: "var(--text-ui)", marginTop: "0.4rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
              <div style={{ color: "rgba(255,255,255,0.72)", fontSize: "var(--text-label)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.artistName}</div>
            </button>
          ))}
          {chapter.songs.length === 0 && (
            <span style={{ color: "rgba(255,255,255,0.7)", fontSize: "var(--text-label)" }}>
              {genreInitial(chapter.name)} — no tracks yet
            </span>
          )}
        </HScrollRail>
      </div>
    </section>
  );
}
