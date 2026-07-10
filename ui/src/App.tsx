import { useEffect, useRef, useState } from "react";
import { getSession, listSongs, uploadSong, streamUrl, type Session, type Song, type PlaylistDetail } from "./api";
import { TagEditor } from "./TagEditor";
import { Library } from "./Library";
import { PlaylistView } from "./PlaylistDetail";
import { PlaylistEditor } from "./PlaylistEditor";
import { QueueDrawer } from "./QueueDrawer";
import { SongMenu } from "./SongMenu";
import { AddToPlaylist } from "./AddToPlaylist";
import { useRoute, navigate } from "./router";
import { useFavorites } from "./favorites";
import { addToQueue, playNext } from "./queue";
import { songShareUrl, copyText } from "./share";

export function App() {
  const route = useRoute();
  const [session, setSession] = useState<Session | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [nowPlaying, setNowPlaying] = useState<Song | null>(null);
  const [queue, setQueue] = useState<Song[]>([]);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<Song | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [addFor, setAddFor] = useState<Song | null>(null);
  const [showQueue, setShowQueue] = useState(false);
  const [editingPlaylist, setEditingPlaylist] = useState<PlaylistDetail | null | "new">(null);
  const [toast, setToast] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const fav = useFavorites();
  const authed = !!session?.authenticated;

  const refresh = () => listSongs().then(setSongs).catch(() => {});
  useEffect(() => {
    getSession().then(setSession).catch(() => setSession({ authenticated: false, username: "" }));
    refresh();
  }, []);

  const flash = (msg: string) => { setToast(msg); window.setTimeout(() => setToast(null), 2000); };

  const play = (song: Song, upNext: Song[] = []) => {
    setNowPlaying(song);
    setQueue(upNext);
    requestAnimationFrame(() => { const el = audioRef.current; if (el) { el.load(); void el.play().catch(() => {}); } });
  };

  const onEnded = () => {
    if (queue.length === 0) return;
    const [next, ...rest] = queue;
    setNowPlaying(next);
    setQueue(rest);
    requestAnimationFrame(() => { const el = audioRef.current; if (el) { el.load(); void el.play().catch(() => {}); } });
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try { await uploadSong(file); await refresh(); } finally { setUploading(false); e.target.value = ""; }
  };

  const share = async (song: Song) => {
    const url = songShareUrl(song.id);
    if (!(await copyText(url))) window.prompt("Copy this link", url);
    else flash("Link copied");
    setMenuFor(null);
  };

  const rowActions = (song: Song) => (
    <>
      <button aria-label="favorite" onClick={() => fav.toggle(song.id)}
        style={{ background: "none", border: "none", cursor: "pointer", fontSize: "1rem",
          color: fav.has(song.id) ? "var(--color-accent-strong)" : "var(--color-muted)" }}>
        {fav.has(song.id) ? "♥" : "♡"}
      </button>
      <span style={{ position: "relative" }}>
        <button aria-label="more" onClick={() => setMenuFor(menuFor === song.id ? null : song.id)}
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--color-muted)", fontSize: "1.1rem" }}>⋯</button>
        {menuFor === song.id && (
          <SongMenu song={song} authenticated={authed}
            onPlayNext={() => { setQueue((q) => playNext(q, song)); setMenuFor(null); flash("Playing next"); }}
            onAddToQueue={() => { setQueue((q) => addToQueue(q, song)); setMenuFor(null); flash("Added to queue"); }}
            onAddToPlaylist={() => { setAddFor(song); setMenuFor(null); }}
            onShare={() => share(song)}
            onEdit={() => { setEditing(song); setMenuFor(null); }}
            onDelete={() => { setMenuFor(null); flash("Delete is coming in a later phase"); }}
            onClose={() => setMenuFor(null)} />
        )}
      </span>
    </>
  );

  return (
    <div style={{ minHeight: "100vh", maxWidth: 820, margin: "0 auto", padding: "2rem 1.25rem 8rem" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
        <h1 onClick={() => navigate("/")} style={{ fontFamily: "var(--font-serif)", fontSize: "1.75rem", margin: 0, cursor: "pointer" }}>Music</h1>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          <button onClick={() => setShowQueue(true)} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer" }}>Queue</button>
          {authed && (
            <label style={{ cursor: "pointer", color: "var(--color-accent-strong)", fontSize: "0.95rem" }}>
              {uploading ? "Uploading…" : "Upload"}
              <input type="file" accept=".mp3,audio/mpeg" onChange={onUpload} style={{ display: "none" }} disabled={uploading} />
            </label>
          )}
        </div>
      </header>

      {route.name === "playlist" ? (
        <PlaylistView id={route.id} authenticated={authed}
          onPlay={(s, q) => play(s, q)} onEdit={(pl) => setEditingPlaylist(pl)} />
      ) : route.name === "song" ? (
        <SongPage id={route.id} songs={songs} onPlay={(s) => play(s)} />
      ) : (
        <Library songs={songs} favoriteIds={fav.ids} authenticated={authed}
          initialTab={route.name === "favorites" ? "favorites" : route.name === "playlists" ? "playlists" : "all"}
          onPlay={(s) => play(s)} renderRowActions={rowActions}
          onNewPlaylist={() => setEditingPlaylist("new")} />
      )}

      {nowPlaying && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: 0, background: "var(--color-panel)", borderTop: "1px solid var(--color-border)", padding: "0.75rem 1.25rem" }}>
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem", fontSize: "0.9rem" }}>
              <span><strong>{nowPlaying.title}</strong><span style={{ color: "var(--color-muted)" }}> — {nowPlaying.artistName}</span></span>
              <button aria-label="favorite-now" onClick={() => fav.toggle(nowPlaying.id)} style={{ background: "none", border: "none", cursor: "pointer", color: fav.has(nowPlaying.id) ? "var(--color-accent-strong)" : "var(--color-muted)" }}>{fav.has(nowPlaying.id) ? "♥" : "♡"}</button>
            </div>
            <audio ref={audioRef} controls onEnded={onEnded} style={{ width: "100%" }} src={streamUrl(nowPlaying.id)}><track kind="captions" /></audio>
          </div>
        </div>
      )}

      {showQueue && <QueueDrawer queue={queue} nowPlaying={nowPlaying} onChange={setQueue} onPlay={(i) => { const s = queue[i]; play(s, queue.slice(i + 1)); }} onClose={() => setShowQueue(false)} />}
      {editing && <TagEditor song={editing} onClose={() => setEditing(null)} onSaved={(saved) => { setSongs((prev) => prev.map((s) => (s.id === saved.id ? saved : s))); setEditing(saved); }} />}
      {addFor && <AddToPlaylist song={addFor} authenticated={authed} onClose={() => setAddFor(null)} onDone={(name) => { setAddFor(null); flash(`Added to ${name}`); }} />}
      {editingPlaylist !== null && <PlaylistEditor existing={editingPlaylist === "new" ? null : editingPlaylist} onClose={() => setEditingPlaylist(null)} onSaved={(pl) => { setEditingPlaylist(null); navigate(`/playlist/${pl.id}`); }} />}
      {toast && <div style={{ position: "fixed", bottom: nowPlaying ? 120 : 24, left: "50%", transform: "translateX(-50%)", background: "var(--color-active)", border: "1px solid var(--color-border)", borderRadius: 999, padding: "0.4rem 1rem", fontSize: "0.85rem", zIndex: 80 }}>{toast}</div>}
    </div>
  );
}

// SongPage is the public share landing for a single song: it plays and offers
// the same controls, resolving the song from the loaded list (falling back to a
// fetch if a deep link lands before the list is ready).
function SongPage({ id, songs, onPlay }: { id: string; songs: Song[]; onPlay: (s: Song) => void }) {
  const song = songs.find((s) => s.id === id);
  useEffect(() => { if (song) onPlay(song); }, [song?.id]);
  if (!song) return <p style={{ color: "var(--color-muted)" }}>Loading song… <button onClick={() => navigate("/")} style={{ background: "none", border: "none", color: "var(--color-accent-strong)", cursor: "pointer" }}>Home</button></p>;
  return (
    <div>
      <button onClick={() => navigate("/")} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", marginBottom: "1rem" }}>← Home</button>
      <h1 style={{ fontFamily: "var(--font-serif)" }}>{song.title}</h1>
      <p style={{ color: "var(--color-muted)" }}>{song.artistName}</p>
    </div>
  );
}
