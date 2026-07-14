import { useEffect, useState } from "react";
import { listGenres, type GenreSummary, type Song } from "./api";
import { coverUrl, coverInitial } from "./cover";
import { fanartUrl } from "./fanart";
import { formatDuration } from "./format";
import { navigate } from "./router";
import { Glyph } from "./Glyph";
import { t } from "./ui";
import { genreLabel } from "./titleCase";
import { usePlayer } from "./player";
import { SongCover } from "./SongCover";

type Tab = "all" | "favorites" | "unpublished" | "genres";

type Props = {
  songs: Song[];
  favoriteIds: string[];
  authenticated: boolean;
  studioEnabled?: boolean;
  imageGenEnabled?: boolean;
  initialTab: Tab;
  // Bumped by the parent after an upload jump to force a re-sync to initialTab even
  // when initialTab itself is unchanged (URL already /unpublished, tab had drifted).
  tabResetKey?: number;
  onPlay: (song: Song) => void;
  renderRowActions: (song: Song) => React.ReactNode;
};

export function Library({ songs, favoriteIds, authenticated, studioEnabled = false, imageGenEnabled = false, initialTab, tabResetKey, onPlay, renderRowActions }: Props) {
  const { current, playing } = usePlayer();
  const [tab, setTab] = useState<Tab>(initialTab);
  // Follow route-driven tab changes (e.g. jumping to /unpublished after an upload)
  // even when Library is already mounted — useState above only seeds the first mount.
  // Pill clicks change `tab` locally without touching `initialTab`, so they aren't
  // clobbered by this effect.
  useEffect(() => { setTab(initialTab); }, [initialTab, tabResetKey]);
  const [genres, setGenres] = useState<GenreSummary[]>([]);
  const [needsArtworkOnly, setNeedsArtworkOnly] = useState(false);
  useEffect(() => { if (tab === "genres") listGenres().then(setGenres).catch(() => setGenres([])); }, [tab]);

  const shown =
    tab === "favorites" ? songs.filter((s) => favoriteIds.includes(s.id))
    : tab === "unpublished" ? songs.filter((s) => !s.published)
    : songs;

  // The Unpublished pill only makes sense for logged-in users — anonymous
  // viewers never receive unpublished songs.
  const tabs: Tab[] = ["all", "favorites", ...(authenticated ? (["unpublished"] as Tab[]) : []), "genres"];

  return (
    <div>
      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1.25rem" }}>
        {tabs.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            style={{ padding: "7px 14px", borderRadius: 999, cursor: "pointer", fontSize: "var(--text-ui)",
              border: "1px solid transparent",
              background: tab === t ? "var(--color-accent-fill)" : "transparent",
              color: tab === t ? "var(--color-ink)" : "var(--color-muted)" }}>
            {t === "all" ? "All songs" : t === "favorites" ? "Favorites" : t === "unpublished" ? "Unpublished" : "Genres"}
          </button>
        ))}
      </div>

      {tab === "genres" ? (() => {
        const missing = genres.filter((g) => !g.hasBackground).length;
        const shownGenres = needsArtworkOnly ? genres.filter((g) => !g.hasBackground) : genres;
        return (
        <div>
          {genres.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: "1rem" }}>
              <span style={t.label}>
                {missing > 0
                  ? <><b style={{ color: "var(--color-accent-strong)" }}>{missing} of {genres.length}</b> genres still need artwork</>
                  : <>All {genres.length} genres have artwork</>}
              </span>
              {(missing > 0 || needsArtworkOnly) && (
                <button onClick={() => setNeedsArtworkOnly((v) => !v)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 14px", borderRadius: 999,
                    cursor: "pointer", fontSize: "var(--text-ui)",
                    border: `1px solid ${needsArtworkOnly ? "var(--color-accent-strong)" : "var(--color-border)"}`,
                    background: needsArtworkOnly ? "var(--color-active)" : "transparent",
                    color: needsArtworkOnly ? "var(--color-accent-strong)" : "var(--color-muted)" }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--color-accent-strong)" }} />
                  Needs artwork only
                </button>
              )}
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))", gap: 14 }}>
            {shownGenres.map((g) => {
              // A genre that needs artwork offers a direct route into Studio to
              // generate it — the entry point lives where the gap is flagged.
              const canMake = !g.hasBackground && studioEnabled && imageGenEnabled;
              // With artwork, the tile shows the fanart muted the hero way (dark
              // gradient over the image); without, it degrades to the accent tint.
              const bg = g.hasBackground ? fanartUrl(g.backgroundFanartId, "card") : "";
              return (
              <div key={g.id} className="tile"
                style={{ position: "relative", borderRadius: 14, overflow: "hidden",
                  minHeight: "clamp(150px, 15vw, 190px)", display: "flex", flexDirection: "column", justifyContent: "flex-end",
                  background: bg
                    ? `linear-gradient(180deg, rgba(20,20,18,0.22), rgba(20,20,18,0.66)), url(${bg}) center/cover no-repeat`
                    : g.accentColor ? `linear-gradient(135deg, ${g.accentColor}, var(--color-panel))` : "var(--color-active)",
                  border: g.hasBackground ? "1px solid var(--color-border)" : "1px dashed var(--color-border)",
                  color: g.hasBackground ? "#fff" : "var(--color-ink)" }}>
                {/* Base click layer: open the genre. Sits behind the label and the CTA. */}
                <button onClick={() => navigate(`/genre/${g.id}`)} aria-label={`${genreLabel(g.name)}, ${g.songCount} ${g.songCount === 1 ? "song" : "songs"}`}
                  style={{ position: "absolute", inset: 0, border: "none", background: "transparent", cursor: "pointer", padding: 0 }} />
                {!g.hasBackground && (
                  <span style={{ position: "absolute", top: 8, right: 8, display: "inline-flex", alignItems: "center", gap: 4, pointerEvents: "none",
                    background: "color-mix(in srgb, var(--color-accent-strong) 30%, var(--color-bg))",
                    border: "1px solid color-mix(in srgb, var(--color-accent-strong) 55%, transparent)",
                    borderRadius: 999, padding: "2px 8px", ...t.micro, fontWeight: 600, color: "#fff" }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--color-accent-strong)" }} />
                    Needs artwork
                  </span>
                )}
                <div style={{ position: "relative", pointerEvents: "none", padding: "0.9rem" }}>
                  <div style={{ ...t.title, ...(g.hasBackground ? { color: "#fff", textShadow: "0 2px 12px rgba(0,0,0,0.6)" } : null) }}>{genreLabel(g.name)}</div>
                  <div style={g.hasBackground ? { fontSize: "var(--text-label)", fontWeight: 500, color: "rgba(255,255,255,0.82)" } : t.label}>{g.songCount} {g.songCount === 1 ? "song" : "songs"}</div>
                </div>
                {canMake && (
                  <button onClick={() => navigate(`/studio/genre/${g.id}`)}
                    style={{ position: "relative", margin: "0 0.9rem 0.9rem", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
                      fontSize: "var(--text-label)", fontWeight: 600, color: "var(--color-accent-strong)", cursor: "pointer",
                      border: "1px solid var(--color-accent-strong)", borderRadius: 8, padding: "5px 8px",
                      background: "color-mix(in srgb, var(--color-accent-strong) 12%, transparent)" }}>
                    <Glyph name="spark" size={13} /> Create in Studio
                  </button>
                )}
              </div>
              );
            })}
            {genres.length === 0 && <p style={{ color: "var(--color-muted)" }}>No genres yet.</p>}
            {genres.length > 0 && shownGenres.length === 0 && (
              <p style={{ color: "var(--color-muted)" }}>Every genre has artwork.</p>
            )}
          </div>
        </div>
        );
      })() : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {shown.length === 0 && <p style={{ color: "var(--color-muted)" }}>{tab === "favorites" ? "No favorites yet — tap the star on a song." : tab === "unpublished" ? "Nothing unpublished — every song is live." : "Nothing here yet."}</p>}
          {shown.map((song) => {
            const isPlaying = current?.id === song.id && playing;
            return (
            <li key={song.id} onClick={() => onPlay(song)} style={{ display: "flex", alignItems: "center", gap: "0.85rem", padding: "0.6rem 0.85rem", borderRadius: "var(--radius-ui, 10px)", cursor: "pointer" }}>
              <SongCover song={song} size={44} radius={8} border="1px solid var(--color-border)" fallbackText={coverInitial(song.artistName)} />

              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", color: isPlaying ? "var(--color-accent-strong)" : "var(--color-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</span>
                <span style={{ display: "flex", alignItems: "center", gap: "0.6rem", ...t.label }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.artistName}</span>
                </span>
              </span>
              <span style={{ color: "var(--color-muted)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{formatDuration(song.durationMs)}</span>
              <span style={{ position: "relative", display: "flex", alignItems: "center", gap: "0.9rem", flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>{renderRowActions(song)}</span>
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
