import { useState } from "react";
import { uploadFanart, generateFanart, getFanartMeta, patchGenre, type GenreDetail, type Fanart } from "./api";
import { fanartUrl } from "./fanart";
import { Icon } from "./Icon";

type Props = { detail: GenreDetail; imageGenEnabled: boolean; onClose: () => void; onChanged: () => void };

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: "0.7rem", letterSpacing: "0.08em", textTransform: "uppercase",
  color: "var(--color-muted)", marginBottom: 4,
};

export function GenreEditor({ detail, imageGenEnabled, onClose, onChanged }: Props) {
  const [name, setName] = useState(detail.genre.name);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const genreId = detail.genre.id;

  const refresh = () => onChanged();

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(null);
    try { await uploadFanart("genre", genreId, file); refresh(); }
    catch { setErr("Upload failed"); }
    e.target.value = "";
  };

  const setBackground = async (fa: Fanart) => {
    if (fa.status !== "ready") return;
    try { await patchGenre(genreId, { backgroundFanartId: fa.id }); refresh(); }
    catch { setErr("Could not set background"); }
  };

  const toggleHero = async (fa: Fanart) => {
    if (fa.status !== "ready") return;
    try { await patchGenre(genreId, fa.isHero ? { clearHero: fa.id } : { heroFanartId: fa.id }); refresh(); }
    catch { setErr("Could not update hero"); }
  };

  const saveName = async () => {
    if (!name.trim()) return;
    try { await patchGenre(genreId, { name: name.trim() }); refresh(); }
    catch { setErr("Rename failed"); }
  };

  const pollUntilDone = async (id: string) => {
    for (let i = 0; i < 120; i++) {
      const fa = await getFanartMeta(id);
      if (fa.status !== "generating") { refresh(); if (fa.status === "failed") setErr(fa.error || "Generation failed"); return; }
      await new Promise((r) => setTimeout(r, 1500));
      refresh();
    }
  };

  const onGenerate = async () => {
    if (!prompt.trim()) return;
    setBusy(true); setErr(null);
    try {
      const { id } = await generateFanart(prompt.trim(), "genre", genreId);
      setPrompt("");
      refresh();
      void pollUntilDone(id);
    } catch { setErr("Could not start generation"); }
    finally { setBusy(false); }
  };

  const active = detail.fanart.find((f) => f.id === detail.backgroundId);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "grid", placeItems: "center", padding: "1rem", zIndex: 60 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(680px,100%)", background: "var(--color-panel)", border: "1px solid var(--color-border)", borderRadius: 14, padding: "1.25rem", maxHeight: "90vh", overflow: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1rem" }}>
          <h3 style={{ margin: 0, fontFamily: "var(--font-serif)" }}>Edit genre</h3>
          <button onClick={onClose} aria-label="Close" style={{ background: "none", border: "none", color: "var(--color-muted)", cursor: "pointer", fontSize: "1.2rem" }}>×</button>
        </div>

        <div style={{ height: 200, borderRadius: 12, marginBottom: "1rem", background: active ? `linear-gradient(180deg,rgba(0,0,0,0.05),rgba(0,0,0,0.55)), url(${fanartUrl(active.id, "hero")}) center/cover` : "var(--color-active)", display: "grid", placeItems: "center" }}>
          {!active && <span style={{ color: "var(--color-muted)" }}>No background yet</span>}
        </div>

        <label style={labelStyle}>Name</label>
        <div style={{ display: "flex", gap: 8, marginBottom: "1rem" }}>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, background: "var(--color-bg)", color: "var(--color-ink)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "0.5rem 0.6rem", font: "inherit" }} />
          <button onClick={saveName} style={{ background: "var(--color-active)", border: "1px solid var(--color-border)", color: "var(--color-ink)", borderRadius: 8, padding: "0.45rem 0.9rem", cursor: "pointer" }}>Save</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(110px,1fr))", gap: 10, marginBottom: "1rem" }}>
          {detail.fanart.map((fa) => (
            <div key={fa.id} style={{ position: "relative", aspectRatio: "16/9", borderRadius: 10, overflow: "hidden", border: fa.id === detail.backgroundId ? "2px solid var(--color-accent-strong)" : "1px solid var(--color-border)", background: "var(--color-active)" }}>
              {fa.status === "ready" ? (
                <button onClick={() => setBackground(fa)} aria-label="Set as background" style={{ width: "100%", height: "100%", border: "none", padding: 0, cursor: "pointer", background: `url(${fanartUrl(fa.id, "card")}) center/cover` }} />
              ) : (
                <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--color-muted)", fontSize: "0.75rem" }}>
                  {fa.status === "generating" ? <Icon name="spinner" size="20px" /> : "failed"}
                </div>
              )}
              {fa.status === "ready" && (
                <button onClick={() => toggleHero(fa)} aria-label={fa.isHero ? "Unstar hero" : "Star as hero"} style={{ position: "absolute", top: 4, right: 4, background: "rgba(0,0,0,0.5)", border: "none", borderRadius: 6, cursor: "pointer", color: fa.isHero ? "var(--color-accent-strong)" : "#fff", display: "grid", placeItems: "center", padding: 2 }}>
                  <Icon name={fa.isHero ? "starFilled" : "star"} size="16px" />
                </button>
              )}
            </div>
          ))}
          <label style={{ aspectRatio: "16/9", borderRadius: 10, border: "1px dashed var(--color-border)", display: "grid", placeItems: "center", cursor: "pointer", color: "var(--color-accent-strong)" }}>
            <span style={{ display: "grid", placeItems: "center", gap: 4 }}><Icon name="upload" size="18px" /><span style={{ fontSize: "0.75rem" }}>Upload</span></span>
            <input type="file" accept="image/jpeg,image/png" onChange={onUpload} style={{ display: "none" }} />
          </label>
        </div>

        {imageGenEnabled && (
          <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: "1rem" }}>
            <label style={labelStyle}>Generate image</label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe the image you want…" rows={3}
              style={{ width: "100%", background: "var(--color-bg)", color: "var(--color-ink)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "0.5rem 0.6rem", font: "inherit", resize: "vertical" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button onClick={onGenerate} disabled={busy || !prompt.trim()} style={{ background: "var(--color-accent)", border: "none", color: "#fff", borderRadius: 8, padding: "0.45rem 0.9rem", cursor: "pointer" }}>{busy ? "Starting…" : "Generate"}</button>
            </div>
          </div>
        )}

        {err && <p style={{ color: "var(--color-accent-strong)", marginTop: "0.75rem" }}>{err}</p>}
      </div>
    </div>
  );
}
