import { useEffect, useState } from "react";
import { addSongToPlaylist, createPlaylist, listPlaylists, type Playlist, type Song } from "./api";
import { MenuItem, menuSurface } from "./Menu";
import { t } from "./ui";

type Props = { song: Song; authenticated: boolean; onClose: () => void; onDone: (name: string) => void };

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
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)", display: "grid", placeItems: "center" }}>
      <div onClick={(e) => e.stopPropagation()} role="menu" style={menuSurface}>
        <div style={{ padding: "0.4rem 0.85rem", ...t.label }}>Add to playlist</div>
        {authenticated && <MenuItem icon="plus" onClick={createAndAdd}>New playlist…</MenuItem>}
        {playlists.map((pl) => (
          <MenuItem key={pl.id} onClick={() => add(pl.id, pl.name)} trailing={<span style={{ fontVariantNumeric: "tabular-nums" }}>{pl.songCount}</span>}>
            {pl.name}
          </MenuItem>
        ))}
        {playlists.length === 0 && !authenticated && (
          <div style={{ padding: "0.5rem 0.85rem", ...t.label }}>No playlists yet.</div>
        )}
      </div>
    </div>
  );
}
