import { formatDuration } from "./format";
import { Glyph } from "./Glyph";
import { Icon } from "./Icon";
import { type Song } from "./api";

// Shared player controls, rendered identically by the docked/full-screen player
// (PlayerBar) and the full-screen visualizer (VisualizerView).

export type Fav = { has: (id: string) => boolean; toggle: (id: string) => void };

// Action icons sit muted by default — the same tint the star carries when it's
// off — so the transport stays the one bright thing in every control row. The
// transport opts back up to ink explicitly.
export const iconBtn: React.CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 40,
  height: 40,
  borderRadius: 8,
  background: "none",
  border: "none",
  color: "var(--color-muted)",
  cursor: "pointer",
};

// Divider separates the transport (prev/play/next) from the actions that follow it
// (favorite, lyrics, visualizer, AirPlay, share) in every control row. Purely
// decorative — the rows carry no group semantics to announce — so it's aria-hidden,
// like the rail's group separator. The default tint reads against the docked
// panel; the immersive rows sit on the cover scrim and pass a white one.
export function Divider({ color = "var(--color-border)" }: { color?: string }) {
  return <span aria-hidden data-divider style={{ width: 1, height: 24, background: color, flexShrink: 0 }} />;
}

export function StarButton({ song, fav, size = 20 }: { song: Song; fav: Fav; size?: number }) {
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

// AirplayButton renders only when Safari reports an AirPlay target on the network
// (available); it opens the native picker and highlights while audio is routed to
// a device (active). Absent in non-Safari browsers, where available stays false.
export function AirplayButton({ available, active, onClick, size = 20, color = "var(--color-muted)" }: { available: boolean; active: boolean; onClick: () => void; size?: number; color?: string }) {
  if (!available) return null;
  return (
    <button
      aria-label="AirPlay"
      aria-pressed={active}
      onClick={onClick}
      style={{ ...iconBtn, color: active ? "var(--color-accent-strong)" : color }}
    >
      <Icon name="airplay" size={`${size}px`} />
    </button>
  );
}

export function Scrubber({ positionMs, durationMs, onSeek, accent = "var(--color-accent-fill)" }: { positionMs: number; durationMs: number; onSeek: (ms: number) => void; accent?: string }) {
  const max = durationMs || 0;
  const pct = max > 0 ? Math.min(100, (positionMs / max) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", width: "100%" }}>
      <span className="rank-num" style={{ fontSize: "var(--text-label)", color: "var(--color-muted)", minWidth: 36, textAlign: "right" }}>{formatDuration(positionMs)}</span>
      <input
        type="range"
        min={0}
        max={max || 1}
        value={Math.min(positionMs, max || 1)}
        onChange={(e) => onSeek(Number(e.target.value))}
        aria-label="Seek"
        style={{ flex: 1, accentColor: accent, background: "transparent", height: 4 }}
      />
      <span className="rank-num" style={{ fontSize: "var(--text-label)", color: "var(--color-muted)", minWidth: 36 }}>{formatDuration(max)}</span>
      <span style={{ display: "none" }}>{pct}</span>
    </div>
  );
}

// canNext greys out Next when nothing follows in the queue. Previous stays live
// throughout: with empty history it restarts the track, which is useful rather
// than a dead end. Defaults true so a caller that doesn't care keeps the button.
export function Transport({ playing, onPrev, onToggle, onNext, canNext = true, size = 22 }: { playing: boolean; onPrev: () => void; onToggle: () => void; onNext: () => void; canNext?: boolean; size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
      <button aria-label="Previous" onClick={onPrev} style={{ ...iconBtn, color: "var(--color-ink)" }}><Glyph name="prev" size={size - 2} /></button>
      <button
        aria-label={playing ? "Pause" : "Play"}
        onClick={onToggle}
        style={{ ...iconBtn, width: size + 22, height: size + 22, borderRadius: 999, background: "var(--color-accent-fill)", color: "var(--color-ink)" }}
      >
        <Glyph name={playing ? "pause" : "play"} size={size} />
      </button>
      <button
        aria-label="Next"
        onClick={onNext}
        disabled={!canNext}
        style={canNext ? { ...iconBtn, color: "var(--color-ink)" } : { ...iconBtn, cursor: "default", opacity: 0.45 }}
      >
        <Glyph name="next" size={size - 2} />
      </button>
    </div>
  );
}
