import { useState } from "react";
import type { Song } from "./api";
import { reorder, removeAt } from "./queue";
import { formatDuration } from "./format";

type Props = {
  queue: Song[];
  nowPlaying: Song | null;
  onChange: (q: Song[]) => void;
  onPlay: (index: number) => void;
  onClose: () => void;
};

export function QueueDrawer({ queue, nowPlaying, onChange, onPlay, onClose }: Props) {
  const [drag, setDrag] = useState<number | null>(null);
  return (
    <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 340, maxWidth: "90vw", zIndex: 60, background: "var(--color-panel)", borderLeft: "1px solid var(--color-border)", padding: "1rem", overflowY: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
        <h3 style={{ margin: 0, fontFamily: "var(--font-serif)" }}>Queue</h3>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", fontSize: "1.1rem" }}>✕</button>
      </div>
      {nowPlaying && (
        <>
          <div style={{ color: "var(--color-muted)", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Now playing</div>
          <div style={{ padding: "0.4rem 0", marginBottom: "0.5rem" }}><strong>{nowPlaying.title}</strong><div style={{ color: "var(--color-muted)", fontSize: "0.85rem" }}>{nowPlaying.artistName}</div></div>
        </>
      )}
      <div style={{ color: "var(--color-muted)", fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Next up</div>
      {queue.length === 0 && <div style={{ color: "var(--color-muted)", fontSize: "0.85rem" }}>Queue is empty.</div>}
      {queue.map((song, i) => (
        <div
          key={`${song.id}-${i}`}
          draggable
          onDragStart={() => setDrag(i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => { if (drag !== null) onChange(reorder(queue, drag, i)); setDrag(null); }}
          style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.4rem 0", cursor: "grab" }}
        >
          <span style={{ color: "var(--color-muted)" }}>⠿</span>
          <span style={{ flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => onPlay(i)}>
            <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</span>
            <span style={{ display: "block", color: "var(--color-muted)", fontSize: "0.8rem" }}>{song.artistName}</span>
          </span>
          <span style={{ color: "var(--color-muted)", fontVariantNumeric: "tabular-nums", fontSize: "0.8rem" }}>{formatDuration(song.durationMs)}</span>
          <button onClick={() => onChange(removeAt(queue, i))} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer" }}>✕</button>
        </div>
      ))}
    </div>
  );
}
