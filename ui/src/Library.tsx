import { useEffect, useState } from "react";
import { listPlaylists, listGenres, type Playlist, type GenreSummary, type Song } from "./api";
import { coverUrl, coverInitial } from "./cover";
import { formatDuration } from "./format";
import { navigate } from "./router";

type Tab = "all" | "favorites" | "playlists" | "genres";

type Props = {
  songs: Song[];
  favoriteIds: string[];
  authenticated: boolean;
  initialTab: Tab;
  onPlay: (song: Song) => void;
  renderRowActions: (song: Song) => React.ReactNode;
  onNewPlaylist: () => void;
};

export function Library({ songs, favoriteIds, authenticated, initialTab, onPlay, renderRowActions, onNewPlaylist }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [genres, setGenres] = useState<GenreSummary[]>([]);
  const [needsArtworkOnly, setNeedsArtworkOnly] = useState(false);
  useEffect(() => { if (tab === "playlists") listPlaylists().then(setPlaylists).catch(() => setPlaylists([])); }, [tab]);
  useEffect(() => { if (tab === "genres") listGenres().then(setGenres).catch(() => setGenres([])); }, [tab]);

  const shown = tab === "favorites" ? songs.filter((s) => favoriteIds.includes(s.id)) : songs;

  return (
    <div>
      <div style={{ display: "flex", gap: "0.4rem", marginBottom: "1.25rem" }}>
        {(["all", "favorites", "playlists", "genres"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            style={{ padding: "0.35rem 0.85rem", borderRadius: 999, cursor: "pointer", fontSize: "0.85rem",
              border: "1px solid var(--color-border)",
              background: tab === t ? "var(--color-active)" : "transparent",
              color: tab === t ? "var(--color-ink)" : "var(--color-muted)" }}>
            {t === "all" ? "All songs" : t === "favorites" ? "Favorites" : t === "playlists" ? "Playlists" : "Genres"}
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
              <span style={{ color: "var(--color-muted)", fontSize: "0.85rem" }}>
                {missing > 0
                  ? <><b style={{ color: "var(--color-accent-strong)" }}>{missing} of {genres.length}</b> genres still need artwork</>
                  : <>All {genres.length} genres have artwork</>}
              </span>
              {(missing > 0 || needsArtworkOnly) && (
                <button onClick={() => setNeedsArtworkOnly((v) => !v)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "0.35rem 0.8rem", borderRadius: 999,
                    cursor: "pointer", fontSize: "0.8rem", font: "inherit",
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
            {shownGenres.map((g) => (
              <button key={g.id} onClick={() => navigate(`/genre/${g.id}`)}
                style={{ position: "relative", textAlign: "left", padding: "0.9rem", borderRadius: 12, cursor: "pointer",
                  background: g.accentColor ? `linear-gradient(135deg, ${g.accentColor}, var(--color-panel))` : "var(--color-active)",
                  border: g.hasBackground ? "1px solid var(--color-border)" : "1px dashed var(--color-border)", color: "var(--color-ink)" }}>
                {!g.hasBackground && (
                  <span style={{ position: "absolute", top: 8, right: 8, display: "inline-flex", alignItems: "center", gap: 4,
                    background: "rgba(0,0,0,0.45)", color: "#fff", borderRadius: 999, padding: "2px 8px", fontSize: "0.62rem", letterSpacing: "0.02em" }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--color-accent-strong)" }} />
                    Needs artwork
                  </span>
                )}
                <div style={{ fontFamily: "var(--font-serif)", fontSize: "1.05rem" }}>{g.name}</div>
                <div style={{ color: "var(--color-muted)", fontSize: "0.8rem" }}>{g.songCount} songs</div>
              </button>
            ))}
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
            <button onClick={onNewPlaylist} style={{ aspectRatio: "1", borderRadius: 10, border: "1px dashed var(--color-border)", background: "transparent", color: "var(--color-muted)", cursor: "pointer" }}>+ New playlist</button>
          )}
          {playlists.map((pl) => (
            <button key={pl.id} onClick={() => navigate(`/playlist/${pl.id}`)} style={{ textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
              <div style={{ aspectRatio: "1", borderRadius: 10, overflow: "hidden", background: "var(--color-active)", border: "1px solid var(--color-border)", display: "grid", placeItems: "center" }}>
                {pl.coverArtId ? <img src={coverUrl(pl.coverArtId)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ color: "var(--color-muted)", fontSize: "1.5rem" }}>♪</span>}
              </div>
              <div style={{ marginTop: 6, color: "var(--color-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pl.name}</div>
              <div style={{ color: "var(--color-muted)", fontSize: "0.8rem" }}>{pl.songCount} songs</div>
            </button>
          ))}
          {playlists.length === 0 && !authenticated && <p style={{ color: "var(--color-muted)" }}>No playlists yet.</p>}
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {shown.length === 0 && <p style={{ color: "var(--color-muted)" }}>{tab === "favorites" ? "No favorites yet — tap the star on a song." : "Nothing here yet."}</p>}
          {shown.map((song) => (
            <li key={song.id} onClick={() => onPlay(song)} style={{ display: "flex", alignItems: "center", gap: "0.85rem", padding: "0.6rem 0.85rem", borderRadius: "var(--radius-ui, 10px)", cursor: "pointer" }}>
              <span style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 8, overflow: "hidden", background: "var(--color-active)", display: "grid", placeItems: "center", border: "1px solid var(--color-border)" }}>
                {song.coverArtId ? <img src={coverUrl(song.coverArtId)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontFamily: "var(--font-serif)", color: "var(--color-muted)" }}>{coverInitial(song.artistName)}</span>}
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", color: "var(--color-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</span>
                <span style={{ display: "block", color: "var(--color-muted)", fontSize: "0.85rem" }}>{song.artistName}</span>
              </span>
              <span style={{ color: "var(--color-muted)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>{formatDuration(song.durationMs)}</span>
              <span style={{ position: "relative", display: "flex", alignItems: "center", gap: "0.9rem", flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>{renderRowActions(song)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
