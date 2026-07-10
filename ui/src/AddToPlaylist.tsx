import { useEffect, useState } from "react";
import { addSongToPlaylist, createPlaylist, listPlaylists, type Playlist, type Song } from "./api";

type Props = { song: Song; authenticated: boolean; onClose: () => void; onDone: (name: string) => void };

const item: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "0.5rem 0.85rem", cursor: "pointer", color: "var(--color-ink)",
  fontSize: "0.9rem", background: "none", border: "none", width: "100%", textAlign: "left",
};

export function AddToPlaylist({ song, authenticated, onClose, onDone }: Props) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { listPlaylists().then(setPlaylists).catch(() => setPlaylists([])); }, []);

  const add = async (id: string, name: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await addSongToPlaylist(id, song.id);
      onDone(name);
    } catch {
      onClose(); // e.g. a 403 for an anonymous caller — fail quietly, don't hang
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async () => {
    const name = window.prompt("New playlist name");
    if (!name) return;
    try {
      const pl = await createPlaylist(name, "");
      await add(pl.id, pl.name);
    } catch {
      onClose();
    }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,.5)", display: "grid", placeItems: "center" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ minWidth: 300, background: "var(--color-panel)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-ui, 10px)", padding: "0.6rem 0" }}>
        <div style={{ padding: "0.4rem 0.85rem", color: "var(--color-muted)", fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.04em" }}>Add to playlist</div>
        {authenticated && <button style={{ ...item, color: "var(--color-accent-strong)" }} onClick={createAndAdd}>+ New playlist</button>}
        {playlists.map((pl) => (
          <button key={pl.id} style={item} onClick={() => add(pl.id, pl.name)}>
            <span>{pl.name}</span>
            <span style={{ color: "var(--color-muted)", fontVariantNumeric: "tabular-nums" }}>{pl.songCount}</span>
          </button>
        ))}
        {playlists.length === 0 && !authenticated && (
          <div style={{ padding: "0.5rem 0.85rem", color: "var(--color-muted)", fontSize: "0.85rem" }}>No playlists yet.</div>
        )}
      </div>
    </div>
  );
}
