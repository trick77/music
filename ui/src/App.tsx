import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getSession, listSongs, uploadSong, setPublished, deleteSong, postAlign, type Session, type Song } from "./api";
import { TagEditor } from "./TagEditor";
import { Library } from "./Library";
import { QueueDrawer } from "./QueueDrawer";
import { SongMenu } from "./SongMenu";
import { AddToPlaylist } from "./AddToPlaylist";
import { Home } from "./Home";
import { Detail } from "./Detail";
import { Search } from "./Search";
import { StudioPage } from "./StudioPage";
import { PlaylistsPage } from "./PlaylistsPage";
import { PlaylistPage } from "./PlaylistPage";
import { Rail } from "./Rail";
import { PlayerBar } from "./PlayerBar";
import { VisualizerView } from "./VisualizerView";
import { ConfirmDialog } from "./ConfirmDialog";
import { usePlayer } from "./player";
import { useRoute, navigate, parsePlayerParam, pushPlayer, replacePlayer, closePlayer, type PlayerParam } from "./router";
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
  // The mini-player's ⋯ menu has its own open flag rather than reusing menuFor:
  // the playing song can also appear in a visible list, so a shared id-keyed flag
  // would pop both menus at once.
  const [playerMenuOpen, setPlayerMenuOpen] = useState(false);
  const playerMenuRef = useRef<HTMLSpanElement>(null);
  const [deleteFor, setDeleteFor] = useState<Song | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteErr, setDeleteErr] = useState("");
  const [addFor, setAddFor] = useState<Song | null>(null);
  const [showQueue, setShowQueue] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Bumped after uploads / publish toggles to re-fetch views that load their own
  // data (Home), which otherwise wouldn't reflect the change until navigation.
  const [feedVersion, setFeedVersion] = useState(0);
  // Bumped after an upload jump so the Library re-applies its route-derived tab even
  // when the URL is already /unpublished (navigate no-ops on the same path) — e.g. the
  // user had switched to the "All songs" pill while sitting on /unpublished.
  const [tabResetKey, setTabResetKey] = useState(0);
  const uploadRef = useRef<HTMLInputElement>(null);
  const restored = useRef(false);
  // Fires once per mount so auto-opening the full player on a bare /song/:id landing
  // doesn't re-trigger after the user closes it (close strips the param to a bare URL).
  const songOpened = useRef(false);
  // Tracks whether we pushed the history entry that opened the player, so closing
  // it knows whether to pop that entry (in-app open) or strip the param in place
  // (arrived via a fresh deep link with nothing to pop).
  const pushedPlayer = useRef(false);
  // The player overlay's state lives in the URL (source of truth). Re-read on every
  // render — useRoute re-renders on popstate, which our push/replace/close helpers
  // dispatch — so this stays in sync with the address bar.
  const playerParam = parsePlayerParam(window.location.search);
  const authed = !!session?.authenticated;
  const fav = useFavorites(session === null ? null : session.authenticated);

  // The mini-player's ⋯ menu can't lean on SongMenu's own fixed backdrop to
  // dismiss: the player bar sets backdrop-filter, which makes it the containing
  // block for position:fixed descendants, so that backdrop is clamped to the thin
  // bar box instead of covering the viewport. Close on an outside pointer-down or
  // Escape instead. (List rows have no such ancestor, so their backdrop still works.)
  useEffect(() => {
    if (!playerMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!playerMenuRef.current?.contains(e.target as Node)) setPlayerMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPlayerMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [playerMenuOpen]);

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
  // autoplay (spec §15a). Runs once. Skipped on a /song/:id landing: that page
  // plays its own song, and seeding the resumed track first would briefly make it
  // the now-playing song and let the deep-link resync hijack the URL to it.
  useEffect(() => {
    if (restored.current || songs.length === 0) return;
    restored.current = true;
    if (route.name === "song") return;
    player.restore(songs);
  }, [songs, player, route.name]);

  // Landing on a /song/:id share link opens the existing full-screen player over
  // Home. Runs once per mount (cold landing). Cue the song for ANY variant so the
  // overlay has a current track to render; a bare link (no ?player=) additionally
  // opens the overlay in "full" mode, while ?player=lyrics/full keep their chosen mode.
  useEffect(() => {
    if (songOpened.current || route.name !== "song") return;
    const song = songs.find((s) => s.id === route.id);
    if (!song) return; // songs still loading — retry when they arrive
    songOpened.current = true;
    if (song.id !== player.current?.id) player.play(song); // cue it (autoplay is blocked pre-gesture, harmless)
    if (playerParam === null) replacePlayer(song.id, "full"); // open overlay in place — no history entry, pushedPlayer stays false
  }, [songs, route, playerParam, player]);

  // Reset the pushed-entry flag whenever the player closes (by our button, the back
  // button, or a plain navigation), so the next open re-decides how to close.
  useEffect(() => {
    if (playerParam === null) pushedPlayer.current = false;
  }, [playerParam]);

  // While the player is open, keep the URL's song id pointed at the now-playing
  // track so the deep link follows next/prev/queue advances. replace (never push)
  // so skipping tracks doesn't stack the back button.
  useEffect(() => {
    if (playerParam === null || !player.current) return;
    if (route.name === "song" && route.id === player.current.id) return;
    replacePlayer(player.current.id, playerParam);
  }, [playerParam, player.current?.id, route]);

  // Open / switch-mode / close write the overlay state into the URL. Keyed on the
  // now-playing id so the callbacks stay stable across unrelated re-renders (the
  // downgrade effect in PlayerBar depends on onSetMode's identity).
  const curId = player.current?.id;
  const expandPlayer = useCallback((mode: PlayerParam) => {
    if (!curId) return;
    pushedPlayer.current = true;
    pushPlayer(curId, mode);
  }, [curId]);
  const setPlayerMode = useCallback((mode: PlayerParam) => {
    if (!curId) return;
    replacePlayer(curId, mode);
  }, [curId]);
  const closePlayerView = useCallback(() => {
    closePlayer(pushedPlayer.current);
  }, []);

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
      // Land on the Unpublished list — the review-and-publish surface — so the freshly
      // uploaded song is right there with its Publish/Edit menu. A dedupe upload that
      // returns an already-published song wouldn't appear there, so only jump when new.
      if (!song.published) {
        navigate("/unpublished");
        setTabResetKey((k) => k + 1);
      }
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
  //
  // Album tracks share one cover (backend invariant: album_covers applies a cover
  // to every song of the artist+album). So when the updated song carries a cover
  // for a non-empty album, mirror it onto its cached siblings too — otherwise
  // setting a cover on one track would leave the others stale until a reload.
  // Mirror the backend's albumKey/artist name_key: trim + lower-case.
  const norm = (s: string) => s.trim().toLowerCase();
  const propagateSong = (updated: Song) => {
    const key = norm(updated.album);
    const shareCover = key !== "" && updated.coverArtId !== "";
    setSongs((prev) =>
      prev.map((s) => {
        if (s.id === updated.id) return updated;
        if (shareCover && norm(s.artistName) === norm(updated.artistName) && norm(s.album) === key) {
          return s.coverArtId === updated.coverArtId ? s : { ...s, coverArtId: updated.coverArtId };
        }
        return s;
      }),
    );
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
    else flash("Link copied");
  };

  // copyPlayerLink shares the live deep link — while the overlay is open the URL
  // already encodes the song + player state, so the current address is the link.
  const copyPlayerLink = async () => {
    const url = window.location.href;
    if (!(await copyText(url))) window.prompt("Copy this link", url);
    else flash("Link copied");
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

  // playerMenu renders the mini-player's ⋯ overflow menu for the playing track,
  // reusing the same SongMenu (and handlers) as the list rows so behaviour stays
  // identical everywhere. The trigger is styled to match the bar's other 40px icon
  // buttons; SongMenu's useMenuPlacement flips it upward above the docked bar.
  const playerMenu = (song: Song): ReactNode => (
    <span ref={playerMenuRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        aria-label="more"
        onClick={() => setPlayerMenuOpen((o) => !o)}
        style={{ display: "grid", placeItems: "center", width: 40, height: 40, borderRadius: 8, background: "none", border: "none", color: "var(--color-ink)", cursor: "pointer" }}
      >
        <Icon name="moreVertical" size="20px" />
      </button>
      {playerMenuOpen && (
        <SongMenu
          song={song}
          authenticated={authed}
          alignmentEnabled={!!session?.alignmentEnabled}
          onSync={() => syncKaraoke(song)}
          onPlayNext={() => { player.setQueue(playNext(player.queue, song)); setPlayerMenuOpen(false); flash("Playing next"); }}
          onAddToQueue={() => { player.setQueue(addToQueue(player.queue, song)); setPlayerMenuOpen(false); flash("Added to queue"); }}
          onAddToPlaylist={() => { setAddFor(song); setPlayerMenuOpen(false); }}
          onShare={() => shareSong(song)}
          onCopyLyricsLink={() => { setPlayerMenuOpen(false); shareLyricsLink(song); }}
          onEdit={() => { setEditing(song); setPlayerMenuOpen(false); }}
          onPublish={() => { setPlayerMenuOpen(false); togglePublish(song); }}
          onDelete={() => { setPlayerMenuOpen(false); setDeleteErr(""); setDeleteFor(song); }}
          onClose={() => setPlayerMenuOpen(false)}
        />
      )}
    </span>
  );

  const triggerUpload = () => uploadRef.current?.click();

  return (
    <div className="app-shell" style={{ minHeight: "100vh" }}>
      <Rail route={route} authenticated={authed} studioEnabled={!!session?.studioEnabled} authMode={session?.authMode} username={session?.username ?? ""} playerActive={!!player.current} onUpload={triggerUpload} onQueue={() => setShowQueue((v) => !v)} />

      <div style={{ maxWidth: 1080, margin: "0 auto", padding: "1.5rem 1.25rem 9rem" }}>
        {route.name === "home" ? (
          <Home authenticated={authed} onPlay={onPlay} onShare={shareSong} onUpload={triggerUpload} renderRowActions={rowActions} reloadKey={feedVersion} />
        ) : route.name === "search" ? (
          <Search onPlay={onPlay} />
        ) : route.name === "studio" ? (
          authed && session?.studioEnabled ? <StudioPage key={route.genreId ?? "studio"} imageGenEnabled={!!session?.imageGenEnabled} chatEnabled={!!session?.chatEnabled} imageModels={session?.imageModels ?? []} defaultImageModel={session?.defaultImageModel ?? ""} initialGenreId={route.genreId} /> : <Home authenticated={authed} onPlay={onPlay} onShare={shareSong} onUpload={triggerUpload} renderRowActions={rowActions} reloadKey={feedVersion} />
        ) : route.name === "playlist" ? (
          <PlaylistPage key={route.id} id={route.id} authenticated={authed} onPlay={onPlay} onShare={shareUrl} renderRowActions={rowActions} reloadKey={feedVersion} imageGenEnabled={!!session?.imageGenEnabled} chatEnabled={!!session?.chatEnabled} />
        ) : route.name === "playlists" ? (
          <PlaylistsPage authenticated={authed} onPlay={onPlay} />
        ) : route.name === "genre" ? (
          <Detail kind="genre" id={route.id} authenticated={authed} studioEnabled={!!session?.studioEnabled} imageGenEnabled={!!session?.imageGenEnabled} onPlay={onPlay} onShare={shareUrl} renderRowActions={rowActions} reloadKey={feedVersion} />
        ) : route.name === "artist" ? (
          <Detail kind="artist" id={route.id} authenticated={authed} studioEnabled={!!session?.studioEnabled} imageGenEnabled={!!session?.imageGenEnabled} onPlay={onPlay} onShare={shareUrl} renderRowActions={rowActions} reloadKey={feedVersion} />
        ) : route.name === "song" ? (
          // A shared /song/:id link opens the full-screen player overlay (see the
          // auto-open effect); Home sits behind it so closing lands on a real page.
          <Home authenticated={authed} onPlay={onPlay} onShare={shareSong} onUpload={triggerUpload} renderRowActions={rowActions} reloadKey={feedVersion} />
        ) : route.name === "visualizer" ? (
          // Rendered full-screen (fixed) below, outside this constrained wrapper.
          null
        ) : (
          <Library
            songs={songs}
            favoriteIds={fav.ids}
            authenticated={authed}
            studioEnabled={!!session?.studioEnabled}
            imageGenEnabled={!!session?.imageGenEnabled}
            initialTab={route.name === "favorites" ? "favorites" : route.name === "unpublished" ? (authed ? "unpublished" : "all") : route.name === "genres" ? "genres" : "all"}
            tabResetKey={tabResetKey}
            onPlay={(s) => onPlay(s)}
            renderRowActions={rowActions}
          />
        )}
      </div>

      <input ref={uploadRef} type="file" accept=".mp3,audio/mpeg" onChange={onUpload} style={{ display: "none" }} disabled={uploading} />

      <PlayerBar fav={fav} onShare={shareSong} renderMenu={playerMenu} alignmentEnabled={!!session?.alignmentEnabled} open={playerParam !== null} lyrics={playerParam === "lyrics"} onExpand={expandPlayer} onSetMode={setPlayerMode} onClose={closePlayerView} onCopyLink={copyPlayerLink} />

      {route.name === "visualizer" && <VisualizerView fav={fav} onShare={shareSong} />}

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
      {toast && <UploadToast message={toast} uploading={uploading} pct={uploadPct} bottom={player.current ? 120 : 80} />}
      <style>{`.iconbtn, .iconbtn-sm { display: grid; place-items: center; background: transparent; border: none; cursor: pointer; color: var(--color-muted); border-radius: var(--radius-ui); } .iconbtn { width: 40px; height: 40px; } .iconbtn-sm { width: 32px; height: 32px; border-radius: 8px; } .iconbtn:hover, .iconbtn-sm:hover { background: var(--color-active); color: var(--color-ink); } @keyframes app-spin { to { transform: rotate(360deg); } } @keyframes app-upload-indef { 0% { transform: translateX(-110%); } 100% { transform: translateX(310%); } } @media (prefers-reduced-motion: reduce) { [style*="app-upload-indef"] { animation: none !important; } }`}</style>
    </div>
  );
}
