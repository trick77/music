import { useState } from "react";
import { usePlayer } from "./player";
import { coverUrl, coverInitial } from "./cover";
import { formatDuration } from "./format";
import { Glyph } from "./Glyph";
import { Icon } from "./Icon";
import type { Song } from "./api";

type Fav = { has: (id: string) => boolean; toggle: (id: string) => void };

function StarButton({ song, fav, size = 20 }: { song: Song; fav: Fav; size?: number }) {
  const on = fav.has(song.id);
  return (
    <button
      aria-label={on ? "Remove favorite" : "Add favorite"}
      onClick={() => fav.toggle(song.id)}
      style={{ display: "grid", placeItems: "center", background: "none", border: "none", cursor: "pointer", color: on ? "var(--color-accent-strong)" : "var(--color-muted)" }}
    >
      <Icon name={on ? "starFilled" : "star"} size={`${size}px`} />
    </button>
  );
}

function Scrubber({ positionMs, durationMs, onSeek, accent = "var(--color-accent-strong)" }: { positionMs: number; durationMs: number; onSeek: (ms: number) => void; accent?: string }) {
  const max = durationMs || 0;
  const pct = max > 0 ? Math.min(100, (positionMs / max) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", width: "100%" }}>
      <span className="rank-num" style={{ fontSize: "0.72rem", color: "var(--color-muted)", minWidth: 36, textAlign: "right" }}>{formatDuration(positionMs)}</span>
      <input
        type="range"
        min={0}
        max={max || 1}
        value={Math.min(positionMs, max || 1)}
        onChange={(e) => onSeek(Number(e.target.value))}
        aria-label="Seek"
        style={{ flex: 1, accentColor: accent, background: "transparent", height: 4 }}
      />
      <span className="rank-num" style={{ fontSize: "0.72rem", color: "var(--color-muted)", minWidth: 36 }}>{formatDuration(max)}</span>
      <span style={{ display: "none" }}>{pct}</span>
    </div>
  );
}

function Transport({ playing, onPrev, onToggle, onNext, size = 22 }: { playing: boolean; onPrev: () => void; onToggle: () => void; onNext: () => void; size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
      <button aria-label="Previous" onClick={onPrev} style={iconBtn}><Glyph name="prev" size={size - 2} /></button>
      <button
        aria-label={playing ? "Pause" : "Play"}
        onClick={onToggle}
        style={{ ...iconBtn, width: size + 22, height: size + 22, borderRadius: 999, background: "var(--color-accent-strong)", color: "var(--color-ink)" }}
      >
        <Glyph name={playing ? "pause" : "play"} size={size} />
      </button>
      <button aria-label="Next" onClick={onNext} style={iconBtn}><Glyph name="next" size={size - 2} /></button>
    </div>
  );
}

const iconBtn: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 40,
  height: 40,
  borderRadius: 8,
  background: "none",
  border: "none",
  color: "var(--color-ink)",
  cursor: "pointer",
};

// PlayerBar renders the docked mini-player (whenever a track is loaded) and,
// when expanded, the full-screen player. Both are driven entirely by the
// player store via usePlayer().
export function PlayerBar({ fav, onShare }: { fav: Fav; onShare: (s: Song) => void }) {
  const p = usePlayer();
  const [full, setFull] = useState(false);
  if (!p.current) return null;
  const song = p.current;

  return (
    <>
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          background: "color-mix(in srgb, var(--color-panel) 92%, transparent)",
          backdropFilter: "blur(14px)",
          borderTop: "1px solid var(--color-border)",
          zIndex: 60,
        }}
      >
        <Scrubber positionMs={p.positionMs} durationMs={p.durationMs} onSeek={p.seek} />
        <div style={{ display: "flex", alignItems: "center", gap: "0.85rem", padding: "0.5rem 1rem 0.7rem", maxWidth: 1100, margin: "0 auto" }}>
          <button onClick={() => setFull(true)} aria-label="Expand player" style={{ display: "flex", alignItems: "center", gap: "0.7rem", background: "none", border: "none", cursor: "pointer", minWidth: 0, flex: 1, textAlign: "left" }}>
            <span style={{ width: 44, height: 44, borderRadius: 8, overflow: "hidden", background: "var(--color-active)", display: "grid", placeItems: "center", flexShrink: 0 }}>
              {song.coverArtId ? <img src={coverUrl(song.coverArtId, "thumb")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontFamily: "var(--font-serif)", color: "var(--color-muted)" }}>{coverInitial(song.title)}</span>}
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", color: "var(--color-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</span>
              <span style={{ display: "block", color: "var(--color-muted)", fontSize: "0.85rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.artistName}</span>
            </span>
          </button>
          <StarButton song={song} fav={fav} />
          <Transport playing={p.playing} onPrev={p.prev} onToggle={p.toggle} onNext={p.next} size={20} />
          <button aria-label="Expand" onClick={() => setFull(true)} style={iconBtn}><Icon name="chevronUp" size="20px" /></button>
        </div>
      </div>

      {full && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 90,
            background: song.coverArtId
              ? `linear-gradient(180deg, rgba(20,20,18,0.6), rgba(20,20,18,0.96)), url(${coverUrl(song.coverArtId, "hero")}) center/cover`
              : "var(--color-bg)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "2rem",
          }}
        >
          <button aria-label="Close player" onClick={() => setFull(false)} style={{ ...iconBtn, position: "absolute", top: 16, right: 16, color: "#fff" }}>
            <Icon name="close" size="24px" />
          </button>
          <div style={{ width: "min(360px, 72vw)", aspectRatio: "1", borderRadius: 18, overflow: "hidden", background: "var(--color-active)", display: "grid", placeItems: "center", boxShadow: "0 24px 80px rgba(0,0,0,0.5)" }}>
            {song.coverArtId ? <img src={coverUrl(song.coverArtId, "card")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontFamily: "var(--font-serif)", fontSize: "4rem", color: "var(--color-muted)" }}>{coverInitial(song.title)}</span>}
          </div>
          <h2 style={{ margin: "1.5rem 0 0.25rem", fontFamily: "var(--font-serif)", color: "#fff", textAlign: "center" }}>{song.title}</h2>
          <p style={{ margin: 0, color: "rgba(255,255,255,0.8)" }}>{song.artistName}</p>
          <div style={{ width: "min(440px, 86vw)", marginTop: "1.5rem" }}>
            <Scrubber positionMs={p.positionMs} durationMs={p.durationMs} onSeek={p.seek} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "1.5rem", marginTop: "1.25rem" }}>
            <StarButton song={song} fav={fav} size={24} />
            <Transport playing={p.playing} onPrev={p.prev} onToggle={p.toggle} onNext={p.next} size={26} />
            <button aria-label="Share" onClick={() => onShare(song)} style={{ ...iconBtn, color: "#fff" }}><Icon name="share" size="22px" /></button>
          </div>
        </div>
      )}
    </>
  );
}
