import { useEffect, useState, type ReactNode } from "react";
import {
  addSongToPlaylist, applyPlaylistCover, deletePlaylist, generateStudioCoverArt, getPlaylist, listSongs,
  refinePlaylistPrompt, removeSongFromPlaylist, reorderPlaylist, setPlaylistPublished, studioCoverArtUrl,
  suggestPlaylistDescriptions, suggestPlaylistPrompt, updatePlaylist, updatePlaylistDescription,
  uploadPlaylistCover,
  type PlaylistDetail, type Song,
} from "./api";
import { coverUrl, coverInitial } from "./cover";
import { IMAGE_ACCEPT, useImageDrop } from "./imageDrop";
import { navigate } from "./router";
import { playlistShareUrl } from "./share";
import { shuffle } from "./player";
import { Glyph } from "./Glyph";
import { Icon } from "./Icon";
import { RefineRow } from "./StudioShared";
import { Button, Spinner, controlClass, fieldLabel, t, UnpublishedBadge } from "./ui";

type Props = {
  id: string;
  authenticated: boolean;
  onPlay: (s: Song, tail: Song[]) => void;
  onShare: (url: string) => void;
  renderRowActions: (s: Song) => ReactNode;
  /** Bump to force a re-fetch of this page's songs (e.g. after a tag edit). */
  reloadKey?: number;
  /** Whether image generation is configured (gates the AI cover-art panel). */
  imageGenEnabled?: boolean;
  /** Whether a chat model is configured (gates AI prompt/description suggestions). */
  chatEnabled?: boolean;
};

// CoverSquare renders the playlist's 120px cover. When editable it is both a file
// picker (click) and a drop target; when not, it is the same square without the
// affordances, so the page looks identical to anonymous viewers.
function CoverSquare(p: {
  editable: boolean;
  dropping: boolean;
  busy: boolean;
  dropProps: Record<string, unknown>;
  onPick: (e: React.ChangeEvent<HTMLInputElement>) => void;
  error: string | null;
  children: ReactNode;
}) {
  const box: React.CSSProperties = {
    position: "relative", width: 120, height: 120, flexShrink: 0, borderRadius: 12, overflow: "hidden",
    background: "var(--color-active)", display: "grid", placeItems: "center",
    border: p.dropping ? "2px dashed var(--color-accent-strong)" : "1px solid var(--color-border)",
  };
  if (!p.editable) return <span style={box}>{p.children}</span>;
  return (
    <div style={{ flexShrink: 0 }}>
      <label {...p.dropProps} title="Click or drop an image to set the cover" style={{ ...box, cursor: "pointer" }}>
        {p.children}
        {(p.dropping || p.busy) && (
          <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.55)", color: "#fff", fontSize: "var(--text-label)", textAlign: "center", padding: 6 }}>
            {p.busy ? <Spinner size="18px" /> : "Drop to set cover"}
          </span>
        )}
        <input type="file" accept={IMAGE_ACCEPT} onChange={p.onPick} style={{ display: "none" }} />
      </label>
      {p.error && <p role="alert" style={{ color: "var(--color-accent-strong)", fontSize: "var(--text-label)", margin: "0.35rem 0 0", maxWidth: 120 }}>{p.error}</p>}
    </div>
  );
}

// defaultTone picks which suggested description tone is pre-selected when the
// chips first render. Evocative reads best as a default playlist blurb — punchy
// can feel like ad copy and factual can feel dry — so it wins ties.
export function defaultTone(): "punchy" | "evocative" | "factual" {
  return "evocative";
}

// PlaylistPage is the dedicated single-playlist destination (mockup Decision
// 2B): a square cover sits beside the metadata rather than behind a
// full-bleed hero, closer to a "product" page than the genre/artist
// immersive template. It owns the getPlaylist fetch; PlaylistPageView below
// is the pure body, split out for testing the same way PlaylistsPage is.
export function PlaylistPage({ id, authenticated, onPlay, onShare, renderRowActions, reloadKey, imageGenEnabled = false, chatEnabled = false }: Props) {
  const [playlist, setPlaylist] = useState<PlaylistDetail | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = () => getPlaylist(id).then(setPlaylist).catch(() => setNotFound(true));

  // Clear stale content only when navigating to a different playlist, mirroring
  // Detail's behavior: a reloadKey bump must not null the view (that would
  // flash "Loading…" over the current page).
  useEffect(() => {
    setPlaylist(null);
    setNotFound(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, reloadKey]);

  const togglePublish = async () => {
    if (!playlist) return;
    try {
      setPlaylist(await setPlaylistPublished(playlist.id, !playlist.published));
    } catch {
      /* leave state as-is on failure */
    }
  };

  if (notFound) {
    return (
      <p style={{ color: "var(--color-muted)" }}>
        Not found.{" "}
        <button onClick={() => navigate("/")} style={linkBtn}>Home</button>
      </p>
    );
  }

  return (
    <PlaylistPageView
      playlist={playlist}
      authenticated={authenticated}
      onPlay={onPlay}
      onShare={onShare}
      renderRowActions={renderRowActions}
      onTogglePublish={togglePublish}
      onPlaylistUpdate={setPlaylist}
      imageGenEnabled={imageGenEnabled}
      chatEnabled={chatEnabled}
    />
  );
}

type ViewProps = {
  playlist: PlaylistDetail | null;
  authenticated: boolean;
  onPlay: (s: Song, tail: Song[]) => void;
  onShare: (url: string) => void;
  renderRowActions: (s: Song) => ReactNode;
  onTogglePublish: () => void;
  /** Applies a mutated PlaylistDetail (e.g. after a reorder/add/remove) back to the owning state. */
  onPlaylistUpdate?: (p: PlaylistDetail) => void;
  /** Test-only override for the initial edit-mode state (bypasses the `?edit=1` URL check). */
  initialEditing?: boolean;
  imageGenEnabled?: boolean;
  chatEnabled?: boolean;
};

export function PlaylistPageView({ playlist, authenticated, onPlay, onShare, renderRowActions, onTogglePublish, onPlaylistUpdate, initialEditing, imageGenEnabled = false, chatEnabled = false }: ViewProps) {
  const [editing, setEditing] = useState(
    () => initialEditing ?? (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("edit") === "1"),
  );
  const [name, setName] = useState(playlist?.name ?? "");
  const [description, setDescription] = useState(playlist?.description ?? "");
  const [drag, setDrag] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [allSongs, setAllSongs] = useState<Song[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // AI cover art panel state.
  const [coverPrompt, setCoverPrompt] = useState("");
  const [suggestingCover, setSuggestingCover] = useState(false);
  const [refiningCover, setRefiningCover] = useState(false);
  const [generatingCover, setGeneratingCover] = useState(false);
  const [applyingCover, setApplyingCover] = useState(false);
  const [generatedCoverId, setGeneratedCoverId] = useState<string | null>(null);
  const [coverErr, setCoverErr] = useState<string | null>(null);
  // Kept separate from coverErr: that one lives inside the AI-cover panel, which
  // is hidden when image generation is off — an upload error must show regardless.
  const [coverUploadErr, setCoverUploadErr] = useState<string | null>(null);
  const [uploadingCover, setUploadingCover] = useState(false);

  // AI description tone chips state.
  const [tones, setTones] = useState<{ punchy: string; evocative: string; factual: string } | null>(null);
  const [selectedTone, setSelectedTone] = useState<"punchy" | "evocative" | "factual">(defaultTone());
  const [suggestingTones, setSuggestingTones] = useState(false);
  const [toneErr, setToneErr] = useState<string | null>(null);

  // Re-seed the local name/description drafts only when a different playlist
  // loads — not on every playlist prop update — so an in-progress edit isn't
  // clobbered by an unrelated mutation (e.g. reordering songs).
  useEffect(() => {
    setName(playlist?.name ?? "");
    setDescription(playlist?.description ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist?.id]);

  // Dropping (or picking) an image sets the playlist cover directly, alongside
  // the AI-generated route further down. One success path for both entry points.
  // Declared above the loading early-return: useImageDrop is a hook, so it has to
  // run on every render, including the one where playlist is still null.
  const applyCoverFile = async (file: File) => {
    if (!playlist) return;
    setCoverUploadErr(null);
    setUploadingCover(true);
    try {
      // PUT /playlists/{id}/cover already responds with the full reloaded detail,
      // so its return value is what a refetch would give — no second roundtrip.
      onPlaylistUpdate?.(await uploadPlaylistCover(playlist.id, file));
    } catch {
      setCoverUploadErr("Cover upload failed");
    } finally {
      setUploadingCover(false);
    }
  };

  const onPickCover = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await applyCoverFile(file);
    e.target.value = "";
  };

  const { dropping: coverDropping, dropProps: coverDropProps } = useImageDrop({
    onFile: applyCoverFile,
    onReject: setCoverUploadErr,
    disabled: !authenticated,
  });

  if (!playlist) return <p style={{ color: "var(--color-muted)" }}>Loading…</p>;
  const { songs } = playlist;

  const commitName = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === playlist.name) {
      setName(playlist.name);
      return;
    }
    try {
      onPlaylistUpdate?.(await updatePlaylist(playlist.id, trimmed, playlist.description));
    } catch {
      setName(playlist.name);
    }
  };

  const commitDescriptionText = async (text: string) => {
    if (text === playlist.description) return;
    try {
      onPlaylistUpdate?.(await updatePlaylistDescription(playlist.id, text));
    } catch {
      setDescription(playlist.description);
    }
  };

  const commitDescription = () => commitDescriptionText(description);

  // pickTone fills the description field with a suggested tone's text and saves
  // it immediately (a chip click doesn't blur the textarea, so onBlur won't fire).
  const pickTone = (text: string) => {
    setDescription(text);
    commitDescriptionText(text);
  };

  const onSuggestCoverPrompt = async () => {
    setSuggestingCover(true); setCoverErr(null);
    try {
      const { prompt } = await suggestPlaylistPrompt(playlist.id);
      setCoverPrompt(prompt);
    } catch {
      setCoverErr("Could not suggest a prompt");
    } finally {
      setSuggestingCover(false);
    }
  };

  const onRefineCoverPrompt = async (instruction: string) => {
    if (!coverPrompt.trim()) return;
    setRefiningCover(true); setCoverErr(null);
    try {
      const { prompt } = await refinePlaylistPrompt(playlist.id, coverPrompt.trim(), instruction);
      setCoverPrompt(prompt);
    } catch {
      setCoverErr("Could not refine the prompt");
    } finally {
      setRefiningCover(false);
    }
  };

  const onGenerateCover = async () => {
    if (!coverPrompt.trim() || songs.length === 0) return;
    setGeneratingCover(true); setCoverErr(null); setGeneratedCoverId(null);
    try {
      const res = await generateStudioCoverArt(coverPrompt.trim(), "");
      setGeneratedCoverId(res.id);
    } catch (e) {
      setCoverErr((e as Error).message || "Cover art generation failed");
    } finally {
      setGeneratingCover(false);
    }
  };

  const onApplyCover = async () => {
    if (!generatedCoverId) return;
    setApplyingCover(true); setCoverErr(null);
    try {
      await applyPlaylistCover(playlist.id, generatedCoverId);
      onPlaylistUpdate?.(await getPlaylist(playlist.id));
      setGeneratedCoverId(null);
    } catch {
      setCoverErr("Could not apply the cover");
    } finally {
      setApplyingCover(false);
    }
  };

  const onSuggestTones = async () => {
    setSuggestingTones(true); setToneErr(null);
    try {
      const result = await suggestPlaylistDescriptions(playlist.id);
      setTones(result);
      setSelectedTone(defaultTone());
    } catch {
      setToneErr("Could not suggest descriptions");
    } finally {
      setSuggestingTones(false);
    }
  };

  const selectTone = (key: "punchy" | "evocative" | "factual") => {
    if (!tones) return;
    setSelectedTone(key);
    pickTone(tones[key]);
  };

  const onAddFocus = async () => {
    if (allSongs.length === 0) setAllSongs(await listSongs());
  };

  const addSong = async (song: Song) => {
    try {
      onPlaylistUpdate?.(await addSongToPlaylist(playlist.id, song.id));
      setQuery("");
    } catch {
      /* leave list as-is on failure */
    }
  };

  const removeSong = async (song: Song) => {
    try {
      onPlaylistUpdate?.(await removeSongFromPlaylist(playlist.id, song.id));
    } catch {
      /* leave list as-is on failure */
    }
  };

  const onRowDrop = async (to: number) => {
    if (drag === null) return;
    const ids = songs.map((s) => s.id);
    const [moved] = ids.splice(drag, 1);
    ids.splice(to, 0, moved);
    setDrag(null);
    try {
      onPlaylistUpdate?.(await reorderPlaylist(playlist.id, ids));
    } catch {
      /* leave order as-is on failure */
    }
  };

  const onDeleteClick = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await deletePlaylist(playlist.id);
      navigate("/playlists");
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const matches = query
    ? allSongs.filter((s) => `${s.title} ${s.artistName}`.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
    : [];

  const play = () => {
    if (songs.length > 0) onPlay(songs[0], songs.slice(1));
  };
  const shufflePlay = () => {
    if (songs.length === 0) return;
    const s = shuffle(songs);
    onPlay(s[0], s.slice(1));
  };

  return (
    <div>
      <button onClick={() => history.back()} aria-label="Back" style={{ ...linkBtn, width: 40, height: 40, display: "grid", placeItems: "center", marginBottom: "0.5rem" }}>
        <Icon name="chevronLeft" size="24px" />
      </button>

      <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Signed in, the cover doubles as an upload target — click to pick or drop
            an image on it. Anonymous viewers get the same square, inert. */}
        <CoverSquare
          editable={authenticated}
          dropping={coverDropping}
          busy={uploadingCover}
          dropProps={coverDropProps}
          onPick={onPickCover}
          error={coverUploadErr}
        >
          {playlist.coverArtId ? (
            <img src={coverUrl(playlist.coverArtId, "card")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <span style={{ fontFamily: "var(--font-serif)", color: "var(--color-muted)", fontSize: "2rem" }}>{coverInitial(playlist.name)}</span>
          )}
        </CoverSquare>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: "var(--text-micro)", letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--color-muted)" }}>
            Playlist
            {authenticated && !playlist.published && (
              <span style={{ marginLeft: 8, padding: "0.1rem 0.45rem", borderRadius: 999, border: "1px solid var(--color-border)", fontSize: "var(--text-micro)" }}>Unpublished</span>
            )}
          </div>
          <h1 style={{ margin: "0.15rem 0 0.35rem", fontFamily: "var(--font-serif)", fontSize: "clamp(1.6rem, 3.6vw, 2.4rem)", color: "var(--color-ink)" }}>{playlist.name}</h1>
          {playlist.description && <p style={{ margin: "0 0 0.35rem", color: "var(--color-muted)" }}>{playlist.description}</p>}
          <p style={{ margin: 0, color: "var(--color-muted)" }}>{songs.length} {songs.length === 1 ? "song" : "songs"}</p>
        </div>
      </div>

      <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap", marginTop: "1rem" }}>
        {songs.length > 0 && (
          <button onClick={play} style={pillPrimary}>
            <Glyph name="play" size={18} /> Play
          </button>
        )}
        {songs.length > 0 && (
          <button onClick={shufflePlay} style={pillGhost}>
            <Icon name="shuffle" size="18px" /> Shuffle
          </button>
        )}
        {authenticated && (
          <button onClick={() => setEditing((v) => { const next = !v; if (!next) setConfirmDelete(false); return next; })} style={pillGhost}>
            {editing ? "Done" : "Edit"}
          </button>
        )}
        {authenticated && (
          <button onClick={onTogglePublish} style={pillGhost}>
            <Icon name="globe" size="18px" /> {playlist.published ? "Unpublish" : "Publish"}
          </button>
        )}
        <button onClick={() => onShare(playlistShareUrl(playlist.id))} style={pillGhost}>
          <Icon name="share" size="18px" /> Share
        </button>
      </div>

      {editing && authenticated && (
        <div className="glass" style={{ borderRadius: 16, marginTop: "1rem", padding: "1rem" }}>
          <label style={fieldLabel}>Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            className={controlClass}
          />
          <label style={{ ...fieldLabel, marginTop: "0.75rem" }}>Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={commitDescription}
            rows={2}
            className={controlClass}
          />

          {chatEnabled && (
            <div style={{ marginTop: "0.9rem", paddingTop: "0.9rem", borderTop: "1px solid var(--color-border)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <label style={{ ...fieldLabel, marginBottom: 0 }}>AI description</label>
                <Button variant="ghost" small busy={suggestingTones} onClick={onSuggestTones}>
                  {!suggestingTones && <Icon name="feather" size="14px" />}Suggest descriptions
                </Button>
              </div>
              {toneErr && <p role="alert" style={{ color: "var(--color-accent-strong)", fontSize: "var(--text-label)", margin: "0.35rem 0" }}>{toneErr}</p>}
              {tones && (
                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                  {(["punchy", "evocative", "factual"] as const).map((key) => (
                    <button
                      key={key}
                      onClick={() => selectTone(key)}
                      title={tones[key]}
                      style={{
                        ...pillGhost,
                        padding: "0.4rem 0.85rem",
                        fontSize: "var(--text-label)",
                        borderColor: selectedTone === key ? "var(--color-accent-strong)" : "var(--color-border)",
                        background: selectedTone === key ? "var(--color-accent-fill)" : "var(--color-active)",
                      }}
                    >
                      {key === "punchy" ? "Punchy" : key === "evocative" ? "Evocative" : "Factual"}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {imageGenEnabled && (
            <div style={{ marginTop: "0.9rem", paddingTop: "0.9rem", borderTop: "1px solid var(--color-border)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <label style={{ ...fieldLabel, marginBottom: 0 }}>AI cover art</label>
                {chatEnabled && (
                  <Button variant="ghost" small busy={suggestingCover} onClick={onSuggestCoverPrompt}>
                    {!suggestingCover && <Icon name="feather" size="14px" />}Suggest from songs
                  </Button>
                )}
              </div>
              <textarea
                aria-label="Cover art prompt"
                value={coverPrompt}
                onChange={(e) => setCoverPrompt(e.target.value)}
                placeholder="Describe the cover — a single strong subject, palette, mood…"
                rows={3}
                className={controlClass}
                style={{ marginBottom: "0.6rem" }}
              />
              {chatEnabled && (
                <RefineRow
                  onRefine={onRefineCoverPrompt}
                  busy={refiningCover}
                  disabled={generatingCover || coverPrompt.trim() === ""}
                />
              )}
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                <Button busy={generatingCover} disabled={generatingCover || coverPrompt.trim() === "" || songs.length === 0} onClick={onGenerateCover}>
                  {generatingCover ? "Generating" : generatedCoverId ? "Regenerate" : "Generate"}
                </Button>
                {songs.length === 0 && <span style={t.label}>Add songs before generating a cover.</span>}
              </div>
              {generatingCover && (
                <div aria-live="polite" aria-busy="true" style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "var(--color-muted)", marginTop: "0.6rem" }}>
                  <Spinner size="18px" /><span>Generating cover</span>
                </div>
              )}
              {coverErr && <p role="alert" style={{ color: "var(--color-accent-strong)", fontSize: "var(--text-label)", margin: "0.6rem 0 0" }}>{coverErr}</p>}
              {generatedCoverId && !generatingCover && (
                <div style={{ marginTop: "0.75rem" }}>
                  <img
                    src={studioCoverArtUrl(generatedCoverId)}
                    alt="Generated playlist cover"
                    style={{ width: 160, height: 160, objectFit: "cover", borderRadius: "var(--radius-ui)", border: "1px solid var(--color-border)", display: "block" }}
                  />
                  <Button variant="secondary" small busy={applyingCover} onClick={onApplyCover} style={{ marginTop: "0.6rem" }}>
                    Apply
                  </Button>
                </div>
              )}
            </div>
          )}

          <label style={{ ...fieldLabel, marginTop: "0.9rem" }}>Add songs</label>
          <input
            placeholder="Search by title or artist…"
            value={query}
            onFocus={onAddFocus}
            onChange={(e) => setQuery(e.target.value)}
            className={controlClass}
          />
          {matches.map((song) => (
            <button key={song.id} onClick={() => addSong(song)} style={suggestionStyle}>
              {song.title} — <span style={{ color: "var(--color-muted)" }}>{song.artistName}</span>
            </button>
          ))}

          <div style={{ marginTop: "1.1rem", paddingTop: "0.9rem", borderTop: "1px solid var(--color-border)" }}>
            {!confirmDelete ? (
              <button onClick={onDeleteClick} style={{ ...pillGhost, color: "var(--color-danger)" }}>
                <Icon name="trash" size="16px" /> Delete playlist
              </button>
            ) : (
              <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
                <span style={{ color: "var(--color-muted)", fontSize: "var(--text-label)" }}>Really delete this playlist?</span>
                <button onClick={onDeleteClick} disabled={deleting} style={{ ...pillGhost, color: "var(--color-danger)" }}>
                  {deleting ? "Deleting…" : "Yes, delete"}
                </button>
                <button onClick={() => setConfirmDelete(false)} style={pillGhost}>Cancel</button>
              </span>
            )}
          </div>
        </div>
      )}

      <div className="glass" style={{ borderRadius: 16, marginTop: "1.25rem", padding: "0.5rem 1rem" }}>
        {songs.length === 0 ? (
          <p style={{ color: "var(--color-muted)", padding: "1rem" }}>No songs yet.</p>
        ) : editing && authenticated ? (
          songs.map((s, i) => (
            <div
              key={s.id}
              draggable
              onDragStart={() => setDrag(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); onRowDrop(i); }}
              style={{ display: "grid", gridTemplateColumns: "24px 40px 1fr auto", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0", borderBottom: i < songs.length - 1 ? "1px solid var(--color-border)" : "none", cursor: "grab" }}
            >
              <span aria-hidden="true" style={{ color: "var(--color-muted)", fontSize: "1.1rem", textAlign: "center" }}>⠿</span>
              <span style={{ width: 40, height: 40, borderRadius: 6, overflow: "hidden", background: "var(--color-active)", display: "grid", placeItems: "center" }}>
                {s.coverArtId ? <img src={coverUrl(s.coverArtId, "thumb")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontFamily: "var(--font-serif)", color: "var(--color-muted)", fontSize: "0.9rem" }}>{coverInitial(s.title)}</span>}
              </span>
              <span style={{ minWidth: 0 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--color-muted)", fontSize: "var(--text-label)" }}>{s.artistName}</div>
              </span>
              <button onClick={() => removeSong(s)} aria-label={`Remove ${s.title}`} style={{ ...linkBtn, display: "inline-flex", padding: 4 }}>
                <Icon name="close" size="16px" />
              </button>
            </div>
          ))
        ) : (
          songs.map((s, i) => (
            <div key={s.id} style={{ display: "grid", gridTemplateColumns: "40px 1fr auto", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0", borderBottom: i < songs.length - 1 ? "1px solid var(--color-border)" : "none" }}>
              <button onClick={() => onPlay(s, songs.slice(i + 1))} aria-label={`Play ${s.title}`} style={{ ...linkBtn, width: 40, height: 40, borderRadius: 6, overflow: "hidden", background: "var(--color-active)", display: "grid", placeItems: "center" }}>
                {s.coverArtId ? <img src={coverUrl(s.coverArtId, "thumb")} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ fontFamily: "var(--font-serif)", color: "var(--color-muted)", fontSize: "0.9rem" }}>{coverInitial(s.title)}</span>}
              </button>
              <button onClick={() => onPlay(s, songs.slice(i + 1))} style={{ ...linkBtn, textAlign: "left", minWidth: 0 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</div>
                <div className="row-meta" style={{ display: "flex", alignItems: "center", gap: "0.6rem", color: "var(--color-muted)", fontSize: "var(--text-label)" }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.artistName}</span>
                  <UnpublishedBadge show={authenticated && !s.published} placement="meta" />
                </div>
              </button>
              <span style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>{renderRowActions(s)}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const linkBtn: React.CSSProperties = { background: "none", border: "none", color: "var(--color-accent-strong)", cursor: "pointer", padding: 0 };

const pillPrimary: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.5rem",
  background: "var(--color-accent-fill)",
  color: "var(--color-ink)",
  border: "none",
  borderRadius: 999,
  padding: "0.55rem 1.25rem",
  fontSize: "var(--text-ui)",
  cursor: "pointer",
  fontWeight: 600,
};

const pillGhost: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.5rem",
  background: "var(--color-active)",
  color: "var(--color-ink)",
  border: "1px solid var(--color-border)",
  borderRadius: 999,
  padding: "0.55rem 1.1rem",
  fontSize: "var(--text-ui)",
  cursor: "pointer",
};

const suggestionStyle: React.CSSProperties = {
  display: "block", width: "100%", textAlign: "left", cursor: "pointer", marginTop: 4,
  padding: "0.5rem 0.65rem", borderRadius: "var(--radius-ui)",
  background: "var(--color-active)", border: "1px solid var(--color-border)",
  color: "var(--color-ink)", fontSize: "var(--text-ui)",
};
