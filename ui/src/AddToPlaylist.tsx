import { useEffect, useRef, useState } from "react";
import { addSongToPlaylist, createPlaylist, listPlaylists, type Playlist, type Song } from "./api";
import { MenuItem, menuSurface } from "./Menu";
import { controlClass, t } from "./ui";

type Props = { song: Song; authenticated: boolean; onClose: () => void; onDone: (name: string) => void };

export function AddToPlaylist({ song, authenticated, onClose, onDone }: Props) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { listPlaylists().then(setPlaylists).catch(() => setPlaylists([])); }, []);
  useEffect(() => { if (creating) inputRef.current?.focus(); }, [creating]);

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
    const name = newName.trim();
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
        {authenticated && !creating && (
          <MenuItem icon="plus" onClick={() => setCreating(true)}>New playlist…</MenuItem>
        )}
        {authenticated && creating && (
          <div style={{ display: "flex", gap: "0.4rem", padding: "0.35rem 0.85rem" }}>
            <input
              ref={inputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") createAndAdd(); if (e.key === "Escape") setCreating(false); }}
              placeholder="Playlist name"
              className={controlClass}
              style={{ flex: 1, minHeight: 32 }}
            />
            <button onClick={createAndAdd} disabled={busy || !newName.trim()} style={createBtn}>Create</button>
          </div>
        )}
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

const createBtn: React.CSSProperties = {
  background: "var(--color-accent-fill)", color: "var(--color-ink)", border: "none",
  borderRadius: "var(--radius-ui)", padding: "0 0.75rem", fontSize: "var(--text-label)",
  fontWeight: 600, cursor: "pointer",
};
