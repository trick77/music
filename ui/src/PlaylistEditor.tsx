import { useState } from "react";
import {
  createPlaylist, updatePlaylist, addSongToPlaylist, removeSongFromPlaylist,
  reorderPlaylist, uploadPlaylistCover, listSongs, type PlaylistDetail, type Song,
} from "./api";
import { coverUrl } from "./cover";
import { formatDuration } from "./format";

type Props = {
  existing: PlaylistDetail | null; // null = create
  onClose: () => void;
  onSaved: (pl: PlaylistDetail) => void;
};

export function PlaylistEditor({ existing, onClose, onSaved }: Props) {
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [detail, setDetail] = useState<PlaylistDetail | null>(existing);
  const [allSongs, setAllSongs] = useState<Song[]>([]);
  const [query, setQuery] = useState("");
  const [drag, setDrag] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const songs = detail?.songs ?? [];

  const ensurePlaylist = async (): Promise<PlaylistDetail> => {
    if (detail) {
      const pl = await updatePlaylist(detail.id, name || "Untitled", description);
      setDetail(pl);
      return pl;
    }
    const pl = await createPlaylist(name || "Untitled", description);
    setDetail(pl);
    return pl;
  };

  const onAddSearch = async () => {
    if (allSongs.length === 0) setAllSongs(await listSongs());
  };

  const addSong = async (song: Song) => {
    const pl = await ensurePlaylist();
    setDetail(await addSongToPlaylist(pl.id, song.id));
  };

  const remove = async (song: Song) => {
    if (!detail) return;
    setDetail(await removeSongFromPlaylist(detail.id, song.id));
  };

  const onDrop = async (to: number) => {
    if (drag === null || !detail) return setDrag(null);
    const ids = songs.map((s) => s.id);
    const [moved] = ids.splice(drag, 1);
    ids.splice(to, 0, moved);
    setDrag(null);
    setDetail(await reorderPlaylist(detail.id, ids));
  };

  const onCover = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const pl = await ensurePlaylist();
    setDetail(await uploadPlaylistCover(pl.id, file));
  };

  const save = async () => {
    setBusy(true);
    try { onSaved(await ensurePlaylist()); } finally { setBusy(false); }
  };

  const matches = query
    ? allSongs.filter((s) => `${s.title} ${s.artistName}`.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
    : [];

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,.55)", display: "grid", placeItems: "center", padding: "1rem" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: "100%", maxHeight: "88vh", overflowY: "auto", background: "var(--color-panel)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-ui, 10px)", padding: "1.25rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ margin: 0, fontFamily: "var(--font-serif)" }}>{existing ? "Edit playlist" : "New playlist"}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", fontSize: "1.1rem" }}>✕</button>
        </div>

        <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ width: 96, height: 96, borderRadius: 8, overflow: "hidden", background: "var(--color-active)", border: "1px solid var(--color-border)", display: "grid", placeItems: "center" }}>
              {detail?.coverArtId ? <img src={coverUrl(detail.coverArtId)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ color: "var(--color-muted)" }}>♪</span>}
            </div>
            <label style={{ cursor: "pointer", color: "var(--color-accent-strong)", fontSize: "0.8rem", display: "block", marginTop: 6 }}>
              Upload cover
              <input type="file" accept="image/png,image/jpeg" onChange={onCover} style={{ display: "none" }} />
            </label>
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: "block", color: "var(--color-muted)", fontSize: "0.8rem", marginBottom: 4 }}>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
            <label style={{ display: "block", color: "var(--color-muted)", fontSize: "0.8rem", margin: "0.6rem 0 4px" }}>Description · optional</label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} style={{ ...inputStyle, resize: "vertical" }} />
          </div>
        </div>

        <div style={{ color: "var(--color-muted)", fontSize: "0.8rem", marginBottom: 4 }}>Songs · {songs.length}</div>
        {songs.map((song, i) => (
          <div key={song.id} draggable onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => onDrop(i)}
            style={{ display: "flex", alignItems: "center", gap: "0.5rem", padding: "0.35rem 0", cursor: "grab" }}>
            <span style={{ color: "var(--color-muted)" }}>⠿</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</span>
              <span style={{ display: "block", color: "var(--color-muted)", fontSize: "0.8rem" }}>{song.artistName}</span>
            </span>
            <span style={{ color: "var(--color-muted)", fontVariantNumeric: "tabular-nums", fontSize: "0.8rem" }}>{formatDuration(song.durationMs)}</span>
            <button onClick={() => remove(song)} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer" }}>✕</button>
          </div>
        ))}

        <input placeholder="Add songs — search by title or artist…" value={query}
          onFocus={onAddSearch} onChange={(e) => setQuery(e.target.value)}
          style={{ ...inputStyle, marginTop: "0.75rem" }} />
        {matches.map((song) => (
          <button key={song.id} onClick={() => addSong(song)} style={{ ...inputStyle, textAlign: "left", cursor: "pointer", marginTop: 4, background: "var(--color-active)" }}>
            {song.title} — <span style={{ color: "var(--color-muted)" }}>{song.artistName}</span>
          </button>
        ))}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.6rem", marginTop: "1.25rem" }}>
          <button onClick={onClose} style={btnStyle}>Cancel</button>
          <button onClick={save} disabled={busy || !name} style={{ ...btnStyle, background: "var(--color-accent-strong)", color: "#fff", border: "none" }}>
            {existing ? "Save" : "Create playlist"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "0.5rem 0.65rem", borderRadius: 8, boxSizing: "border-box",
  background: "var(--color-bg)", border: "1px solid var(--color-border)", color: "var(--color-ink)", fontSize: "0.9rem",
};
const btnStyle: React.CSSProperties = {
  padding: "0.45rem 0.9rem", borderRadius: 8, cursor: "pointer",
  background: "none", border: "1px solid var(--color-border)", color: "var(--color-ink)", fontSize: "0.9rem",
};
