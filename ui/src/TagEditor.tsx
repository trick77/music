import { useEffect, useState } from "react";
import { updateSong, uploadCover, removeCover, suggest, type Song, type Suggestion } from "./api";
import { coverUrl, coverInitial } from "./cover";
import { Icon } from "./Icon";
import { Button, controlClass, fieldLabel, t, useVisualViewportBox } from "./ui";
import { titleCase, genreLabel } from "./titleCase";

type Props = { song: Song; onClose: () => void; onSaved: (s: Song) => void };
type Tab = "details" | "cover" | "lyrics";

// cleanLyrics strips Suno's bracketed directives ([Verse], [Chorus], [Guitar solo], …)
// and tidies leftover whitespace, leaving only sung words. Parentheses are left intact —
// "(ooh)"/"(yeah)" ad-libs are usually actually sung. Keep in sync with the server-side
// cleanLyrics in backend/internal/metadata/mp3.go.
const cleanLyrics = (raw: string) =>
  raw.replace(/\[[^\]]*\]/g, "")  // remove [Verse], [Chorus], [Guitar solo], …
    .replace(/[ \t]+$/gm, "")     // trailing spaces left behind
    .replace(/\n{3,}/g, "\n\n")   // collapse blank-line runs
    .trim();

// TagEditor is a tabbed editor (Details / Cover / Lyrics) — a centered modal on
// desktop, full-screen on mobile and touch tablets. Tabs keep each screen short as the form grows
// (docs/design-system.md). All three tabs stay mounted so unsaved edits survive
// tab switches; only their visibility toggles.
export function TagEditor({ song, onClose, onSaved }: Props) {
  // Pins the overlay to the part of the screen the keyboard isn't covering, so the
  // pinned footer's Save button stays reachable on iPad (see useVisualViewportBox).
  const viewport = useVisualViewportBox();
  const [tab, setTab] = useState<Tab>("details");
  const [title, setTitle] = useState(song.title);
  const [artistName, setArtist] = useState(song.artistName);
  const [album, setAlbum] = useState(song.album);
  const [year, setYear] = useState(song.year ? String(song.year) : "");
  const [trackNo, setTrack] = useState(song.trackNo ? String(song.trackNo) : "");
  const [genres, setGenres] = useState<string[]>(song.genres);
  const [genreInput, setGenreInput] = useState("");
  const [lyrics, setLyrics] = useState(song.lyrics ?? "");
  const [cover, setCover] = useState(song.coverArtId);
  const [artistOpts, setArtistOpts] = useState<Suggestion[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Esc closes the dialog (unless a save is in flight), matching the other modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  const addGenre = (g: string) => {
    const v = g.trim();
    if (v && !genres.some((x) => x.toLowerCase() === v.toLowerCase())) setGenres([...genres, v]);
    setGenreInput("");
  };

  const onSave = async () => {
    setSaving(true);
    setErr(null);
    // Commit a genre typed but not yet added via Enter, so it isn't lost on save.
    const pending = genreInput.trim();
    const finalGenres =
      pending && !genres.some((x) => x.toLowerCase() === pending.toLowerCase())
        ? [...genres, pending]
        : genres;
    try {
      const saved = await updateSong(song.id, {
        title, artistName, album,
        year: Number(year) || 0, trackNo: Number(trackNo) || 0, genres: finalGenres, lyrics,
      });
      onSaved(saved);
      onClose();
    } catch {
      setErr("Could not save changes");
      setSaving(false);
    }
  };

  const onCover = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const saved = await uploadCover(song.id, file);
      setCover(saved.coverArtId);
      onSaved(saved);
    } catch {
      setErr("Cover upload failed");
    }
    e.target.value = "";
  };

  const onRemoveCover = async () => {
    try {
      const saved = await removeCover(song.id);
      setCover(saved.coverArtId);
      onSaved(saved);
    } catch {
      setErr("Could not remove cover");
    }
  };

  const tabButton = (id: Tab, label: string) => (
    <button
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      style={{
        border: "none", cursor: "pointer", borderRadius: 999, padding: "6px 14px",
        fontFamily: "var(--font-sans)", fontSize: "var(--text-ui)",
        background: tab === id ? "var(--color-accent-fill)" : "transparent",
        color: tab === id ? "var(--color-ink)" : "var(--color-muted)",
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="ui-overlay" style={viewport} onClick={() => { if (!saving) onClose(); }}>
      <div className="ui-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Edit">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-4)", padding: "var(--space-4) var(--space-5)", borderBottom: "1px solid var(--color-border)" }}>
          <h3 style={{ margin: 0, ...t.title }}>Edit</h3>
          <button onClick={onClose} aria-label="Close" style={{ display: "inline-flex", background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", padding: 2 }}>
            <Icon name="close" size="18px" />
          </button>
        </div>

        <div role="tablist" aria-label="Tag editor sections" style={{ display: "flex", gap: 2, padding: "var(--space-3) var(--space-5) 0" }}>
          {tabButton("details", "Details")}
          {tabButton("cover", "Cover")}
          {tabButton("lyrics", "Lyrics")}
        </div>

        <div className="ui-modal-body" style={{ padding: "var(--space-5)" }}>
          {/* All three panels share a single grid cell (each pinned to row/col 1), so the
              cell always sizes to the tallest panel (Details) and the modal keeps a constant
              height across tabs instead of jumping. Inactive panels toggle via `visibility`
              (not `display: none`) so they stay mounted — unsaved edits survive — while still
              occupying the cell to hold the frame steady, yet out of tab order and clicks. */}
          <div style={{ display: "grid" }}>
          {/* Details */}
          <div style={{ gridColumn: 1, gridRow: 1, visibility: tab === "details" ? "visible" : "hidden", display: "grid", gap: "var(--space-4)" }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <label style={{ ...fieldLabel, marginBottom: 0 }}>Title</label>
                <Button variant="ghost" small onClick={() => setTitle(titleCase(title))} title="Capitalize as a title (auto-detects language)">
                  Title case
                </Button>
              </div>
              <input className={controlClass} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div style={{ position: "relative" }}>
              <label style={fieldLabel}>Artist</label>
              <input
                className={controlClass}
                value={artistName}
                onChange={async (e) => { setArtist(e.target.value); setArtistOpts(await suggest("artist", e.target.value)); }}
                onBlur={() => setTimeout(() => setArtistOpts([]), 150)}
              />
              {artistOpts.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "var(--color-panel)", border: "1px solid var(--color-border)", borderRadius: "var(--radius-ui)", zIndex: 5 }}>
                  {artistOpts.map((o) => (
                    <div key={o.value} onMouseDown={() => { setArtist(o.value); setArtistOpts([]); }}
                      style={{ padding: "8px 12px", cursor: "pointer", display: "flex", justifyContent: "space-between", fontSize: "var(--text-ui)" }}>
                      <span>{o.value}</span><span style={{ color: "var(--color-muted)" }}>{o.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <label style={{ ...fieldLabel, marginBottom: 0 }}>Album</label>
                <Button variant="ghost" small onClick={() => setAlbum(titleCase(album))} title="Capitalize as a title (auto-detects language)">
                  Title case
                </Button>
              </div>
              <input className={controlClass} value={album} onChange={(e) => setAlbum(e.target.value)} />
            </div>
            <div>
              <label style={fieldLabel}>Genres</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
                {genres.map((g) => (
                  <span key={g} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "var(--color-active)", borderRadius: 999, padding: "3px 10px", fontSize: "var(--text-label)" }}>
                    {genreLabel(g)}
                    <button onClick={() => setGenres(genres.filter((x) => x !== g))} aria-label={`Remove ${genreLabel(g)}`} style={{ display: "inline-flex", background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", padding: 0 }}>
                      <Icon name="close" size="12px" />
                    </button>
                  </span>
                ))}
              </div>
              <input
                className={controlClass}
                placeholder="Add genre and press Enter"
                value={genreInput}
                onChange={(e) => setGenreInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addGenre(genreInput); } }}
              />
            </div>
            <div style={{ display: "flex", gap: "var(--space-3)" }}>
              <div style={{ flex: 1 }}>
                <label style={fieldLabel}>Year</label>
                <input className={controlClass} value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={fieldLabel}>Track no.</label>
                <input className={controlClass} value={trackNo} onChange={(e) => setTrack(e.target.value)} inputMode="numeric" />
              </div>
            </div>
          </div>

          {/* Cover */}
          <div style={{ gridColumn: 1, gridRow: 1, visibility: tab === "cover" ? "visible" : "hidden" }}>
            <div style={{ width: 160, maxWidth: "100%", margin: "0 auto" }}>
              <div style={{ width: 160, height: 160, borderRadius: "var(--radius-ui)", overflow: "hidden", border: "1px solid var(--color-border)", background: "var(--color-active)", display: "grid", placeItems: "center" }}>
                {cover ? (
                  <img src={coverUrl(cover)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : (
                  <span style={{ fontFamily: "var(--font-serif)", fontSize: "2rem", color: "var(--color-muted)" }}>{coverInitial(artistName)}</span>
                )}
              </div>
              <label style={{ display: "block", marginTop: 8, textAlign: "center", fontSize: "var(--text-label)", color: "var(--color-accent-strong)", cursor: "pointer" }}>
                {cover ? "Replace cover…" : "Add cover…"}
                <input type="file" accept="image/jpeg,image/png" onChange={onCover} style={{ display: "none" }} />
              </label>
              {cover && (
                <div style={{ textAlign: "center", marginTop: 4 }}>
                  <Button variant="ghost" small onClick={onRemoveCover}>Remove cover</Button>
                </div>
              )}
              <p style={{ fontSize: "var(--text-label)", color: "var(--color-muted)", textAlign: "center", marginTop: 6 }}>
                Applies to every track on this artist + album.
              </p>
            </div>
          </div>

          {/* Lyrics */}
          <div style={{ gridColumn: 1, gridRow: 1, visibility: tab === "lyrics" ? "visible" : "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <label style={{ ...fieldLabel, marginBottom: 0 }}>Lyrics</label>
              <Button variant="ghost" small onClick={() => setLyrics(cleanLyrics(lyrics))} title="Remove [Verse]/[Chorus]-style Suno tags">
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
          </div>

          {err && <p role="alert" style={{ color: "var(--color-accent-strong)", fontSize: "var(--text-label)", margin: "var(--space-3) 0 0" }}>{err}</p>}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "var(--space-4)", padding: "var(--space-3) var(--space-5)", borderTop: "1px solid var(--color-border)" }}>
          <span style={t.label}>Changes save to the file's ID3 tags.</span>
          <div style={{ display: "flex", gap: "var(--space-2)", flexShrink: 0 }}>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button busy={saving} onClick={onSave}>Save changes</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
