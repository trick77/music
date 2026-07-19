import { useEffect, useState } from "react";
import { listGenres, generateFanart, getFanartMeta, suggestGenrePrompt, refineGenrePrompt, patchGenre, type GenreSummary, type Fanart } from "./api";
import { fanartUrl } from "./fanart";
import { Icon } from "./Icon";
import { navigate } from "./router";
import { ModelPicker, RefineRow } from "./StudioShared";
import { Button, Spinner, controlClass, fieldLabel, t } from "./ui";
import { genreLabel } from "./titleCase";

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
      <label htmlFor="fanart-genre" style={fieldLabel}>Genre</label>
      <select
        id="fanart-genre"
        aria-label="Genre"
        className={controlClass}
        value={genreId}
        onChange={(e) => { setGenreId(e.target.value); setResult(null); setSaved(false); }}
        disabled={busy}
        style={{ marginBottom: "var(--space-5)", maxWidth: 280 }}
      >
        {genres.length === 0 && <option value="">Loading…</option>}
        {genres.map((g) => (
          <option key={g.id} value={g.id}>{genreLabel(g.name)}{g.hasBackground ? "" : " — needs artwork"}</option>
        ))}
      </select>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <label htmlFor="fanart-prompt" style={{ ...fieldLabel, marginBottom: 0 }}>Prompt</label>
        {chatEnabled && (
          <Button variant="ghost" small busy={suggesting} disabled={!genreId} onClick={onSuggest}>
            {!suggesting && <Icon name="feather" size="14px" />}Suggest prompt
          </Button>
        )}
      </div>
      <textarea
        id="fanart-prompt"
        aria-label="Fanart prompt"
        className={controlClass}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={suggesting || refining}
        placeholder="Describe the scene for this genre's background…"
        rows={3}
        style={{ marginBottom: "var(--space-3)" }}
      />
      {chatEnabled && <RefineRow onRefine={onRefine} busy={refining} disabled={busy || !genreId || prompt.trim() === ""} />}
      <ModelPicker models={imageModels} value={model} onChange={setModel} disabled={busy} />
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", marginBottom: "var(--space-1)" }}>
        <Button busy={busy} disabled={genDisabled} onClick={onGenerate}>
          {busy ? "Generating" : result?.status === "ready" ? "Regenerate" : "Generate fanart"}
        </Button>
        <span style={t.label}>Wide 16:9 background · saved to the genre's gallery.</span>
      </div>

      {busy && (
        <div aria-live="polite" aria-busy="true" style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", color: "var(--color-muted)", ...t.body, marginTop: "var(--space-3)" }}>
          <Spinner size="18px" /><span>Generating fanart</span>
        </div>
      )}
      {err && !busy && <p role="alert" style={{ color: "var(--color-accent-strong)", fontSize: "var(--text-label)", margin: "var(--space-3) 0 0" }}>{err}</p>}

      {result?.status === "ready" && !busy && (
        <div style={{ marginTop: "var(--space-4)" }}>
          <img
            src={fanartUrl(result.id, "hero")}
            alt="Generated genre fanart"
            style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", borderRadius: "var(--radius-ui)", border: "1px solid var(--color-border)", display: "block" }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: "var(--space-3)", flexWrap: "wrap" }}>
            <Button variant={saved ? "secondary" : "primary"} small disabled={saved} onClick={setBackground}>
              {saved && <Icon name="check" size="14px" />}Set as background
            </Button>
            <Button variant="secondary" small onClick={() => navigate(`/genre/${genreId}`)}>Open genre</Button>
          </div>
        </div>
      )}
    </div>
  );
}
