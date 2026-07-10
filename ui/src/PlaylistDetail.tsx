import { useEffect, useState } from "react";
import { getPlaylist, deletePlaylist, type PlaylistDetail as PL, type Song } from "./api";
import { coverUrl } from "./cover";
import { formatDuration } from "./format";
import { playlistShareUrl, copyText } from "./share";
import { navigate } from "./router";

type Props = {
  id: string;
  authenticated: boolean;
  onPlay: (song: Song, queue: Song[]) => void;
  onEdit: (pl: PL) => void;
};

export function PlaylistView({ id, authenticated, onPlay, onEdit }: Props) {
  const [pl, setPl] = useState<PL | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    getPlaylist(id).then(setPl).catch(() => setError(true));
  }, [id]);

  if (error) return <p style={{ color: "var(--color-muted)" }}>Playlist not found.</p>;
  if (!pl) return <p style={{ color: "var(--color-muted)" }}>Loading…</p>;

  const share = async () => {
    const url = playlistShareUrl(pl.id);
    if (!(await copyText(url))) window.prompt("Copy this link", url);
  };

  const remove = async () => {
    if (!window.confirm(`Delete playlist "${pl.name}"? This cannot be undone.`)) return;
    await deletePlaylist(pl.id);
    navigate("/playlists");
  };

  return (
    <div>
      <button onClick={() => navigate("/playlists")} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", marginBottom: "1rem" }}>← Playlists</button>
      <div style={{ display: "flex", gap: "1rem", alignItems: "flex-end", marginBottom: "1.25rem" }}>
        <div style={{ width: 120, height: 120, borderRadius: 10, overflow: "hidden", background: "var(--color-active)", border: "1px solid var(--color-border)", display: "grid", placeItems: "center", flexShrink: 0 }}>
          {pl.coverArtId ? <img src={coverUrl(pl.coverArtId)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : pl.songs[0]?.coverArtId ? <img src={coverUrl(pl.songs[0].coverArtId)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            : <span style={{ color: "var(--color-muted)", fontSize: "2rem" }}>♪</span>}
        </div>
        <div>
          <h1 style={{ fontFamily: "var(--font-serif)", margin: "0 0 0.25rem" }}>{pl.name}</h1>
          {pl.description && <p style={{ color: "var(--color-muted)", margin: "0 0 0.5rem" }}>{pl.description}</p>}
          <div style={{ display: "flex", gap: "0.6rem" }}>
            {pl.songs.length > 0 && <button onClick={() => onPlay(pl.songs[0], pl.songs.slice(1))} style={btn}>▶ Play</button>}
            <button onClick={share} style={btn}>Share</button>
            {authenticated && <button onClick={() => onEdit(pl)} style={btn}>Edit</button>}
            {authenticated && <button onClick={remove} style={{ ...btn, color: "var(--color-accent-strong)" }}>Delete</button>}
          </div>
        </div>
      </div>
      <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {pl.songs.map((song, i) => (
          <li key={song.id} onClick={() => onPlay(song, pl.songs.slice(i + 1))}
            style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0.6rem", borderRadius: 8, cursor: "pointer" }}>
            <span style={{ color: "var(--color-muted)", width: 22, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{i + 1}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{song.title}</span>
              <span style={{ display: "block", color: "var(--color-muted)", fontSize: "0.85rem" }}>{song.artistName}</span>
            </span>
            <span style={{ color: "var(--color-muted)", fontVariantNumeric: "tabular-nums" }}>{formatDuration(song.durationMs)}</span>
          </li>
        ))}
      </ol>
      {pl.songs.length === 0 && <p style={{ color: "var(--color-muted)" }}>No songs yet{authenticated ? " — add some from Edit." : "."}</p>}
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "0.4rem 0.85rem", borderRadius: 8, cursor: "pointer",
  background: "none", border: "1px solid var(--color-border)", color: "var(--color-ink)", fontSize: "0.9rem",
};
