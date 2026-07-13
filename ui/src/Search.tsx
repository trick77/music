import { useEffect, useState } from "react";
import { search, type SearchResults, type Song } from "./api";
import { coverUrl, coverInitial } from "./cover";
import { navigate } from "./router";
import { Glyph } from "./Glyph";
import { NowPlayingBars } from "./NowPlayingBars";
import { SongCover } from "./SongCover";
import { usePlayer } from "./player";
import { t } from "./ui";
import { genreLabel } from "./titleCase";

// Search is the grouped results screen: a debounced query with a Top result and
// Songs / Artists / Genres / Playlists sections.
export function Search({ onPlay }: { onPlay: (s: Song, tail: Song[]) => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<SearchResults | null>(null);
  const { current, playing } = usePlayer();

  useEffect(() => {
    if (!q.trim()) {
      setRes(null);
      return;
    }
    const timer = setTimeout(() => {
      search(q).then(setRes).catch(() => setRes(null));
    }, 200);
    return () => clearTimeout(timer);
  }, [q]);

  const openTop = () => {
    if (!res?.top) return;
    const { type, id } = res.top;
    if (type === "song") {
      const s = res.songs.find((x) => x.id === id);
      if (s) onPlay(s, []);
    } else if (type === "artist") navigate(`/artist/${id}`);
    else if (type === "genre") navigate(`/genre/${id}`);
    else navigate(`/playlist/${id}`);
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", background: "var(--color-panel)", border: "1px solid var(--color-border)", borderRadius: 999, padding: "0.65rem 1.1rem", marginBottom: "1.5rem" }}>
        <Glyph name="search" size={20} style={{ color: "var(--color-muted)" }} />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search songs, artists, genres, playlists…"
          style={{ flex: 1, background: "none", border: "none", color: "var(--color-ink)", fontSize: "var(--text-ui)", outline: "none" }}
        />
      </div>

      {!q.trim() && <p style={{ color: "var(--color-muted)" }}>Start typing to search your library.</p>}

      {res && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.75rem" }}>
          {res.top && (() => {
            const topCover = topCoverArtId(res);
            const topPlaying = res.top.type === "song" && current?.id === res.top.id && playing;
            return (
            <section>
              <h3 style={head}>Top result</h3>
              <button onClick={openTop} style={{ display: "flex", alignItems: "center", gap: "0.9rem", background: "var(--color-panel)", border: "1px solid var(--color-border)", borderRadius: 12, padding: "0.9rem", cursor: "pointer", textAlign: "left", width: "100%" }}>
                <span style={{ position: "relative", width: 56, height: 56, borderRadius: 8, background: "var(--color-active)", display: "grid", placeItems: "center", overflow: "hidden" }}>
                  {topCover ? <img src={coverUrl(topCover, "thumb")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <Glyph name={res.top.type === "song" ? "play" : res.top.type === "genre" ? "disc" : res.top.type === "playlist" ? "library" : "search"} size={22} style={{ color: "var(--color-muted)" }} />}
                  {topPlaying && (
                    <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.5)" }}>
                      <NowPlayingBars />
                    </span>
                  )}
                </span>
                <span>
                  <div style={{ color: topPlaying ? "var(--color-accent-strong)" : "var(--color-ink)" }}>{topLabel(res)}</div>
                  <div style={{ ...t.label, textTransform: "capitalize" }}>{res.top.type}</div>
                </span>
              </button>
            </section>
            );
          })()}

          {res.songs.length > 0 && (
            <section>
              <h3 style={head}>Songs</h3>
              {res.songs.map((s, i) => {
                const isPlaying = current?.id === s.id && playing;
                return (
                <button key={s.id} onClick={() => onPlay(s, res.songs.slice(i + 1))} style={rowBtn}>
                  <SongCover song={s} size={40} radius={6} imgSize="thumb" fallbackFontSize="0.9rem" />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isPlaying ? "var(--color-accent-strong)" : undefined }}>{s.title}</span>
                    <span style={{ display: "block", ...t.label, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.artistName}</span>
                  </span>
                </button>
                );
              })}
            </section>
          )}

          {res.artists.length > 0 && (
            <section>
              <h3 style={head}>Artists</h3>
              {res.artists.map((a) => (
                <button key={a.id} onClick={() => navigate(`/artist/${a.id}`)} style={rowBtn}>
                  <span style={{ width: 40, height: 40, borderRadius: 999, background: "var(--color-active)", display: "grid", placeItems: "center", color: "var(--color-muted)", fontFamily: "var(--font-serif)" }}>{coverInitial(a.name)}</span>
                  <span>
                    <span style={{ display: "block" }}>{a.name}</span>
                    <span style={{ display: "block", ...t.label }}>{a.songCount} {a.songCount === 1 ? "song" : "songs"}</span>
                  </span>
                </button>
              ))}
            </section>
          )}

          {res.genres.length > 0 && (
            <section>
              <h3 style={head}>Genres</h3>
              {res.genres.map((g) => (
                <button key={g.id} onClick={() => navigate(`/genre/${g.id}`)} style={rowBtn}>
                  <span style={{ width: 40, height: 40, borderRadius: 6, background: g.accentColor || "var(--color-active)" }} />
                  <span>{genreLabel(g.name)}</span>
                </button>
              ))}
            </section>
          )}

          {res.playlists.length > 0 && (
            <section>
              <h3 style={head}>Playlists</h3>
              {res.playlists.map((pl) => (
                <button key={pl.id} onClick={() => navigate(`/playlist/${pl.id}`)} style={rowBtn}>
                  <span style={{ width: 40, height: 40, borderRadius: 6, background: "var(--color-active)", display: "grid", placeItems: "center", overflow: "hidden" }}>
                    {pl.coverArtId ? <img src={coverUrl(pl.coverArtId, "thumb")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontFamily: "var(--font-serif)", color: "var(--color-muted)", fontSize: "0.9rem" }}>{coverInitial(pl.name)}</span>}
                  </span>
                  <span>{pl.name}</span>
                </button>
              ))}
            </section>
          )}

          {res.top === null && res.songs.length === 0 && res.artists.length === 0 && res.genres.length === 0 && res.playlists.length === 0 && (
            <p style={{ color: "var(--color-muted)" }}>No results for “{q}”.</p>
          )}
        </div>
      )}
    </div>
  );
}

function topLabel(res: SearchResults): string {
  if (!res.top) return "";
  const { type, id } = res.top;
  if (type === "song") return res.songs.find((x) => x.id === id)?.title ?? "";
  if (type === "artist") return res.artists.find((x) => x.id === id)?.name ?? "";
  if (type === "genre") { const n = res.genres.find((x) => x.id === id)?.name; return n ? genreLabel(n) : ""; }
  return res.playlists.find((x) => x.id === id)?.name ?? "";
}

// topCoverArtId resolves the cover art for the Top result by cross-looking-up the
// matched song/playlist (Top itself carries only {type,id}). Artists/genres have none.
function topCoverArtId(res: SearchResults): string {
  if (!res.top) return "";
  const { type, id } = res.top;
  if (type === "song") return res.songs.find((x) => x.id === id)?.coverArtId ?? "";
  if (type === "playlist") return res.playlists.find((x) => x.id === id)?.coverArtId ?? "";
  return "";
}

const head: React.CSSProperties = { margin: "0 0 0.6rem", ...t.title };

const rowBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  width: "100%",
  background: "none",
  border: "none",
  borderBottom: "1px solid var(--color-border)",
  color: "var(--color-ink)",
  cursor: "pointer",
  padding: "0.5rem 0",
  textAlign: "left",
};
