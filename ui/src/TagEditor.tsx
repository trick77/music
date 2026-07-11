import { useState } from "react";
import { updateSong, uploadCover, suggest, type Song, type Suggestion } from "./api";
import { coverUrl, coverInitial } from "./cover";

type Props = { song: Song; onClose: () => void; onSaved: (s: Song) => void };

const inputStyle: React.CSSProperties = {
  width: "100%", background: "var(--color-bg)", color: "var(--color-ink)",
  border: "1px solid var(--color-border)", borderRadius: 8, padding: "0.5rem 0.6rem", font: "inherit",
};
const labelStyle: React.CSSProperties = {
  display: "block", fontSize: "0.7rem", letterSpacing: "0.08em", textTransform: "uppercase",
  color: "var(--color-muted)", marginBottom: 4,
};

export function TagEditor({ song, onClose, onSaved }: Props) {
  const [title, setTitle] = useState(song.title);
  const [artistName, setArtist] = useState(song.artistName);
  const [album, setAlbum] = useState(song.album);
  const [year, setYear] = useState(song.year ? String(song.year) : "");
  const [trackNo, setTrack] = useState(song.trackNo ? String(song.trackNo) : "");
  const [genres, setGenres] = useState<string[]>(song.genres);
  const [genreInput, setGenreInput] = useState("");
  const [cover, setCover] = useState(song.coverArtId);
  const [artistOpts, setArtistOpts] = useState<Suggestion[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
        year: Number(year) || 0, trackNo: Number(trackNo) || 0, genres: finalGenres,
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

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", padding: "1rem", zIndex: 50 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(560px, 100%)", background: "var(--color-panel)", border: "1px solid var(--color-border)", borderRadius: 14, padding: "1.25rem", maxHeight: "90vh", overflow: "auto" }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1rem" }}>
          <h3 style={{ margin: 0, fontFamily: "var(--font-serif)" }}>Edit tags</h3>
          <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", fontSize: "1.2rem" }}>×</button>
        </div>

        <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
          <div style={{ width: 120, flexShrink: 0 }}>
            <div style={{ width: 120, height: 120, borderRadius: 10, overflow: "hidden", border: "1px solid var(--color-border)", background: "var(--color-active)", display: "grid", placeItems: "center" }}>
              {cover ? (
                <img src={coverUrl(cover)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <span style={{ fontFamily: "var(--font-serif)", color: "var(--color-muted)" }}>{coverInitial(artistName)}</span>
              )}
            </div>
            <label style={{ display: "block", marginTop: 8, textAlign: "center", fontSize: "0.8rem", color: "var(--color-accent-strong)", cursor: "pointer" }}>
              Replace cover
              <input type="file" accept="image/jpeg,image/png" onChange={onCover} style={{ display: "none" }} />
            </label>
            <p style={{ fontSize: "0.68rem", color: "var(--color-muted)", textAlign: "center", marginTop: 6 }}>
              Applies to every track on this artist + album.
            </p>
          </div>

          <div style={{ flex: 1, display: "grid", gap: "0.7rem" }}>
            <div>
              <label style={labelStyle}>Title</label>
              <input style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div style={{ position: "relative" }}>
              <label style={labelStyle}>Artist</label>
              <input
                style={inputStyle}
                value={artistName}
                onChange={async (e) => { setArtist(e.target.value); setArtistOpts(await suggest("artist", e.target.value)); }}
                onBlur={() => setTimeout(() => setArtistOpts([]), 150)}
              />
              {artistOpts.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "var(--color-panel)", border: "1px solid var(--color-border)", borderRadius: 8, zIndex: 5 }}>
                  {artistOpts.map((o) => (
                    <div key={o.value} onMouseDown={() => { setArtist(o.value); setArtistOpts([]); }}
                      style={{ padding: "0.4rem 0.6rem", cursor: "pointer", display: "flex", justifyContent: "space-between" }}>
                      <span>{o.value}</span><span style={{ color: "var(--color-muted)" }}>{o.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <label style={labelStyle}>Album</label>
              <input style={inputStyle} value={album} onChange={(e) => setAlbum(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Genres</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
                {genres.map((g) => (
                  <span key={g} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "var(--color-active)", borderRadius: 999, padding: "0.15rem 0.55rem", fontSize: "0.8rem" }}>
                    {g}
                    <button onClick={() => setGenres(genres.filter((x) => x !== g))} aria-label={`Remove ${g}`} style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer" }}>×</button>
                  </span>
                ))}
              </div>
              <input
                style={inputStyle}
                placeholder="Add genre and press Enter"
                value={genreInput}
                onChange={(e) => setGenreInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addGenre(genreInput); } }}
              />
            </div>
            <div style={{ display: "flex", gap: "0.7rem" }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Year</label>
                <input style={inputStyle} value={year} onChange={(e) => setYear(e.target.value)} inputMode="numeric" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Track no.</label>
                <input style={inputStyle} value={trackNo} onChange={(e) => setTrack(e.target.value)} inputMode="numeric" />
              </div>
            </div>
          </div>
        </div>

        {err && <p style={{ color: "var(--color-accent-strong)" }}>{err}</p>}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.5rem" }}>
          <span style={{ fontSize: "0.72rem", color: "var(--color-muted)" }}>Changes save to the file's ID3 tags</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onClose} style={{ background: "none", border: "1px solid var(--color-border)", color: "var(--color-ink)", borderRadius: 8, padding: "0.45rem 0.9rem", cursor: "pointer" }}>Cancel</button>
            <button onClick={onSave} disabled={saving} style={{ background: "var(--color-accent)", border: "none", color: "var(--color-ink)", borderRadius: 8, padding: "0.45rem 0.9rem", cursor: "pointer" }}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
