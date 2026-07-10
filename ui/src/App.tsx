import { useEffect, useRef, useState, type ReactNode } from "react";
import { getSession, listSongs, uploadSong, type Session, type Song, type PlaylistDetail } from "./api";
import { TagEditor } from "./TagEditor";
import { Library } from "./Library";
import { PlaylistEditor } from "./PlaylistEditor";
import { QueueDrawer } from "./QueueDrawer";
import { SongMenu } from "./SongMenu";
import { AddToPlaylist } from "./AddToPlaylist";
import { Home } from "./Home";
import { Detail } from "./Detail";
import { Search } from "./Search";
import { Rail } from "./Rail";
import { PlayerBar } from "./PlayerBar";
import { usePlayer } from "./player";
import { useRoute, navigate } from "./router";
import { useFavorites } from "./favorites";
import { addToQueue, playNext } from "./queue";
import { songShareUrl, copyText } from "./share";
import { Glyph } from "./Glyph";

export function App() {
  const route = useRoute();
  const player = usePlayer();
  const [session, setSession] = useState<Session | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [uploading, setUploading] = useState(false);
  const [editing, setEditing] = useState<Song | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [addFor, setAddFor] = useState<Song | null>(null);
  const [showQueue, setShowQueue] = useState(false);
  const [editingPlaylist, setEditingPlaylist] = useState<PlaylistDetail | null | "new">(null);
  const [toast, setToast] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const restored = useRef(false);
  const fav = useFavorites();
  const authed = !!session?.authenticated;

  const refresh = () => listSongs().then(setSongs).catch(() => {});
  useEffect(() => {
    getSession()
      .then(setSession)
      .catch(() => setSession({ authenticated: false, username: "", imageGenEnabled: false, authMode: "" }));
    refresh();
  }, []);

  // Restore the last track + position once songs are available — WITHOUT
  // autoplay (spec §15a). Runs once.
  useEffect(() => {
    if (!restored.current && songs.length > 0) {
      restored.current = true;
      player.restore(songs);
    }
  }, [songs, player]);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2000);
  };

  const onPlay = (song: Song, tail: Song[] = []) => player.play(song, tail);

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await uploadSong(file);
      await refresh();
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const shareSong = async (song: Song) => {
    const url = songShareUrl(song.id);
    if (!(await copyText(url))) window.prompt("Copy this link", url);
    else flash("Link copied");
    setMenuFor(null);
  };

  const shareUrl = async (url: string) => {
    if (!(await copyText(url))) window.prompt("Copy this link", url);
    else flash("Link copied");
  };

  // rowActions renders the shared favorite heart + context menu used by Home,
  // Detail, and Library rows.
  const rowActions = (song: Song): ReactNode => (
    <>
      <button
        aria-label="favorite"
        onClick={() => fav.toggle(song.id)}
        style={{ display: "grid", placeItems: "center", background: "none", border: "none", cursor: "pointer", color: fav.has(song.id) ? "var(--color-accent-strong)" : "var(--color-muted)" }}
      >
        <Glyph name={fav.has(song.id) ? "heartFilled" : "heart"} size={18} />
      </button>
      <span style={{ position: "relative" }}>
        <button
          aria-label="more"
          onClick={() => setMenuFor(menuFor === song.id ? null : song.id)}
          style={{ display: "grid", placeItems: "center", background: "none", border: "none", cursor: "pointer", color: "var(--color-muted)" }}
        >
          <Glyph name="dots" size={18} />
        </button>
        {menuFor === song.id && (
          <SongMenu
            song={song}
            authenticated={authed}
            onPlayNext={() => { player.setQueue(playNext(player.queue, song)); setMenuFor(null); flash("Playing next"); }}
            onAddToQueue={() => { player.setQueue(addToQueue(player.queue, song)); setMenuFor(null); flash("Added to queue"); }}
            onAddToPlaylist={() => { setAddFor(song); setMenuFor(null); }}
            onShare={() => shareSong(song)}
            onEdit={() => { setEditing(song); setMenuFor(null); }}
            onDelete={() => { setMenuFor(null); flash("Delete is coming in a later phase"); }}
            onClose={() => setMenuFor(null)}
          />
        )}
      </span>
    </>
  );

  const triggerUpload = () => uploadRef.current?.click();

  return (
    <div className="app-shell" style={{ minHeight: "100vh" }}>
      <Rail route={route} authenticated={authed} authMode={session?.authMode} username={session?.username ?? ""} onUpload={triggerUpload} />

      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "1.5rem 1.25rem 9rem" }}>
        {/* Minimal top chrome: Queue access, no wordmark. */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginBottom: "1rem" }}>
          <button onClick={() => setShowQueue(true)} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer" }}>Queue</button>
        </div>

        {route.name === "home" ? (
          <Home authenticated={authed} onPlay={onPlay} onShare={shareSong} onUpload={triggerUpload} renderRowActions={rowActions} />
        ) : route.name === "search" ? (
          <Search onPlay={onPlay} />
        ) : route.name === "playlist" ? (
          <Detail kind="playlist" id={route.id} authenticated={authed} imageGenEnabled={!!session?.imageGenEnabled} onPlay={onPlay} onShare={shareUrl} onEditPlaylist={(pl) => setEditingPlaylist(pl)} renderRowActions={rowActions} />
        ) : route.name === "genre" ? (
          <Detail kind="genre" id={route.id} authenticated={authed} imageGenEnabled={!!session?.imageGenEnabled} onPlay={onPlay} onShare={shareUrl} onEditPlaylist={(pl) => setEditingPlaylist(pl)} renderRowActions={rowActions} />
        ) : route.name === "artist" ? (
          <Detail kind="artist" id={route.id} authenticated={authed} imageGenEnabled={!!session?.imageGenEnabled} onPlay={onPlay} onShare={shareUrl} onEditPlaylist={(pl) => setEditingPlaylist(pl)} renderRowActions={rowActions} />
        ) : route.name === "song" ? (
          <SongPage id={route.id} songs={songs} onPlay={(s) => onPlay(s)} />
        ) : (
          <Library
            songs={songs}
            favoriteIds={fav.ids}
            authenticated={authed}
            initialTab={route.name === "favorites" ? "favorites" : route.name === "playlists" ? "playlists" : route.name === "genres" ? "genres" : "all"}
            onPlay={(s) => onPlay(s)}
            renderRowActions={rowActions}
            onNewPlaylist={() => setEditingPlaylist("new")}
          />
        )}
      </div>

      <input ref={uploadRef} type="file" accept=".mp3,audio/mpeg" onChange={onUpload} style={{ display: "none" }} disabled={uploading} />

      <PlayerBar fav={fav} onShare={shareSong} />

      {showQueue && (
        <QueueDrawer
          queue={player.queue}
          nowPlaying={player.current}
          onChange={player.setQueue}
          onPlay={(i) => { const s = player.queue[i]; onPlay(s, player.queue.slice(i + 1)); }}
          onClose={() => setShowQueue(false)}
        />
      )}
      {editing && <TagEditor song={editing} onClose={() => setEditing(null)} onSaved={(saved) => { setSongs((prev) => prev.map((s) => (s.id === saved.id ? saved : s))); setEditing(saved); }} />}
      {addFor && <AddToPlaylist song={addFor} authenticated={authed} onClose={() => setAddFor(null)} onDone={(name) => { setAddFor(null); flash(`Added to ${name}`); }} />}
      {editingPlaylist !== null && <PlaylistEditor existing={editingPlaylist === "new" ? null : editingPlaylist} onClose={() => setEditingPlaylist(null)} onSaved={(pl) => { setEditingPlaylist(null); navigate(`/playlist/${pl.id}`); }} />}
      {toast && <div style={{ position: "fixed", bottom: player.current ? 120 : 80, left: "50%", transform: "translateX(-50%)", background: "var(--color-active)", border: "1px solid var(--color-border)", borderRadius: 999, padding: "0.4rem 1rem", fontSize: "0.85rem", zIndex: 95 }}>{toast}</div>}
    </div>
  );
}

// SongPage is the public share landing for a single song: it plays and resolves
// the song from the loaded list (falling back to a message before the list is
// ready).
function SongPage({ id, songs, onPlay }: { id: string; songs: Song[]; onPlay: (s: Song) => void }) {
  const song = songs.find((s) => s.id === id);
  useEffect(() => {
    if (song) onPlay(song);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.id]);
  if (!song)
    return (
      <p style={{ color: "var(--color-muted)" }}>
        Loading song…{" "}
        <button onClick={() => navigate("/")} style={{ background: "none", border: "none", color: "var(--color-accent-strong)", cursor: "pointer" }}>Home</button>
      </p>
    );
  return (
    <div>
      <button onClick={() => navigate("/")} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", marginBottom: "1rem" }}>← Home</button>
      <h1 style={{ fontFamily: "var(--font-serif)" }}>{song.title}</h1>
      <p style={{ color: "var(--color-muted)" }}>{song.artistName}</p>
    </div>
  );
}
