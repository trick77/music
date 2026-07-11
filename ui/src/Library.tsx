import { useEffect, useState } from "react";
import { listPlaylists, listGenres, type Playlist, type GenreSummary, type Song } from "./api";
import { coverUrl, coverInitial } from "./cover";
import { formatDuration } from "./format";
import { navigate } from "./router";
import { Glyph } from "./Glyph";
import { Icon } from "./Icon";
import { t } from "./ui";
import { genreLabel } from "./titleCase";
import { usePlayer } from "./player";
import { NowPlayingBars } from "./NowPlayingBars";

type Tab = "all" | "favorites" | "unpublished" | "playlists" | "genres";

type Props = {
  songs: Song[];
  favoriteIds: string[];
  authenticated: boolean;
  studioEnabled?: boolean;
  imageGenEnabled?: boolean;
  initialTab: Tab;
  onPlay: (song: Song) => void;
  renderRowActions: (song: Song) => React.ReactNode;
  onNewPlaylist: () => void;
};

export function Library({ songs, favoriteIds, authenticated, studioEnabled = false, imageGenEnabled = false, initialTab, onPlay, renderRowActions, onNewPlaylist }: Props) {
  const { current, playing } = usePlayer();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [genres, setGenres] = useState<GenreSummary[]>([]);
  const [needsArtworkOnly, setNeedsArtworkOnly] = useState(false);
  useEffect(() => { if (tab === "playlists") listPlaylists().then(setPlaylists).catch(() => setPlaylists([])); }, [tab]);
  useEffect(() => { if (tab === "genres") listGenres().then(setGenres).catch(() => setGenres([])); }, [tab]);

  const shown =
    tab === "favorites" ? songs.filter((s) => favoriteIds.includes(s.id))
    : tab === "unpublished" ? songs.filter((s) => !s.published)
    : songs;

  // The Unpublished pill only makes sense for logged-in users — anonymous
  // viewers never receive unpublished songs.
  const tabs: Tab[] = ["all", "favorites", ...(authenticated ? (["unpublished"] as Tab[]) : []), "playlists", "genres"];

  return (
    <div>
      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1.25rem" }}>
        {tabs.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            style={{ padding: "7px 14px", borderRadius: 999, cursor: "pointer", fontSize: "var(--text-ui)",
              border: "1px solid transparent",
              background: tab === t ? "var(--color-accent-fill)" : "transparent",
              color: tab === t ? "var(--color-ink)" : "var(--color-muted)" }}>
            {t === "all" ? "All songs" : t === "favorites" ? "Favorites" : t === "unpublished" ? "Unpublished" : t === "playlists" ? "Playlists" : "Genres"}
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(140px,1fr))", gap: 12 }}>
            {shownGenres.map((g) => {
              // A genre that needs artwork offers a direct route into Studio to
              // generate it — the entry point lives where the gap is flagged.
              const canMake = !g.hasBackground && studioEnabled && imageGenEnabled;
              return (
              <div key={g.id} className="tile"
                style={{ position: "relative", padding: "0.9rem", borderRadius: 12,
                  background: g.accentColor ? `linear-gradient(135deg, ${g.accentColor}, var(--color-panel))` : "var(--color-active)",
                  border: g.hasBackground ? "1px solid var(--color-border)" : "1px dashed var(--color-border)", color: "var(--color-ink)" }}>
                {/* Base click layer: open the genre. Sits behind the label and the CTA. */}
                <button onClick={() => navigate(`/genre/${g.id}`)} aria-label={`${genreLabel(g.name)}, ${g.songCount} songs`}
                  style={{ position: "absolute", inset: 0, border: "none", background: "transparent", cursor: "pointer", padding: 0 }} />
                {!g.hasBackground && (
                  <span style={{ position: "absolute", top: 8, right: 8, display: "inline-flex", alignItems: "center", gap: 4, pointerEvents: "none",
                    background: "rgba(0,0,0,0.45)", borderRadius: 999, padding: "2px 8px", ...t.micro, color: "#fff" }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--color-accent-strong)" }} />
                    Needs artwork
                  </span>
                )}
                <div style={{ position: "relative", pointerEvents: "none" }}>
                  <div style={t.title}>{genreLabel(g.name)}</div>
                  <div style={t.label}>{g.songCount} songs</div>
                </div>
                {canMake && (
                  <button onClick={() => navigate(`/studio/genre/${g.id}`)}
                    style={{ position: "relative", marginTop: 10, width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
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
      })() : tab === "playlists" ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: "1rem" }}>
          {authenticated && (
            <button onClick={onNewPlaylist} style={{ aspectRatio: "1", borderRadius: 10, border: "1px dashed var(--color-border)", background: "transparent", color: "var(--color-muted)", cursor: "pointer" }}>+ New playlist…</button>
          )}
          {playlists.map((pl) => (
            <button key={pl.id} onClick={() => navigate(`/playlist/${pl.id}`)} style={{ textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
              <div style={{ position: "relative", aspectRatio: "1", borderRadius: 10, overflow: "hidden", background: "var(--color-active)", border: "1px solid var(--color-border)", display: "grid", placeItems: "center" }}>
                {pl.coverArtId ? <img src={coverUrl(pl.coverArtId)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Icon name="music" size="24px" style={{ color: "var(--color-muted)" }} />}
                {authenticated && !pl.published && (
                  <span style={{ position: "absolute", top: 6, left: 6, background: "rgba(0,0,0,0.55)", borderRadius: 999, padding: "2px 8px", ...t.micro, color: "#fff" }}>Unpublished</span>
                )}
              </div>
              <div style={{ marginTop: 6, color: "var(--color-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pl.name}</div>
              <div style={t.label}>{pl.songCount} songs</div>
            </button>
          ))}
          {playlists.length === 0 && !authenticated && <p style={{ color: "var(--color-muted)" }}>No playlists yet.</p>}
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {shown.length === 0 && <p style={{ color: "var(--color-muted)" }}>{tab === "favorites" ? "No favorites yet — tap the star on a song." : tab === "unpublished" ? "Nothing unpublished — every song is live." : "Nothing here yet."}</p>}
          {shown.map((song) => {
            const isPlaying = current?.id === song.id && playing;
            return (
            <li key={song.id} onClick={() => onPlay(song)} style={{ display: "flex", alignItems: "center", gap: "0.85rem", padding: "0.6rem 0.85rem", borderRadius: "var(--radius-ui, 10px)", cursor: "pointer" }}>
              <span style={{ position: "relative", width: 44, height: 44, flexShrink: 0, borderRadius: 8, overflow: "hidden", background: "var(--color-active)", display: "grid", placeItems: "center", border: "1px solid var(--color-border)" }}>
                {song.coverArtId ? <img src={coverUrl(song.coverArtId)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontFamily: "var(--font-serif)", color: "var(--color-muted)" }}>{coverInitial(song.artistName)}</span>}
                {isPlaying && (
                  <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.5)" }}>
                    <NowPlayingBars />
                  </span>
                )}
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", color: isPlaying ? "var(--color-accent-strong)" : "var(--color-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</span>
                <span style={{ display: "block", ...t.label }}>{song.artistName}</span>
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
