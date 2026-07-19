import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { getSession, listSongs, uploadSong, setPublished, deleteSong, postAlign, type Session, type Song } from "./api";
import { TagEditor } from "./TagEditor";
import { useEscape } from "./useEscape";
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
import { iconBtn } from "./PlayerControls";
import { VisualizerView } from "./VisualizerView";
import { ConfirmDialog } from "./ConfirmDialog";
import { usePlayer } from "./player";
import { useRoute, navigate, parsePlayerParam, pushPlayer, replacePlayer, leaveLyricsForArtwork, closeToOrigin, type PlayerParam } from "./router";
import { useFavorites } from "./favorites";
import { addToQueue, playNext } from "./queue";
import { songShareUrl, copyText } from "./share";
import { Icon } from "./Icon";
import { t, UnpublishedBadge } from "./ui";

// UploadToast is the bottom-center feedback pill. As a plain flash it stays a
// rounded pill; during an upload it expands to show a determinate progress bar
// and live percentage driven by real byte progress. At 100% the client is done
// but the server is still hashing/deduping, so it swaps to a spinner + an
// indeterminate sweep instead of implying the whole operation has finished.
export function UploadToast({ message, uploading, pct, bottom }: { message: string; uploading: boolean; pct: number; bottom: number }) {
  const finalizing = uploading && pct >= 100;
  return (
    <div style={{ position: "fixed", bottom: `calc(${bottom}px + var(--tabbar-h) + var(--safe-b))`, left: "50%", transform: "translateX(-50%)", display: "flex", flexDirection: "column", gap: "0.4rem", background: "var(--color-active)", border: "1px solid var(--color-border)", borderRadius: uploading ? 14 : 999, padding: uploading ? "0.55rem 0.9rem" : "0.4rem 1rem", ...t.label, zIndex: 95, minWidth: uploading ? 260 : undefined, maxWidth: "92vw" }}>
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
  const appShellRef = useRef<HTMLDivElement>(null);
  // Fires once per mount so auto-opening the full player on a bare /song/:id landing
  // doesn't re-trigger after the user closes it (close strips the param to a bare URL).
  const songOpened = useRef(false);
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
  // Escape goes through the shared stack so an open menu swallows the press
  // instead of also closing the player overlay underneath it.
  useEffect(() => {
    if (!playerMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!playerMenuRef.current?.contains(e.target as Node)) setPlayerMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [playerMenuOpen]);
  useEscape(playerMenuOpen, useCallback(() => setPlayerMenuOpen(false), []));

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
    if (playerParam === null) replacePlayer(song.id, "full"); // open overlay in place — no new entry, and the current one keeps its marker
  }, [songs, route, playerParam, player]);

  // A file dropped anywhere outside a drop zone would otherwise make the browser
  // navigate away to render it, silently discarding the whole SPA session. Swallow
  // stray file drops at the window; the zones stopPropagation on their own drops.
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return;
      e.preventDefault();
    };
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

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
  // Every in-app open pushes an entry, so closing returns to the surface it was
  // launched from — including the big player, when the lyrics view was opened
  // from there.
  const expandPlayer = useCallback((mode: PlayerParam, from?: PlayerParam) => {
    if (!curId) return;
    pushPlayer(curId, mode, from);
  }, [curId]);
  const lyricsUnavailable = useCallback(() => {
    if (!curId) return;
    leaveLyricsForArtwork(curId);
  }, [curId]);
  const closePlayerView = useCallback(() => {
    closeToOrigin();
  }, []);

  // The player can now close itself: finishing the last song with an empty queue
  // clears `current` (next → stop). The overlay lives in the URL, and the
  // URL-follows-current effect above bails once current is null, so without this
  // a stale ?player= would linger — re-opening the overlay on the next play, and
  // surviving a reload. Route it through the same close path as the X so every
  // close lands on one destination.
  //
  // hadCurrent gates this to a real null *transition*. A cold landing on
  // /song/:id?player=full starts with current === null until the deep-link effect
  // above cues the track; closing on that would break share links.
  const hadCurrent = useRef(false);
  useEffect(() => {
    if (player.current) {
      hadCurrent.current = true;
      return;
    }
    if (!hadCurrent.current) return;
    hadCurrent.current = false;
    // Home, not the trigger point: this is playback ending, not the viewer
    // dismissing a view they opened. Stepping back one entry could also land on
    // another player state (the big player the lyrics view was opened from),
    // which now has no song to show — and would leave a stale ?player= behind to
    // re-open the overlay on the next play.
    if (playerParam !== null || route.name === "visualizer") navigate("/");
  }, [player.current, playerParam, route.name]);

  // iPadOS WebKit leaves stale compositor layers behind when the full-screen
  // visualizer overlay (position:fixed, filter:blur + transform:scale, z-95) is
  // torn down: on the FIRST close the mini dock keeps a frozen backdrop-filter
  // snapshot and the hero carousel (permanent will-change:transform) never
  // repaints — both clear only on reload. Nudging a translateZ(0) transform on
  // the app shell for one frame as we leave /visualizer forces WebKit to rebuild
  // those descendant layers, invalidating the stale snapshots. translateZ(0) has
  // no visual offset, so it's a no-op on browsers that don't have the bug.
  const prevRouteName = useRef(route.name);
  const nudgeRaf = useRef<number>(0);
  useEffect(() => {
    const leftVisualizer = prevRouteName.current === "visualizer" && route.name !== "visualizer";
    prevRouteName.current = route.name;
    if (!leftVisualizer) return;
    const shell = appShellRef.current;
    if (!shell) return;
    nudgeRaf.current = requestAnimationFrame(() => {
      shell.style.transform = "translateZ(0)";
      nudgeRaf.current = requestAnimationFrame(() => { shell.style.transform = ""; });
    });
    // Clear the transform in cleanup too: a second navigation landing between the
    // two frames would otherwise cancel the frame that resets it, stranding
    // translateZ(0) on the shell — which itself makes app-shell the containing
    // block for the fixed dock/rail and mis-positions them until the next reload.
    return () => {
      if (nudgeRaf.current) cancelAnimationFrame(nudgeRaf.current);
      shell.style.transform = "";
    };
  }, [route.name]);

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

  const shareUrl = async (url: string) => {
    if (!(await copyText(url))) window.prompt("Copy this link", url);
    else flash("Link copied");
  };

  // rowActions renders the shared favorite star + context menu used by Home,
  // Detail, and Library rows.
  const rowActions = (song: Song): ReactNode => (
    <>
      {/* Unpublished songs are visible only to logged-in users; badge them so
          a signed-in viewer can tell them apart from published ones. The phone
          placement of this pill lives on the row's meta line — see
          UnpublishedBadge. */}
      <UnpublishedBadge show={authed && !song.published} placement="actions" />
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
      {/* iconBtn, not a copy of it: this sits in the mini bar's action row and
          must carry the same muted tint as the rest of them. */}
      <button
        aria-label="more"
        onClick={() => setPlayerMenuOpen((o) => !o)}
        style={iconBtn}
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
    <div ref={appShellRef} className="app-shell" style={{ minHeight: "100vh" }}>
      <Rail route={route} authenticated={authed} studioEnabled={!!session?.studioEnabled} authMode={session?.authMode} username={session?.username ?? ""} playerActive={!!player.current} onUpload={triggerUpload} onQueue={() => setShowQueue((v) => !v)} />

      <div className="page-shell">
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

      <PlayerBar fav={fav} onShare={shareSong} renderMenu={playerMenu} alignmentEnabled={!!session?.alignmentEnabled} open={playerParam !== null} lyrics={playerParam === "lyrics"} onExpand={expandPlayer} onLyricsUnavailable={lyricsUnavailable} onClose={closePlayerView} />

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
      {/* key on the id so a different song remounts: the editor's field state and its
          fetched play stats are seeded per song and would otherwise persist. */}
      {editing && <TagEditor key={editing.id} song={editing} onClose={() => setEditing(null)} onSaved={(saved) => { propagateSong(saved); setEditing(saved); }} />}
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
