import { useEffect, useRef, useState } from "react";
import { getSession, listSongs, uploadSong, streamUrl, type Session, type Song } from "./api";
import { formatDuration } from "./format";
import { TagEditor } from "./TagEditor";
import { coverUrl, coverInitial } from "./cover";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [nowPlaying, setNowPlaying] = useState<Song | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Song | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const refresh = () => listSongs().then(setSongs).catch(() => setError("Could not load songs"));

  useEffect(() => {
    getSession().then(setSession).catch(() => setSession({ authenticated: false, username: "" }));
    refresh();
  }, []);

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await uploadSong(file);
      await refresh();
    } catch {
      setError("Upload failed");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const play = (song: Song) => {
    setNowPlaying(song);
    // Load + play after the src updates.
    requestAnimationFrame(() => {
      const el = audioRef.current;
      if (el) {
        el.load();
        void el.play().catch(() => {});
      }
    });
  };

  return (
    <div style={{ minHeight: "100vh", maxWidth: 720, margin: "0 auto", padding: "2rem 1.25rem 8rem" }}>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "1.5rem" }}>
        <h1 style={{ fontFamily: "var(--font-serif)", fontSize: "1.75rem", margin: 0 }}>Music</h1>
        {session?.authenticated && (
          <label style={{ cursor: "pointer", color: "var(--color-accent-strong)", fontSize: "0.95rem" }}>
            {uploading ? "Uploading…" : "Upload"}
            <input type="file" accept=".mp3,audio/mpeg" onChange={onUpload} style={{ display: "none" }} disabled={uploading} />
          </label>
        )}
      </header>

      {error && <p style={{ color: "var(--color-accent-strong)" }}>{error}</p>}

      {songs.length === 0 ? (
        <p style={{ color: "var(--color-muted)" }}>
          {session?.authenticated ? "No songs yet — upload one to get started." : "Nothing here yet."}
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {songs.map((song) => {
            const active = nowPlaying?.id === song.id;
            return (
              <li
                key={song.id}
                onClick={() => play(song)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "0.85rem",
                  padding: "0.6rem 0.85rem",
                  borderRadius: "var(--radius-ui, 10px)",
                  cursor: "pointer",
                  background: active ? "var(--color-active)" : "transparent",
                }}
              >
                <span style={{ width: 44, height: 44, flexShrink: 0, borderRadius: 8, overflow: "hidden", background: "var(--color-active)", display: "grid", placeItems: "center", border: "1px solid var(--color-border)" }}>
                  {song.coverArtId ? (
                    <img src={coverUrl(song.coverArtId)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <span style={{ fontFamily: "var(--font-serif)", fontSize: "0.9rem", color: "var(--color-muted)" }}>{coverInitial(song.artistName)}</span>
                  )}
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "block", color: "var(--color-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {song.title}
                  </span>
                  <span style={{ display: "block", color: "var(--color-muted)", fontSize: "0.85rem" }}>
                    {song.artistName}
                    {song.genres.length > 0 && ` · ${song.genres.join(", ")}`}
                  </span>
                </span>
                <span style={{ color: "var(--color-muted)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {formatDuration(song.durationMs)}
                </span>
                {session?.authenticated && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setEditing(song); }}
                    style={{ background: "none", border: "1px solid var(--color-border)", color: "var(--color-ink)", borderRadius: 8, padding: "0.25rem 0.6rem", cursor: "pointer", fontSize: "0.8rem", flexShrink: 0 }}
                  >
                    Edit
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {nowPlaying && (
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            background: "var(--color-panel)",
            borderTop: "1px solid var(--color-border)",
            padding: "0.75rem 1.25rem",
          }}
        >
          <div style={{ maxWidth: 720, margin: "0 auto" }}>
            <div style={{ marginBottom: "0.4rem", fontSize: "0.9rem" }}>
              <strong>{nowPlaying.title}</strong>
              <span style={{ color: "var(--color-muted)" }}> — {nowPlaying.artistName}</span>
            </div>
            <audio ref={audioRef} controls style={{ width: "100%" }} src={streamUrl(nowPlaying.id)}>
              <track kind="captions" />
            </audio>
          </div>
        </div>
      )}

      {editing && (
        <TagEditor
          song={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setSongs((prev) => prev.map((s) => (s.id === saved.id ? saved : s)));
            setEditing(saved);
          }}
        />
      )}
    </div>
  );
}
