import { useEffect, useState } from "react";
import { listGenres, generateFanart, getFanartMeta, suggestGenrePrompt, refineGenrePrompt, patchGenre, type GenreSummary, type Fanart } from "./api";
import { fanartUrl } from "./fanart";
import { Icon } from "./Icon";
import { navigate } from "./router";
import { controlStyle, fieldLabelStyle, ModelPicker, RefineRow } from "./StudioShared";

type Props = { chatEnabled: boolean; imageModels: string[]; defaultImageModel: string; initialGenreId?: string };

// GenreFanartMode generates a wide 16:9 background image for a genre. It reuses
// the same endpoints as the (retired) in-modal generator: suggest-prompt authors
// an editable prompt, generate kicks off an async job that we poll to ready, and
// set-as-background activates the result on the genre. Fetches happen in effects
// so SSR renders a deterministic, fetch-free idle surface.
export function GenreFanartMode({ chatEnabled, imageModels, defaultImageModel, initialGenreId }: Props) {
  const [genres, setGenres] = useState<GenreSummary[]>([]);
  const [genreId, setGenreId] = useState(initialGenreId ?? "");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(defaultImageModel);
  const [suggesting, setSuggesting] = useState(false);
  const [refining, setRefining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Fanart | null>(null);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    listGenres()
      .then((gs) => {
        setGenres(gs);
        // Fall back to the first genre when none was pre-selected.
        setGenreId((cur) => cur || gs[0]?.id || "");
      })
      .catch(() => setErr("Could not load genres"));
  }, []);

  const onSuggest = async () => {
    if (!genreId) return;
    setSuggesting(true); setErr(null);
    try { setPrompt(await suggestGenrePrompt(genreId)); }
    catch { setErr("Could not suggest a prompt"); }
    finally { setSuggesting(false); }
  };

  const onRefine = async (instruction: string) => {
    if (!genreId || !prompt.trim()) return;
    setRefining(true); setErr(null);
    try { setPrompt(await refineGenrePrompt(genreId, prompt.trim(), instruction)); }
    catch { setErr("Could not refine the prompt"); }
    finally { setRefining(false); }
  };

  const pollUntilDone = async (id: string) => {
    for (let i = 0; i < 120; i++) {
      const fa = await getFanartMeta(id);
      if (fa.status !== "generating") {
        setResult(fa);
        setBusy(false);
        if (fa.status === "failed") setErr(fa.error || "Generation failed");
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    // Ran out of poll attempts while still generating — surface it rather than
    // dropping silently back to the idle button.
    setBusy(false);
    setErr("Still generating — check the genre's gallery in a moment.");
  };

  const onGenerate = async () => {
    if (!genreId || !prompt.trim() || busy) return;
    setBusy(true); setErr(null); setResult(null); setSaved(false);
    try {
      const { id } = await generateFanart(prompt.trim(), "genre", genreId, model);
      void pollUntilDone(id);
    } catch { setErr("Could not start generation"); setBusy(false); }
  };

  const setBackground = async () => {
    if (!result || result.status !== "ready") return;
    try { await patchGenre(genreId, { backgroundFanartId: result.id }); setSaved(true); }
    catch { setErr("Could not set background"); }
  };

  const genDisabled = busy || !genreId || prompt.trim() === "";

  return (
    <div>
      <label htmlFor="fanart-genre" style={fieldLabelStyle}>Genre</label>
      <select
        id="fanart-genre"
        aria-label="Genre"
        value={genreId}
        onChange={(e) => { setGenreId(e.target.value); setResult(null); setSaved(false); }}
        disabled={busy}
        style={{ ...controlStyle, marginBottom: "1.1rem", minWidth: 220 }}
      >
        {genres.length === 0 && <option value="">Loading…</option>}
        {genres.map((g) => (
          <option key={g.id} value={g.id}>{g.name}{g.hasBackground ? "" : " — needs artwork"}</option>
        ))}
      </select>

      <ModelPicker models={imageModels} value={model} onChange={setModel} disabled={busy} />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
        <label htmlFor="fanart-prompt" style={{ ...fieldLabelStyle, marginBottom: 0 }}>Prompt</label>
        {chatEnabled && (
          <button
            onClick={onSuggest}
            disabled={suggesting || !genreId}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "none", border: "1px solid var(--color-border)",
              color: "var(--color-accent-strong)", borderRadius: 8, padding: "0.3rem 0.65rem", font: "inherit", fontSize: "0.8rem",
              cursor: suggesting ? "default" : "pointer" }}
          >
            <Icon name="feather" size="14px" />{suggesting ? "Thinking…" : "Suggest prompt"}
          </button>
        )}
      </div>
      <textarea
        id="fanart-prompt"
        aria-label="Fanart prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe the scene for this genre's background…"
        rows={3}
        style={{ ...controlStyle, width: "100%", boxSizing: "border-box", resize: "vertical", marginBottom: "0.8rem" }}
      />
      {chatEnabled && <RefineRow onRefine={onRefine} busy={refining} disabled={busy || !genreId || prompt.trim() === ""} />}
      <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", marginBottom: "0.4rem" }}>
        <button
          onClick={onGenerate}
          disabled={genDisabled}
          style={{ background: "var(--color-accent-strong)", color: "var(--color-ink)", fontWeight: 600, fontSize: "0.9rem", border: "none",
            borderRadius: "var(--radius-ui)", padding: "0.6rem 1.1rem", cursor: genDisabled ? "default" : "pointer", opacity: genDisabled ? 0.6 : 1 }}
        >
          {busy ? "Generating…" : result?.status === "ready" ? "Regenerate" : "Generate fanart"}
        </button>
        <span style={{ color: "var(--color-muted)", fontSize: "0.78rem" }}>Wide 16:9 background · saved to the genre's gallery.</span>
      </div>

      {busy && (
        <div aria-live="polite" aria-busy="true" style={{ display: "flex", alignItems: "center", gap: "0.6rem", color: "var(--color-ink)", fontSize: "0.9rem", marginTop: "0.8rem" }}>
          <Icon name="spinner" size="20px" /><span>Generating fanart…</span>
        </div>
      )}
      {err && !busy && <p role="alert" style={{ color: "var(--color-accent-strong)", fontSize: "0.85rem", margin: "0.6rem 0 0" }}>{err}</p>}

      {result?.status === "ready" && !busy && (
        <div style={{ marginTop: "1rem" }}>
          <img
            src={fanartUrl(result.id, "hero")}
            alt="Generated genre fanart"
            style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: "var(--radius-ui)", border: "1px solid var(--color-border)", display: "block" }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: "0.8rem", marginTop: "0.7rem", flexWrap: "wrap" }}>
            <button
              onClick={setBackground}
              disabled={saved}
              style={{ background: saved ? "var(--color-active)" : "var(--color-accent-strong)", color: saved ? "var(--color-muted)" : "var(--color-ink)",
                fontWeight: 600, fontSize: "0.85rem", border: "none", borderRadius: "var(--radius-ui)", padding: "0.5rem 0.9rem", cursor: saved ? "default" : "pointer" }}
            >
              {saved ? "Set as background ✓" : "Set as background"}
            </button>
            <button
              onClick={() => navigate(`/genre/${genreId}`)}
              style={{ background: "transparent", color: "var(--color-muted)", fontSize: "0.85rem", border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-ui)", padding: "0.5rem 0.9rem", cursor: "pointer" }}
            >
              Open genre
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
