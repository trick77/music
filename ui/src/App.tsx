import { useEffect, useRef, useState, type ReactNode } from "react";
import { getSession, listSongs, uploadSong, setPublished, deleteSong, postAlign, type Session, type Song, type PlaylistDetail } from "./api";
import { TagEditor } from "./TagEditor";
import { Library } from "./Library";
import { PlaylistEditor } from "./PlaylistEditor";
import { QueueDrawer } from "./QueueDrawer";
import { SongMenu } from "./SongMenu";
import { AddToPlaylist } from "./AddToPlaylist";
import { Home } from "./Home";
import { Detail } from "./Detail";
import { Search } from "./Search";
import { StudioPage } from "./StudioPage";
import { Rail } from "./Rail";
import { PlayerBar } from "./PlayerBar";
import { ConfirmDialog } from "./ConfirmDialog";
import { usePlayer } from "./player";
import { useRoute, navigate, parsePlayerParam, clearPlayerParam, type PlayerParam } from "./router";
import { useFavorites } from "./favorites";
import { addToQueue, playNext } from "./queue";
import { songShareUrl, lyricsShareUrl, copyText } from "./share";
import { Icon } from "./Icon";
import { t } from "./ui";

// UploadToast is the bottom-center feedback pill. As a plain flash it stays a
// rounded pill; during an upload it expands to show a determinate progress bar
// and live percentage driven by real byte progress. At 100% the client is done
// but the server is still hashing/deduping, so it swaps to a spinner + an
// indeterminate sweep instead of implying the whole operation has finished.
export function UploadToast({ message, uploading, pct, bottom }: { message: string; uploading: boolean; pct: number; bottom: number }) {
  const finalizing = uploading && pct >= 100;
  return (
    <div style={{ position: "fixed", bottom, left: "50%", transform: "translateX(-50%)", display: "flex", flexDirection: "column", gap: "0.4rem", background: "var(--color-active)", border: "1px solid var(--color-border)", borderRadius: uploading ? 14 : 999, padding: uploading ? "0.55rem 0.9rem" : "0.4rem 1rem", ...t.label, zIndex: 95, minWidth: uploading ? 260 : undefined, maxWidth: "92vw" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        {finalizing && <Icon name="spinner" size="15px" style={{ animation: "app-spin 0.8s linear infinite" }} />}
        <span>{message}</span>
        {uploading && !finalizing && <span style={{ marginLeft: "auto", color: "var(--color-muted)", fontVariantNumeric: "tabular-nums" }}>{pct}%</span>}
      </div>
      {uploading && (
        <div style={{ height: 5, borderRadius: 999, background: "var(--color-border)", overflow: "hidden" }}>
          <div style={finalizing
            ? { height: "100%", width: "40%", borderRadius: 999, background: "linear-gradient(90deg, var(--color-accent), var(--color-accent-strong))", animation: "app-upload-indef 1.1s ease-in-out infinite" }
            : { height: "100%", width: `${pct}%`, borderRadius: 999, background: "linear-gradient(90deg, var(--color-accent), var(--color-accent-strong))", transition: "width 0.15s linear" }} />
        </div>
      )}
    </div>
  );
}

export function App() {
  const route = useRoute();
  const player = usePlayer();
  const [session, setSession] = useState<Session | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [editing, setEditing] = useState<Song | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [deleteFor, setDeleteFor] = useState<Song | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErr, setDeleteErr] = useState("");
  const [addFor, setAddFor] = useState<Song | null>(null);
  const [showQueue, setShowQueue] = useState(false);
  const [editingPlaylist, setEditingPlaylist] = useState<PlaylistDetail | null | "new">(null);
  const [toast, setToast] = useState<string | null>(null);
  // Bumped after uploads / publish toggles to re-fetch views that load their own
  // data (Home), which otherwise wouldn't reflect the change until navigation.
  const [feedVersion, setFeedVersion] = useState(0);
  const [openIntent, setOpenIntent] = useState<PlayerParam | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const restored = useRef(false);
  const authed = !!session?.authenticated;
  const fav = useFavorites(session === null ? null : session.authenticated);

  const refresh = () => listSongs().then(setSongs).catch(() => {});

  // syncKaraoke fires a manual alignment (Generate/Re-sync) and refreshes so the
  // "Syncing" indicator appears. Empty-lyrics is already gated in the menu; the
  // backend also 400s it quietly, so this can never surface an error.
  const syncKaraoke = async (song: Song) => {
    setMenuFor(null);
    const resync = song.alignmentStatus === "ready";
    await postAlign(song.id);
    flash(resync ? "Re-syncing karaoke…" : "Syncing karaoke…");
    refresh();
    setFeedVersion((v) => v + 1);
  };
  useEffect(() => {
    getSession()
      .then(setSession)
      .catch(() => setSession({ authenticated: false, username: "", imageGenEnabled: false, studioEnabled: false, chatEnabled: false, alignmentEnabled: false, imageModels: [], defaultImageModel: "", authMode: "" }));
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

  // Deep-link entry point: when a /song/:id URL carries ?player=…, capture the
  // intent for the player and strip the param so it fires once and the URL settles
  // to a clean /song/:id (entry-point-only, no history pollution).
  useEffect(() => {
    if (route.name !== "song") return;
    const mode = parsePlayerParam(window.location.search);
    if (mode) {
      setOpenIntent(mode);
      clearPlayerParam();
    }
  }, [route]);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2000);
  };

  const onPlay = (song: Song, tail: Song[] = []) => {
    if (player.current?.id === song.id) {
      player.toggle();
    } else {
      player.play(song, tail);
    }
  };

  const confirmDelete = async () => {
    if (!deleteFor || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteErr("");
    try {
      const id = deleteFor.id;
      await deleteSong(id);
      setSongs((prev) => prev.filter((s) => s.id !== id));
      setFeedVersion((v) => v + 1);
      player.remove(id);
      setDeleteFor(null);
      flash("Song deleted");
    } catch {
      setDeleteErr("Could not delete this song. Please try again.");
    } finally {
      setDeleteBusy(false);
    }
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadPct(0);
    // Persistent "Uploading…" toast (no auto-dismiss) until the request settles,
    // so selecting a file gives immediate feedback for the hash/store round-trip.
    setToast(`Uploading “${file.name}”…`);
    try {
      const song = await uploadSong(file, setUploadPct);
      await refresh();
      setFeedVersion((v) => v + 1);
      // New uploads land unpublished — say so, so the user knows where it went.
      flash(song.published ? `Added “${song.title}”` : `Uploaded “${song.title}” — unpublished`);
    } catch {
      flash("Upload failed");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  // propagateSong pushes a server-updated song into every place the app caches
  // song objects: the App-level list (Library/SongPage), the Home/Detail feeds
  // (via feedVersion), and the player store (now-playing bar/queue/history). Used
  // by both tag edits and the publish toggle so an edit shows up everywhere at
  // once without a page reload.
  const propagateSong = (updated: Song) => {
    setSongs((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    setFeedVersion((v) => v + 1);
    player.patchSong(updated);
  };

  // togglePublish flips a song's publish state and reflects it in the loaded
  // list so the Library "Unpublished" pill + row badge update immediately.
  const togglePublish = async (song: Song) => {
    setMenuFor(null);
    try {
      const updated = await setPublished(song.id, !song.published);
      propagateSong(updated);
      flash(updated.published ? "Published" : "Unpublished");
    } catch {
      flash("Couldn't update");
    }
  };

  const shareSong = async (song: Song) => {
    const url = songShareUrl(song.id);
    if (!(await copyText(url))) window.prompt("Copy this link", url);
    else flash("Link copied");
    setMenuFor(null);
  };

  const shareLyricsLink = async (song: Song) => {
    const url = lyricsShareUrl(song.id);
    if (!(await copyText(url))) window.prompt("Copy this link", url);
  };

  const shareUrl = async (url: string) => {
    if (!(await copyText(url))) window.prompt("Copy this link", url);
    else flash("Link copied");
  };

  // rowActions renders the shared favorite star + context menu used by Home,
  // Detail, and Library rows.
  const rowActions = (song: Song): ReactNode => (
    <>
      {/* Unpublished songs are visible only to logged-in users; badge them so
          a signed-in viewer can tell them apart from published ones. */}
      {authed && !song.published && (
        <span
          style={{
            ...t.micro,
            border: "1px solid var(--color-border)",
            borderRadius: 999,
            padding: "0.1rem 0.45rem",
            whiteSpace: "nowrap",
          }}
        >
          Unpublished
        </span>
      )}
      <button
        aria-label="favorite"
        className="iconbtn-sm"
        onClick={() => fav.toggle(song.id)}
        style={{ color: fav.has(song.id) ? "var(--color-accent-strong)" : "var(--color-muted)" }}
      >
        <Icon name={fav.has(song.id) ? "starFilled" : "star"} size="18px" />
      </button>
      <span style={{ position: "relative" }}>
        <button
          aria-label="more"
          className="iconbtn-sm"
          onClick={() => setMenuFor(menuFor === song.id ? null : song.id)}
          style={{ color: "var(--color-muted)" }}
        >
          <Icon name="moreVertical" size="18px" />
        </button>
        {menuFor === song.id && (
          <SongMenu
            song={song}
            authenticated={authed}
            alignmentEnabled={!!session?.alignmentEnabled}
            onSync={() => syncKaraoke(song)}
            onPlayNext={() => { player.setQueue(playNext(player.queue, song)); setMenuFor(null); flash("Playing next"); }}
            onAddToQueue={() => { player.setQueue(addToQueue(player.queue, song)); setMenuFor(null); flash("Added to queue"); }}
            onAddToPlaylist={() => { setAddFor(song); setMenuFor(null); }}
            onShare={() => shareSong(song)}
            onCopyLyricsLink={() => { setMenuFor(null); shareLyricsLink(song); }}
            onEdit={() => { setEditing(song); setMenuFor(null); }}
            onPublish={() => togglePublish(song)}
            onDelete={() => { setMenuFor(null); setDeleteErr(""); setDeleteFor(song); }}
            onClose={() => setMenuFor(null)}
          />
        )}
      </span>
    </>
  );

  const triggerUpload = () => uploadRef.current?.click();

  return (
    <div className="app-shell" style={{ minHeight: "100vh" }}>
      <Rail route={route} authenticated={authed} studioEnabled={!!session?.studioEnabled} authMode={session?.authMode} username={session?.username ?? ""} onUpload={triggerUpload} />

      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "1.5rem 1.25rem 9rem" }}>
        {/* Minimal top chrome: Queue access, no wordmark. */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "1rem", marginBottom: "1rem" }}>
          <button className="iconbtn" aria-label="Queue" title="Queue" onClick={() => setShowQueue(true)}>
            <Icon name="allThreads" size="20px" />
          </button>
        </div>

        {route.name === "home" ? (
          <Home authenticated={authed} onPlay={onPlay} onShare={shareSong} onUpload={triggerUpload} renderRowActions={rowActions} reloadKey={feedVersion} />
        ) : route.name === "search" ? (
          <Search onPlay={onPlay} />
        ) : route.name === "studio" ? (
          authed && session?.studioEnabled ? <StudioPage key={route.genreId ?? "studio"} imageGenEnabled={!!session?.imageGenEnabled} chatEnabled={!!session?.chatEnabled} imageModels={session?.imageModels ?? []} defaultImageModel={session?.defaultImageModel ?? ""} initialGenreId={route.genreId} /> : <Home authenticated={authed} onPlay={onPlay} onShare={shareSong} onUpload={triggerUpload} renderRowActions={rowActions} reloadKey={feedVersion} />
        ) : route.name === "playlist" ? (
          <Detail kind="playlist" id={route.id} authenticated={authed} studioEnabled={!!session?.studioEnabled} imageGenEnabled={!!session?.imageGenEnabled} onPlay={onPlay} onShare={shareUrl} onEditPlaylist={(pl) => setEditingPlaylist(pl)} renderRowActions={rowActions} reloadKey={feedVersion} />
        ) : route.name === "genre" ? (
          <Detail kind="genre" id={route.id} authenticated={authed} studioEnabled={!!session?.studioEnabled} imageGenEnabled={!!session?.imageGenEnabled} onPlay={onPlay} onShare={shareUrl} onEditPlaylist={(pl) => setEditingPlaylist(pl)} renderRowActions={rowActions} reloadKey={feedVersion} />
        ) : route.name === "artist" ? (
          <Detail kind="artist" id={route.id} authenticated={authed} studioEnabled={!!session?.studioEnabled} imageGenEnabled={!!session?.imageGenEnabled} onPlay={onPlay} onShare={shareUrl} onEditPlaylist={(pl) => setEditingPlaylist(pl)} renderRowActions={rowActions} reloadKey={feedVersion} />
        ) : route.name === "song" ? (
          <SongPage id={route.id} songs={songs} onPlay={(s) => onPlay(s)} />
        ) : (
          <Library
            songs={songs}
            favoriteIds={fav.ids}
            authenticated={authed}
            studioEnabled={!!session?.studioEnabled}
            imageGenEnabled={!!session?.imageGenEnabled}
            initialTab={route.name === "favorites" ? "favorites" : route.name === "playlists" ? "playlists" : route.name === "genres" ? "genres" : "all"}
            onPlay={(s) => onPlay(s)}
            renderRowActions={rowActions}
            onNewPlaylist={() => setEditingPlaylist("new")}
          />
        )}
      </div>

      <input ref={uploadRef} type="file" accept=".mp3,audio/mpeg" onChange={onUpload} style={{ display: "none" }} disabled={uploading} />

      <PlayerBar fav={fav} onShare={shareSong} alignmentEnabled={!!session?.alignmentEnabled} openIntent={openIntent} onIntentConsumed={() => setOpenIntent(null)} />

      {showQueue && (
        <QueueDrawer
          queue={player.queue}
          nowPlaying={player.current}
          onChange={player.setQueue}
          onPlay={(i) => { const s = player.queue[i]; onPlay(s, player.queue.slice(i + 1)); }}
          onClose={() => setShowQueue(false)}
        />
      )}
      {editing && <TagEditor song={editing} onClose={() => setEditing(null)} onSaved={(saved) => { propagateSong(saved); setEditing(saved); }} />}
      {deleteFor && (
        <ConfirmDialog
          title="Delete song"
          message={<>Delete “{deleteFor.title}” by {deleteFor.artistName}? This removes it from your library, playlists, and history. This can’t be undone.</>}
          confirmLabel={deleteBusy ? "Deleting" : "Delete"}
          danger
          busy={deleteBusy}
          error={deleteErr}
          onConfirm={confirmDelete}
          onCancel={() => { if (!deleteBusy) setDeleteFor(null); }}
        />
      )}
      {addFor && <AddToPlaylist song={addFor} authenticated={authed} onClose={() => setAddFor(null)} onDone={(name) => { setAddFor(null); flash(`Added to ${name}`); }} />}
      {editingPlaylist !== null && <PlaylistEditor existing={editingPlaylist === "new" ? null : editingPlaylist} onClose={() => setEditingPlaylist(null)} onSaved={(pl) => { setEditingPlaylist(null); navigate(`/playlist/${pl.id}`); }} />}
      {toast && <UploadToast message={toast} uploading={uploading} pct={uploadPct} bottom={player.current ? 120 : 80} />}
      <style>{`.iconbtn, .iconbtn-sm { display: grid; place-items: center; background: transparent; border: none; cursor: pointer; color: var(--color-muted); border-radius: var(--radius-ui); } .iconbtn { width: 40px; height: 40px; } .iconbtn-sm { width: 32px; height: 32px; border-radius: 8px; } .iconbtn:hover, .iconbtn-sm:hover { background: var(--color-active); color: var(--color-ink); } @keyframes app-spin { to { transform: rotate(360deg); } } @keyframes app-upload-indef { 0% { transform: translateX(-110%); } 100% { transform: translateX(310%); } } @media (prefers-reduced-motion: reduce) { [style*="app-upload-indef"] { animation: none !important; } }`}</style>
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
      <p style={t.label}>
        Loading song…{" "}
        <button onClick={() => navigate("/")} style={{ background: "none", border: "none", color: "var(--color-accent-strong)", cursor: "pointer", ...t.ui }}>Home</button>
      </p>
    );
  return (
    <div>
      <button onClick={() => navigate("/")} style={{ background: "none", border: "none", color: "var(--color-accent-strong)", cursor: "pointer", marginBottom: "1rem", ...t.ui }}>← Home</button>
      <h1 style={t.display}>{song.title}</h1>
      <p style={t.label}>{song.artistName}</p>
    </div>
  );
}
