import type { Song } from "./api";

type Props = {
  song: Song;
  authenticated: boolean;
  onPlayNext: () => void;
  onAddToQueue: () => void;
  onAddToPlaylist: () => void;
  onShare: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
};

const item: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: "0.6rem",
  padding: "0.5rem 0.85rem", cursor: "pointer", color: "var(--color-ink)",
  fontSize: "0.9rem", background: "none", border: "none", width: "100%", textAlign: "left",
};

export function SongMenu(p: Props) {
  return (
    <>
      <div onClick={p.onClose} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
      <div
        role="menu"
        style={{
          position: "absolute", right: 0, top: "100%", marginTop: 4, zIndex: 41,
          minWidth: 200, background: "var(--color-panel)", border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-ui, 10px)", padding: "0.35rem 0", boxShadow: "0 8px 30px rgba(0,0,0,.45)",
        }}
      >
        <button role="menuitem" style={item} onClick={p.onPlayNext}>Play next</button>
        <button role="menuitem" style={item} onClick={p.onAddToQueue}>Add to queue</button>
        <button role="menuitem" style={item} onClick={p.onAddToPlaylist}>Add to playlist</button>
        <a role="menuitem" style={{ ...item, textDecoration: "none" }} href={`/api/songs/${p.song.id}/download`}>Download</a>
        <button role="menuitem" style={item} onClick={p.onShare}>Share</button>
        {p.authenticated && (
          <>
            <div style={{ height: 1, background: "var(--color-border)", margin: "0.35rem 0" }} />
            <button role="menuitem" style={item} onClick={p.onEdit}>Edit tags</button>
            <button role="menuitem" style={{ ...item, color: "var(--color-accent-strong)" }} onClick={p.onDelete}>Delete song</button>
          </>
        )}
      </div>
    </>
  );
}
