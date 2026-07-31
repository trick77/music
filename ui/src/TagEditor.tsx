import { useEffect, useState } from "react";
import {
  updateSong,
  uploadCover,
  removeCover,
  suggest,
  getSongStats,
  type Song,
  type SongStats,
  type Suggestion,
} from "./api";
import { coverUrl, coverInitial } from "./cover";
import { IMAGE_ACCEPT, useImageDrop } from "./imageDrop";
import { Icon } from "./Icon";
import { Button, controlClass, fieldLabel, t, Spinner, Overlay } from "./ui";
import { titleCase, genreLabel } from "./titleCase";
import { useEscape } from "./useEscape";
import {
  formatDuration,
  formatFileSize,
  formatDateAdded,
  formatLastPlayed,
  formatBitrate,
  formatSampleRate,
  formatChannels,
} from "./format";

type Props = { song: Song; onClose: () => void; onSaved: (s: Song) => void };
type Tab = "details" | "cover" | "lyrics" | "info";

// InfoSection / InfoRow render the Info tab's read-only key/value list. Figures are
// tabular so the values line up down the right edge.
//
// The group label is a heading OUTSIDE the <dl>, not a <dt>: "Playback" and "File"
// name a section, not a term, and a <dt> without a following <dd> is invalid — as is
// mixing bare dt/dd children with <div>-wrapped groups in one list.
function InfoSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h4
        style={{
          ...t.micro,
          fontWeight: 600,
          margin: "var(--space-3) 0 var(--space-1)",
        }}
      >
        {label}
      </h4>
      <dl style={{ margin: 0 }}>{children}</dl>
    </section>
  );
}

function InfoRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: "var(--space-4)",
        padding: "7px 0",
        borderBottom: "1px solid var(--color-border)",
      }}
    >
      <dt style={{ ...t.label, margin: 0 }}>{k}</dt>
      <dd
        style={{
          margin: 0,
          fontSize: "var(--text-label)",
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {v}
      </dd>
    </div>
  );
}

// CoverOp is the cover edit staged for the next save, mirroring how the other
// tabs hold their edits in state. A union rather than a pair of flags so the
// states stay mutually exclusive — "removed" and "replaced" can't both be true.
type CoverOp =
  | { kind: "keep" }
  | { kind: "remove" }
  | { kind: "replace"; file: File; previewUrl: string };

// cleanLyrics strips Suno's bracketed directives ([Verse], [Chorus], [Guitar solo], …)
// and tidies leftover whitespace, leaving only sung words. Parentheses are left intact —
// "(ooh)"/"(yeah)" ad-libs are usually actually sung. Keep in sync with the server-side
// cleanLyrics in backend/internal/metadata/mp3.go.
const cleanLyrics = (raw: string) =>
  raw
    .replace(/\[[^\]]*\]/g, "") // remove [Verse], [Chorus], [Guitar solo], …
    .replace(/[ \t]+$/gm, "") // trailing spaces left behind
    .replace(/\n{3,}/g, "\n\n") // collapse blank-line runs
    .trim();

// genreHighlight picks which suggestion the genre field starts on. /api/suggest matches
// SUBSTRINGS while the inline completion is prefix-shaped, so the most-used candidate is
// often one that can't complete what was typed ("sing" → "throat singing"). Starting on
// the first candidate that does keeps the ghost text and the highlighted row in
// agreement — otherwise Tab adds something the user was never shown completing.
function genreHighlight(opts: Suggestion[], q: string): number {
  const k = q.trim().toLowerCase();
  const i = opts.findIndex((o) =>
    genreLabel(o.value).toLowerCase().startsWith(k),
  );
  return i === -1 ? 0 : i;
}

// TagEditor is a tabbed editor (Details / Cover / Lyrics / Info) — a centered modal on
// desktop, full-screen on mobile and touch tablets. Tabs keep each screen short as the form grows
// (docs/design-system.md). All four tabs stay mounted so unsaved edits survive
// tab switches; only their visibility toggles. Info is read-only.
export function TagEditor({ song, onClose, onSaved }: Props) {
  const [tab, setTab] = useState<Tab>("details");
  const [title, setTitle] = useState(song.title);
  const [artistName, setArtist] = useState(song.artistName);
  const [album, setAlbum] = useState(song.album);
  const [year, setYear] = useState(song.year ? String(song.year) : "");
  const [trackNo, setTrack] = useState(
    song.trackNo ? String(song.trackNo) : "",
  );
  const [genres, setGenres] = useState<string[]>(song.genres);
  const [genreInput, setGenreInput] = useState("");
  const [lyrics, setLyrics] = useState(song.lyrics ?? "");
  const [coverOp, setCoverOp] = useState<CoverOp>({ kind: "keep" });
  const [artistOpts, setArtistOpts] = useState<Suggestion[]>([]);
  const [genreOpts, setGenreOpts] = useState<Suggestion[]>([]);
  const [genreIdx, setGenreIdx] = useState(0);
  const [genreOpen, setGenreOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stats, setStats] = useState<SongStats | null>(null);
  const [statsErr, setStatsErr] = useState(false);
  // Pixel dimensions + byte size of the cover shown on the Cover tab. null while
  // unknown or when there's nothing to show (no art / staged removal).
  const [coverMeta, setCoverMeta] = useState<{
    w: number;
    h: number;
    bytes: number;
  } | null>(null);

  // Play figures are the one thing here the song payload doesn't already carry, so
  // fetch them — but only once the Info tab is actually opened, and only once.
  useEffect(() => {
    if (tab !== "info" || stats || statsErr) return;
    let live = true;
    getSongStats(song.id)
      .then((s) => {
        if (live) setStats(s);
      })
      .catch(() => {
        if (live) setStatsErr(true);
      });
    return () => {
      live = false;
    };
  }, [tab, song.id, stats, statsErr]);

  // What the Cover tab shows: the staged edit if there is one, else the song's
  // current art. Removal is album-wide and irreversible once saved, so nothing
  // here touches the server until Save — closing discards, like every other tab.
  const preview =
    coverOp.kind === "replace"
      ? coverOp.previewUrl
      : coverOp.kind === "remove"
        ? null
        : song.coverArtId
          ? coverUrl(song.coverArtId)
          : null;

  // Measure the previewed cover for the Cover tab's dimensions + size readout.
  // A staged file carries its own byte size and decodes off the object URL; the
  // stored cover is fetched from `/api/cover/{id}` with no ?size, which serves the
  // ORIGINAL bytes (not a thumbnail), so the figures describe the real file. The
  // fetch hits the browser cache the <img> preview already populated.
  useEffect(() => {
    let live = true;
    const clear = () => {
      if (live) setCoverMeta(null);
    };
    // Decode natural dimensions off `url`, pairing them with a known byte size or,
    // when null, one read from the URL's bytes.
    const measure = (url: string, bytes: number | null) => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth,
          h = img.naturalHeight;
        if (bytes != null) {
          if (live) setCoverMeta({ w, h, bytes });
          return;
        }
        fetch(url)
          .then((r) => r.blob())
          .then((b) => {
            if (live) setCoverMeta({ w, h, bytes: b.size });
          })
          .catch(clear);
      };
      img.onerror = clear;
      img.src = url;
    };
    setCoverMeta(null);
    if (coverOp.kind === "replace")
      measure(coverOp.previewUrl, coverOp.file.size);
    else if (coverOp.kind === "keep" && song.coverArtId)
      measure(coverUrl(song.coverArtId), null);
    return () => {
      live = false;
    };
  }, [coverOp, song.coverArtId]);

  // Esc closes the dialog (unless a save is in flight), matching the other modals.
  // Registered even mid-save so the press stops here rather than reaching past it.
  useEscape(true, () => {
    if (!saving) onClose();
  });

  // Release the staged file's object URL once it's superseded or the editor closes.
  useEffect(() => {
    if (coverOp.kind !== "replace") return;
    const url = coverOp.previewUrl;
    return () => URL.revokeObjectURL(url);
  }, [coverOp]);

  const addGenre = (g: string) => {
    const v = g.trim();
    if (v && !genres.some((x) => x.toLowerCase() === v.toLowerCase()))
      setGenres([...genres, v]);
    setGenreInput("");
  };

  // Genre suggestions, debounced so a fast typist doesn't fire a request per keystroke.
  // The cleanup both cancels the pending timer and disowns an in-flight response, so a
  // slow early request can never overwrite the list a later keystroke produced.
  useEffect(() => {
    const q = genreInput.trim();
    if (!q) {
      setGenreOpts([]);
      setGenreOpen(false);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      suggest("genre", q)
        .then((opts) => {
          if (!live) return;
          setGenreOpts(opts);
          setGenreIdx(genreHighlight(opts, q));
          setGenreOpen(opts.length > 0);
        })
        .catch(() => {});
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [genreInput]);

  // What Tab (and the Tab button, and the ghost text) would complete to — undefined
  // when the list is closed or empty, which is exactly when Tab must fall through to
  // its normal focus move rather than being swallowed.
  const genreHint = genreOpen ? genreOpts[genreIdx] : undefined;
  const genreHintLabel = genreHint ? genreLabel(genreHint.value) : "";
  // Only the part still to be typed is ghosted, and only when the candidate really
  // extends what's in the field — a substring-only match completes nothing.
  const genreGhost =
    genreInput &&
    genreHintLabel.toLowerCase().startsWith(genreInput.toLowerCase())
      ? genreHintLabel.slice(genreInput.length)
      : "";

  // The stored (lowercase) value goes into the chip, never the display label — the
  // labelled form would read as a new genre to the case-insensitive dedupe below it.
  // The highlight has to still match what's in the field: between a keystroke and the
  // debounced response the list belongs to the PREVIOUS query, and accepting from it
  // would add a genre that was never offered for the text now typed. Substring is the
  // right test — it's what /api/suggest matched on, so an arrow-picked candidate that
  // only contains the query is still fair game.
  const acceptGenre = () => {
    const typed = genreInput.trim().toLowerCase();
    if (!genreHint || !genreHintLabel.toLowerCase().includes(typed))
      return false;
    addGenre(genreHint.value);
    setGenreOpts([]);
    setGenreOpen(false);
    return true;
  };

  // Escape closes the suggestion list and stops there. Registered only while the list
  // is up, so it sits above the editor's own handler and the modal survives the press.
  useEscape(!!genreHint, () => setGenreOpen(false));

  const onSave = async () => {
    setSaving(true);
    setErr(null);
    // Commit a genre typed but not yet added via Enter, so it isn't lost on save.
    const pending = genreInput.trim();
    const finalGenres =
      pending && !genres.some((x) => x.toLowerCase() === pending.toLowerCase())
        ? [...genres, pending]
        : genres;
    let saved: Song;
    try {
      saved = await updateSong(song.id, {
        title,
        artistName,
        album,
        year: Number(year) || 0,
        trackNo: Number(trackNo) || 0,
        genres: finalGenres,
        lyrics,
      });
    } catch {
      setErr("Could not save changes");
      setSaving(false);
      return;
    }
    // Cover last: it keys off the song's artist + album, so applying it after the
    // tag save targets the album as edited here rather than the one left behind.
    try {
      if (coverOp.kind === "remove") saved = await removeCover(song.id);
      else if (coverOp.kind === "replace")
        saved = await uploadCover(song.id, coverOp.file);
    } catch {
      // Tags are already committed. Stay open with the cover edit still staged —
      // the tag save is idempotent, so Save again just retries the cover.
      onSaved(saved);
      setErr("Tags saved, but the cover could not be updated");
      setSaving(false);
      return;
    }
    onSaved(saved);
    onClose();
  };

  // One staging path for both the file picker and the drop zone. A drop stages the
  // file exactly like the picker does — it must not upload on its own, or dropping
  // would be the one cover edit that bypasses Save and hits the album immediately.
  const stageCoverFile = (file: File) => {
    setErr(null);
    setCoverOp({
      kind: "replace",
      file,
      previewUrl: URL.createObjectURL(file),
    });
  };

  const onCover = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) stageCoverFile(file);
    e.target.value = "";
  };

  const { dropping, dropProps } = useImageDrop({
    onFile: stageCoverFile,
    onReject: setErr,
  });

  const tabButton = (id: Tab, label: string) => (
    <button
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      style={{
        border: "none",
        cursor: "pointer",
        borderRadius: 999,
        padding: "6px 14px",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-ui)",
        background: tab === id ? "var(--color-accent-fill)" : "transparent",
        color: tab === id ? "var(--color-ink)" : "var(--color-muted)",
      }}
    >
      {label}
    </button>
  );

  return (
    <Overlay
      onClick={() => {
        if (!saving) onClose();
      }}
    >
      <div
        className="ui-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Edit"
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "var(--space-4)",
            padding: "var(--space-4) var(--space-5)",
            borderBottom: "1px solid var(--color-border)",
          }}
        >
          <h3 style={{ margin: 0, ...t.title }}>Edit</h3>
          <button
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            style={{
              display: "inline-flex",
              background: "none",
              border: "none",
              color: "var(--color-muted)",
              cursor: saving ? "default" : "pointer",
              padding: 2,
              opacity: saving ? 0.6 : 1,
            }}
          >
            <Icon name="close" size="18px" />
          </button>
        </div>

        <div
          role="tablist"
          aria-label="Tag editor sections"
          style={{
            display: "flex",
            gap: 2,
            padding: "var(--space-3) var(--space-5) 0",
          }}
        >
          {tabButton("details", "Details")}
          {tabButton("cover", "Cover")}
          {tabButton("lyrics", "Lyrics")}
          {tabButton("info", "Info")}
        </div>

        <div className="ui-modal-body" style={{ padding: "var(--space-5)" }}>
          {/* All three panels share a single grid cell (each pinned to row/col 1), so the
              cell always sizes to the tallest panel (Details) and the modal keeps a constant
              height across tabs instead of jumping. Inactive panels toggle via `visibility`
              (not `display: none`) so they stay mounted — unsaved edits survive — while still
              occupying the cell to hold the frame steady, yet out of tab order and clicks. */}
          <div style={{ display: "grid" }}>
            {/* Details */}
            <div
              style={{
                gridColumn: 1,
                gridRow: 1,
                visibility: tab === "details" ? "visible" : "hidden",
                display: "grid",
                gap: "var(--space-4)",
              }}
            >
              <div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 6,
                  }}
                >
                  <label style={{ ...fieldLabel, marginBottom: 0 }}>
                    Title
                  </label>
                  <Button
                    variant="ghost"
                    small
                    onClick={() => setTitle(titleCase(title))}
                    title="Capitalize as a title (auto-detects language)"
                  >
                    Title case
                  </Button>
                </div>
                <input
                  className={controlClass}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div style={{ position: "relative" }}>
                <label style={fieldLabel}>Artist</label>
                <input
                  className={controlClass}
                  value={artistName}
                  onChange={async (e) => {
                    setArtist(e.target.value);
                    setArtistOpts(await suggest("artist", e.target.value));
                  }}
                  onBlur={() => setTimeout(() => setArtistOpts([]), 150)}
                />
                {artistOpts.length > 0 && (
                  <div
                    style={{
                      position: "absolute",
                      top: "100%",
                      left: 0,
                      right: 0,
                      background: "var(--color-panel)",
                      border: "1px solid var(--color-border)",
                      borderRadius: "var(--radius-ui)",
                      zIndex: 5,
                    }}
                  >
                    {artistOpts.map((o) => (
                      <div
                        key={o.value}
                        onMouseDown={() => {
                          setArtist(o.value);
                          setArtistOpts([]);
                        }}
                        style={{
                          padding: "8px 12px",
                          cursor: "pointer",
                          display: "flex",
                          justifyContent: "space-between",
                          fontSize: "var(--text-ui)",
                        }}
                      >
                        <span>{o.value}</span>
                        <span style={{ color: "var(--color-muted)" }}>
                          {o.count}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 6,
                  }}
                >
                  <label style={{ ...fieldLabel, marginBottom: 0 }}>
                    Album
                  </label>
                  <Button
                    variant="ghost"
                    small
                    onClick={() => setAlbum(titleCase(album))}
                    title="Capitalize as a title (auto-detects language)"
                  >
                    Title case
                  </Button>
                </div>
                <input
                  className={controlClass}
                  value={album}
                  onChange={(e) => setAlbum(e.target.value)}
                />
              </div>
              <div>
                <label style={fieldLabel}>Genres</label>
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                    marginBottom: 6,
                  }}
                >
                  {genres.map((g) => (
                    <span
                      key={g}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                        background: "var(--color-active)",
                        borderRadius: 999,
                        padding: "3px 10px",
                        fontSize: "var(--text-label)",
                      }}
                    >
                      {genreLabel(g)}
                      <button
                        onClick={() => setGenres(genres.filter((x) => x !== g))}
                        aria-label={`Remove ${genreLabel(g)}`}
                        style={{
                          display: "inline-flex",
                          background: "none",
                          border: "none",
                          color: "var(--color-muted)",
                          cursor: "pointer",
                          padding: 0,
                        }}
                      >
                        <Icon name="close" size="12px" />
                      </button>
                    </span>
                  ))}
                </div>
                <div style={{ display: "flex", gap: "var(--space-2)" }}>
                  <div style={{ position: "relative", flex: 1 }}>
                    <input
                      className={controlClass}
                      placeholder="Add genre — Tab completes, Enter adds"
                      value={genreInput}
                      role="combobox"
                      aria-expanded={!!genreHint}
                      aria-controls="genre-suggestions"
                      aria-autocomplete="list"
                      aria-activedescendant={
                        genreHint ? `genre-option-${genreIdx}` : undefined
                      }
                      onChange={(e) => setGenreInput(e.target.value)}
                      onBlur={() => setTimeout(() => setGenreOpen(false), 150)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addGenre(genreInput);
                          setGenreOpen(false);
                        } else if (e.key === "Tab" && !e.shiftKey) {
                          // Only swallowed when there is something to complete: Tab is
                          // the sole keyboard exit from this field, and Shift+Tab is
                          // navigation, never completion.
                          if (acceptGenre()) e.preventDefault();
                        } else if (e.key === "ArrowDown" && genreHint) {
                          e.preventDefault();
                          setGenreIdx(
                            Math.min(genreIdx + 1, genreOpts.length - 1),
                          );
                        } else if (e.key === "ArrowUp" && genreHint) {
                          e.preventDefault();
                          setGenreIdx(Math.max(genreIdx - 1, 0));
                        }
                      }}
                    />
                    {genreGhost && (
                      // Sits on top of the input in the same box, so the tail lands
                      // exactly where the next keystroke would. The typed part is
                      // rendered transparent purely to push the tail into place.
                      <div
                        aria-hidden
                        style={{
                          position: "absolute",
                          inset: 0,
                          display: "flex",
                          alignItems: "center",
                          padding: "0 12px",
                          fontFamily: "var(--font-sans)",
                          fontSize: "var(--text-input)",
                          whiteSpace: "pre",
                          overflow: "hidden",
                          pointerEvents: "none",
                          color: "var(--color-muted)",
                        }}
                      >
                        <span style={{ color: "transparent" }}>
                          {genreInput}
                        </span>
                        {genreGhost}
                      </div>
                    )}
                    {genreHint && (
                      <div
                        id="genre-suggestions"
                        role="listbox"
                        style={{
                          position: "absolute",
                          top: "100%",
                          left: 0,
                          right: 0,
                          background: "var(--color-panel)",
                          border: "1px solid var(--color-border)",
                          borderRadius: "var(--radius-ui)",
                          zIndex: 5,
                        }}
                      >
                        {genreOpts.map((o, i) => (
                          <div
                            key={o.value}
                            id={`genre-option-${i}`}
                            role="option"
                            aria-selected={i === genreIdx}
                            // Commits on mousedown, before the field's blur can close
                            // the list out from under the tap.
                            onMouseDown={(e) => {
                              e.preventDefault();
                              addGenre(o.value);
                              setGenreOpts([]);
                              setGenreOpen(false);
                            }}
                            style={{
                              padding: "8px 12px",
                              cursor: "pointer",
                              display: "flex",
                              justifyContent: "space-between",
                              fontSize: "var(--text-ui)",
                              background:
                                i === genreIdx
                                  ? "var(--color-active)"
                                  : undefined,
                            }}
                          >
                            <span>{genreLabel(o.value)}</span>
                            <span style={{ color: "var(--color-muted)" }}>
                              {o.count}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {/* Touch keyboards have no Tab key, so completing needs a control of
                      its own. Shown on every device rather than behind a coarse-pointer
                      check: it doubles as the hint that Tab is what completes here. */}
                  <Button
                    variant="ghost"
                    disabled={!genreHint}
                    title="Complete the highlighted genre"
                    onMouseDown={(e) => {
                      e.preventDefault(); // keep focus in the field for the next genre
                      acceptGenre();
                    }}
                  >
                    Tab
                  </Button>
                </div>
              </div>
              <div style={{ display: "flex", gap: "var(--space-3)" }}>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabel}>Year</label>
                  <input
                    className={controlClass}
                    value={year}
                    onChange={(e) => setYear(e.target.value)}
                    inputMode="numeric"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabel}>Track no.</label>
                  {song.trackTotal > 0 ? (
                    // Album songs are numbered automatically per artist+album ("N of Y"),
                    // so this is read-only — a manual value would just be overwritten.
                    // Singles (trackTotal 0) keep the editable field below.
                    <input
                      className={controlClass}
                      value={`${song.trackNo} of ${song.trackTotal}`}
                      readOnly
                      title="Track numbering is set automatically per album"
                      style={{ opacity: 0.7, cursor: "default" }}
                    />
                  ) : (
                    <input
                      className={controlClass}
                      value={trackNo}
                      onChange={(e) => setTrack(e.target.value)}
                      inputMode="numeric"
                    />
                  )}
                </div>
              </div>
            </div>

            {/* Cover */}
            <div
              style={{
                gridColumn: 1,
                gridRow: 1,
                visibility: tab === "cover" ? "visible" : "hidden",
              }}
            >
              {/* Grow the art to fill the tab's width so it reads as art, not a
                thumbnail — capped so it stays a comfortable square in the wide
                desktop modal. Stays square (aspect-ratio) at every width. */}
              <div style={{ width: "min(400px, 100%)", margin: "0 auto" }}>
                {/* The thumbnail IS the picker: click it to choose a file, or drop an
                  image on it — one staging path (stageCoverFile) for both. The relative
                  wrapper hosts the remove badge, which must sit OUTSIDE the label's
                  overflow:hidden clip so it isn't cropped at the corner. */}
                <div
                  style={{
                    position: "relative",
                    width: "100%",
                    aspectRatio: "1 / 1",
                    margin: "0 auto",
                  }}
                >
                  <label
                    {...dropProps}
                    aria-label={preview ? "Replace cover" : "Add cover"}
                    style={{
                      position: "relative",
                      width: "100%",
                      height: "100%",
                      borderRadius: "var(--radius-ui)",
                      overflow: "hidden",
                      cursor: "pointer",
                      border: dropping
                        ? "2px dashed var(--color-accent-strong)"
                        : "1px solid var(--color-border)",
                      background: "var(--color-active)",
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    {preview ? (
                      <img
                        src={preview}
                        alt=""
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                        }}
                      />
                    ) : (
                      <span
                        style={{
                          fontFamily: "var(--font-serif)",
                          fontSize: "2rem",
                          color: "var(--color-muted)",
                        }}
                      >
                        {coverInitial(artistName)}
                      </span>
                    )}
                    {dropping && (
                      <span
                        style={{
                          position: "absolute",
                          inset: 0,
                          display: "grid",
                          placeItems: "center",
                          gap: 4,
                          background: "rgba(0,0,0,0.55)",
                          color: "#fff",
                          fontSize: "var(--text-label)",
                        }}
                      >
                        Drop to replace
                      </span>
                    )}
                    <input
                      type="file"
                      accept={IMAGE_ACCEPT}
                      onChange={onCover}
                      style={{ display: "none" }}
                    />
                  </label>
                  {/* Remove cover — a circle-x badge on the art, replacing the old text
                    button. Keyed on the song's actual art, not the preview: a staged
                    pick on a coverless song has nothing to remove; Undo is the way back.
                    preventDefault stops the wrapping label from also opening the picker. */}
                  {song.coverArtId && coverOp.kind !== "remove" && (
                    <button
                      type="button"
                      aria-label="Remove cover"
                      title="Remove cover"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setCoverOp({ kind: "remove" });
                      }}
                      style={{
                        position: "absolute",
                        top: 6,
                        right: 6,
                        display: "inline-flex",
                        padding: 4,
                        border: "none",
                        background: "none",
                        cursor: "pointer",
                        lineHeight: 0,
                        // Understated — a faint icon kept legible over any art by a soft
                        // shadow, rather than a solid disc that would fight the artwork.
                        color: "rgba(255,255,255,0.72)",
                        filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.55))",
                      }}
                    >
                      <Icon name="closeCircle" size="18px" />
                    </button>
                  )}
                </div>
                {coverMeta && (
                  <p
                    style={{
                      ...t.micro,
                      color: "var(--color-muted)",
                      textAlign: "center",
                      marginTop: 8,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {coverMeta.w} × {coverMeta.h} ·{" "}
                    {formatFileSize(coverMeta.bytes)}
                  </p>
                )}
                <p
                  style={{
                    fontSize: "var(--text-label)",
                    color: "var(--color-muted)",
                    textAlign: "center",
                    marginTop: 6,
                  }}
                >
                  Applies to the whole album.
                  {coverOp.kind !== "keep" && (
                    <>
                      <br />
                      Pending — applies when you save.
                    </>
                  )}
                </p>
              </div>
            </div>

            {/* Lyrics */}
            <div
              style={{
                gridColumn: 1,
                gridRow: 1,
                visibility: tab === "lyrics" ? "visible" : "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 6,
                }}
              >
                <label style={{ ...fieldLabel, marginBottom: 0 }}>Lyrics</label>
                <Button
                  variant="ghost"
                  small
                  onClick={() => setLyrics(cleanLyrics(lyrics))}
                  title="Remove [Verse]/[Chorus]-style Suno tags"
                >
                  Clean
                </Button>
              </div>
              <textarea
                className={controlClass}
                value={lyrics}
                onChange={(e) => setLyrics(e.target.value)}
                rows={10}
                placeholder="Paste lyrics here. Clean removes [Verse]/[Chorus] tags."
                style={{ minHeight: 220, lineHeight: 1.5 }}
              />
            </div>

            {/* Info — read-only. The only place in the app that shows a play count;
              the top-ten chart deliberately shows rank and nothing else. */}
            <div
              style={{
                gridColumn: 1,
                gridRow: 1,
                visibility: tab === "info" ? "visible" : "hidden",
              }}
            >
              <InfoSection label="Playback">
                <InfoRow
                  k="Plays"
                  v={
                    statsErr ? (
                      "Unavailable"
                    ) : !stats ? (
                      <Spinner size="13px" />
                    ) : (
                      stats.plays.toLocaleString()
                    )
                  }
                />
                <InfoRow
                  k="Last played"
                  v={
                    statsErr ? (
                      "Unavailable"
                    ) : !stats ? (
                      <Spinner size="13px" />
                    ) : (
                      formatLastPlayed(stats.lastPlayedAt)
                    )
                  }
                />
              </InfoSection>
              <InfoSection label="Audio">
                <InfoRow k="Bitrate" v={formatBitrate(song.bitrateKbps)} />
                <InfoRow
                  k="Sample rate"
                  v={formatSampleRate(song.sampleRate)}
                />
                <InfoRow k="Channels" v={formatChannels(song.channels)} />
              </InfoSection>
              <InfoSection label="File">
                <InfoRow k="Duration" v={formatDuration(song.durationMs)} />
                <InfoRow k="Size" v={formatFileSize(song.fileSize)} />
                <InfoRow k="Added" v={formatDateAdded(song.createdAt)} />
              </InfoSection>
            </div>
          </div>

          {err && (
            <p
              role="alert"
              style={{
                color: "var(--color-accent-strong)",
                fontSize: "var(--text-label)",
                margin: "var(--space-3) 0 0",
              }}
            >
              {err}
            </p>
          )}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "var(--space-4)",
            padding: "var(--space-3) var(--space-5)",
            borderTop: "1px solid var(--color-border)",
          }}
        >
          <span style={t.label}>Changes save to the file's ID3 tags.</span>
          <div
            style={{ display: "flex", gap: "var(--space-2)", flexShrink: 0 }}
          >
            <Button variant="secondary" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button busy={saving} onClick={onSave}>
              Save changes
            </Button>
          </div>
        </div>
      </div>
    </Overlay>
  );
}
