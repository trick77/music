import { useEffect, useState, type ReactNode } from "react";
import { getHome, type HomeFeed, type Song } from "./api";
import { coverUrl, coverInitial } from "./cover";
import { navigate } from "./router";
import { Glyph } from "./Glyph";
import { Hero } from "./Hero";
import { Chapter } from "./Chapter";

type Props = {
  authenticated: boolean;
  onPlay: (s: Song, tail: Song[]) => void;
  onShare: (s: Song) => void;
  onUpload?: () => void;
  renderRowActions: (s: Song) => ReactNode;
};

const sectionHead: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  marginBottom: "0.9rem",
};

export function Home({ authenticated, onPlay, onShare, onUpload, renderRowActions }: Props) {
  const [feed, setFeed] = useState<HomeFeed | null>(null);
  useEffect(() => {
    getHome().then(setFeed).catch(() => setFeed(null));
  }, []);

  if (!feed) return <p style={{ color: "var(--color-muted)" }}>Loading…</p>;

  const featured = feed.topTen[0] ?? feed.recentlyAdded[0] ?? null;
  const isEmpty =
    !feed.hero &&
    feed.topTen.length === 0 &&
    feed.recentlyAdded.length === 0 &&
    feed.genres.length === 0 &&
    feed.playlists.length === 0;

  if (isEmpty) {
    return (
      <div style={{ textAlign: "center", padding: "6rem 1rem", color: "var(--color-muted)" }}>
        {authenticated ? (
          <>
            <h2 style={{ fontFamily: "var(--font-serif)", color: "var(--color-ink)" }}>Your library is empty</h2>
            <p>Upload your first songs to get started.</p>
            {onUpload && (
              <button
                onClick={onUpload}
                style={{ marginTop: "0.5rem", display: "inline-flex", alignItems: "center", gap: "0.5rem", background: "var(--color-accent-strong)", color: "#fff", border: "none", borderRadius: 999, padding: "0.6rem 1.3rem", cursor: "pointer", fontWeight: 600 }}
              >
                <Glyph name="upload" size={18} /> Upload music
              </button>
            )}
          </>
        ) : (
          <>
            <h2 style={{ fontFamily: "var(--font-serif)", color: "var(--color-ink)" }}>Nothing here yet</h2>
            <p>Check back soon.</p>
          </>
        )}
      </div>
    );
  }

  const topTail = (i: number) => feed.topTen.slice(i + 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2.5rem" }}>
      <Hero hero={feed.hero} featured={featured} onPlay={(s) => onPlay(s, [])} onShare={onShare} />

      {feed.topTen.length > 0 && (
        <section>
          <div style={sectionHead}>
            <h3 style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: "1.4rem" }}>Top ten played</h3>
          </div>
          <div>
            {feed.topTen.map((s, i) => (
              <div
                key={s.id}
                style={{
                  display: "grid",
                  gridTemplateColumns: "2.2rem 48px 1fr auto auto",
                  alignItems: "center",
                  gap: "0.85rem",
                  padding: "0.5rem 0",
                  borderBottom: "1px solid var(--color-border)",
                }}
              >
                <span
                  className="rank-num"
                  style={{ fontSize: "1.15rem", color: i < 3 ? "var(--color-accent-strong)" : "var(--color-muted)", textAlign: "right" }}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <button onClick={() => onPlay(s, topTail(i))} aria-label={`Play ${s.title}`} style={{ padding: 0, border: "none", background: "none", cursor: "pointer" }}>
                  <span style={{ display: "grid", placeItems: "center", width: 48, height: 48, borderRadius: 8, overflow: "hidden", background: "var(--color-active)" }}>
                    {s.coverArtId ? (
                      <img src={coverUrl(s.coverArtId, "thumb")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : (
                      <span style={{ fontFamily: "var(--font-serif)", color: "var(--color-muted)" }}>{coverInitial(s.title)}</span>
                    )}
                  </span>
                </button>
                <button onClick={() => onPlay(s, topTail(i))} style={{ padding: 0, border: "none", background: "none", cursor: "pointer", textAlign: "left", minWidth: 0 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
                  <div style={{ color: "var(--color-muted)", fontSize: "0.85rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.artistName}</div>
                </button>
                <span className="rank-num" style={{ color: "var(--color-muted)", fontSize: "0.85rem", whiteSpace: "nowrap" }}>
                  {s.plays.toLocaleString()} {s.plays === 1 ? "play" : "plays"}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>{renderRowActions(s)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {feed.recentlyAdded.length > 0 && (
        <section>
          <div style={sectionHead}>
            <h3 style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: "1.4rem" }}>Recently added</h3>
            <a onClick={() => navigate("/")} style={{ color: "var(--color-muted)", fontSize: "0.9rem", cursor: "pointer" }}>Your library →</a>
          </div>
          <div className="hscroll" style={{ display: "flex", gap: "1rem" }}>
            {feed.recentlyAdded.map((s, i) => (
              <button
                key={s.id}
                className="tile"
                onClick={() => onPlay(s, feed.recentlyAdded.slice(i + 1))}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", width: 150, flexShrink: 0, textAlign: "left" }}
              >
                <div style={{ position: "relative", width: 150, height: 150, borderRadius: 12, overflow: "hidden", background: "var(--color-active)", display: "grid", placeItems: "center" }}>
                  {s.coverArtId ? (
                    <img src={coverUrl(s.coverArtId, "card")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <span style={{ fontFamily: "var(--font-serif)", fontSize: "2.2rem", color: "var(--color-muted)" }}>{coverInitial(s.title)}</span>
                  )}
                  <span className="playfab" style={{ position: "absolute", right: 10, bottom: 10, width: 38, height: 38, borderRadius: 999, background: "var(--color-accent-strong)", color: "#fff", display: "grid", placeItems: "center" }}>
                    <Glyph name="play" size={18} />
                  </span>
                </div>
                <div style={{ marginTop: "0.5rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
                <div style={{ color: "var(--color-muted)", fontSize: "0.85rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.artistName}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      {feed.genres.map((chapter) => (
        <Chapter key={chapter.id} chapter={chapter} onPlay={onPlay} />
      ))}

      {feed.playlists.length > 0 && (
        <section>
          <div style={sectionHead}>
            <h3 style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: "1.4rem" }}>Playlists</h3>
            <a onClick={() => navigate("/playlists")} style={{ color: "var(--color-muted)", fontSize: "0.9rem", cursor: "pointer" }}>Your library →</a>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: "1rem" }}>
            {feed.playlists.map((pl) => (
              <button
                key={pl.id}
                onClick={() => navigate(`/playlist/${pl.id}`)}
                style={{ background: "var(--color-panel)", border: "1px solid var(--color-border)", borderRadius: 12, padding: "0.75rem", cursor: "pointer", textAlign: "left" }}
              >
                <div style={{ aspectRatio: "1", borderRadius: 8, overflow: "hidden", background: "var(--color-active)", display: "grid", placeItems: "center", marginBottom: "0.6rem" }}>
                  {pl.coverArtId ? (
                    <img src={coverUrl(pl.coverArtId, "card")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <span style={{ fontFamily: "var(--font-serif)", fontSize: "2rem", color: "var(--color-muted)" }}>{coverInitial(pl.name)}</span>
                  )}
                </div>
                <div style={{ color: "var(--color-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pl.name}</div>
                <div style={{ color: "var(--color-muted)", fontSize: "0.85rem" }}>
                  {pl.songCount} {pl.songCount === 1 ? "song" : "songs"}
                </div>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
