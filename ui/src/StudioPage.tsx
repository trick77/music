import { useState } from "react";
import { studioGenerate, studioRefine, generateStudioCoverArt, studioCoverArtUrl, imageModelOptions, type StudioProgress, type StudioResult } from "./api";
import { copyText } from "./share";
import { Icon } from "./Icon";
import { GenreFanartMode } from "./StudioGenreFanart";
import { AlbumCoverMode } from "./StudioAlbumCover";
import { Button, Spinner, buttonStyle, controlClass, t } from "./ui";

const STYLE_LIMIT = 500;

// CopyButton copies text and briefly confirms, mirroring the app's share flow.
function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    const ok = await copyText(text);
    if (!ok) {
      window.prompt("Copy this text", text);
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button variant="secondary" small onClick={onCopy} aria-label={label}>
      {copied ? "Copied" : label}
    </Button>
  );
}

// ResultCard is one output block with a header, optional right-side count, and a
// copy button. When onChange is provided the body is an editable text area (the
// lyrics), so the user can hand-tweak before copying or refining.
export function ResultCard({ name, note, count, text, monospace = false, onChange }: { name: string; note?: string; count?: string; text: string; monospace?: boolean; onChange?: (value: string) => void }) {
  const boxStyle = {
    background: "color-mix(in srgb, var(--color-bg) 70%, #000)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-ui)",
    padding: "12px 14px",
    fontFamily: monospace ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "var(--font-sans)",
    fontSize: monospace ? "var(--text-label)" : "var(--text-ui)",
    lineHeight: monospace ? 1.55 : 1.7,
    color: "color-mix(in srgb, var(--color-ink) 88%, transparent)",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  };
  return (
    <div style={{ marginBottom: "1.4rem" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "0.4rem", gap: "0.75rem" }}>
        <span style={{ fontWeight: 600, fontSize: "var(--text-ui)" }}>
          {name}
          {note && <span style={{ fontWeight: 400, color: "var(--color-muted)", fontSize: "var(--text-label)", marginLeft: "0.4rem" }}>{note}</span>}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {count && <span style={{ color: "var(--color-muted)", fontSize: "var(--text-label)", fontVariantNumeric: "tabular-nums" }}>{count}</span>}
          <CopyButton text={text} />
        </span>
      </div>
      {onChange ? (
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${name} (editable)`}
          spellCheck={false}
          style={{ ...boxStyle, width: "100%", boxSizing: "border-box", minHeight: 260, resize: "vertical", outline: "none" }}
        />
      ) : (
        <div style={boxStyle}>{text}</div>
      )}
    </div>
  );
}

// CoverArtCard generates a real album cover from the (editable) cover-art prompt
// using the configured image generator. It picks a model, shows the image inline,
// and offers a download. Ephemeral in the UI: state resets when a new song is
// generated (the parent remounts it via key).
export function CoverArtCard({ prompt, models = [], defaultModel = "" }: { prompt: string; models?: string[]; defaultModel?: string }) {
  const options = imageModelOptions(models);
  const [model, setModel] = useState(defaultModel || options[0]?.id || "");
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<{ id: string } | null>(null);
  const [error, setError] = useState("");

  const generate = async () => {
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await generateStudioCoverArt(p, model);
      setImage({ id: res.id });
    } catch (e) {
      setError((e as Error).message || "Cover art generation failed");
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || prompt.trim() === "";
  return (
    <div style={{ marginBottom: "1.4rem" }}>
      <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", marginBottom: "var(--space-3)" }}>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          aria-label="Cover art model"
          className={controlClass}
          disabled={busy}
          style={{ width: "auto", maxWidth: 320 }}
        >
          {options.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <Button busy={busy} disabled={disabled} onClick={generate} style={{ whiteSpace: "nowrap" }}>
          {busy ? "Generating" : image ? "Regenerate" : "Generate cover art"}
        </Button>
      </div>
      {busy && (
        <div aria-live="polite" aria-busy="true" style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", color: "var(--color-muted)", ...t.body }}>
          <Spinner size="18px" />
          <span>Generating cover art</span>
        </div>
      )}
      {error && !busy && (
        <p role="alert" style={{ color: "var(--color-accent-strong)", fontSize: "var(--text-label)", margin: "0.4rem 0 0" }}>{error}</p>
      )}
      {image && !busy && (
        <div style={{ marginTop: "0.4rem" }}>
          <img
            src={studioCoverArtUrl(image.id)}
            alt="Generated cover art"
            style={{ width: "100%", maxWidth: 360, aspectRatio: "1 / 1", objectFit: "cover", borderRadius: "var(--radius-ui)", border: "1px solid var(--color-border)", display: "block" }}
          />
          <a
            href={studioCoverArtUrl(image.id)}
            download={`cover-${image.id}.png`}
            style={{ ...buttonStyle("secondary", { small: true }), marginTop: "var(--space-3)", textDecoration: "none" }}
          >
            <Icon name="download" size="14px" /> Download
          </a>
        </div>
      )}
    </div>
  );
}

// StudioPage turns a named reference song into a Suno prompt. It streams live
// research progress, shows three ephemeral outputs, refines the lyrics on
// request, and resets fully when a new song is submitted.
export function StudioPage({ imageGenEnabled = false, chatEnabled = false, imageModels = [], defaultImageModel = "", initialGenreId }: { imageGenEnabled?: boolean; chatEnabled?: boolean; imageModels?: string[]; defaultImageModel?: string; initialGenreId?: string }) {
  // Genre → Fanart and Album Cover are extra modes that only exist when the image
  // generator is configured; otherwise Studio stays the single-purpose Suno tool.
  // Arriving with a genre (from the Genres grid) opens straight into fanart mode.
  const [mode, setMode] = useState<"suno" | "fanart" | "coverart">(imageGenEnabled && initialGenreId ? "fanart" : "suno");
  const [reference, setReference] = useState("");
  const [generatedRef, setGeneratedRef] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [steps, setSteps] = useState<StudioProgress[]>([]);
  const [result, setResult] = useState<StudioResult | null>(null);
  const [error, setError] = useState("");
  const [refineInstruction, setRefineInstruction] = useState("");
  const [refining, setRefining] = useState(false);

  const busy = status === "loading" || refining;
  const stale = status === "done" && reference.trim() !== generatedRef && reference.trim() !== "";

  const generate = async () => {
    const ref = reference.trim();
    if (!ref || busy) return;
    setStatus("loading");
    setResult(null);
    setSteps([]);
    setError("");
    setRefineInstruction("");
    try {
      const res = await studioGenerate(ref, (p) => setSteps((s) => [...s, p]));
      setResult(res);
      setGeneratedRef(ref);
      setStatus("done");
    } catch (e) {
      setError((e as Error).message || "Generation failed");
      setStatus("error");
    }
  };

  const refine = async () => {
    const instr = refineInstruction.trim();
    if (!instr || !result || busy) return;
    setRefining(true);
    setSteps([]);
    setError("");
    try {
      const lyrics = await studioRefine(generatedRef, result.lyrics, instr, (p) => setSteps((s) => [...s, p]));
      setResult({ ...result, lyrics });
      setRefineInstruction("");
    } catch (e) {
      setError((e as Error).message || "Refinement failed");
    } finally {
      setRefining(false);
    }
  };

  const current = steps.length > 0 ? steps[steps.length - 1] : null;

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ ...t.display, margin: "0 0 0.25rem" }}>Studio</h1>
      <p style={{ color: "var(--color-muted)", margin: "0 0 var(--space-5)" }}>
        {mode === "fanart" ? "Generate cover fanart for a genre." : mode === "coverart" ? "Create or replace cover art for an album." : "Turn a song into a Suno prompt."}
      </p>

      {/* Mode switch appears only when the image generator is configured. Song →
          Suno is last per the studio ordering. */}
      {imageGenEnabled && (
        <div role="tablist" aria-label="Studio mode" style={{ display: "inline-flex", padding: 3, gap: 3, border: "1px solid var(--color-border)", borderRadius: 999, background: "var(--color-panel)", marginBottom: "1.6rem" }}>
          {([["fanart", "Genre → Fanart"], ["coverart", "Album Cover"], ["suno", "Song → Suno"]] as const).map(([m, label]) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              style={{ border: "none", background: mode === m ? "var(--color-accent-fill)" : "transparent", color: mode === m ? "var(--color-ink)" : "var(--color-muted)",
                fontFamily: "var(--font-sans)", fontSize: "var(--text-ui)", padding: "6px 14px", borderRadius: 999, cursor: "pointer" }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {mode === "fanart" ? (
        <GenreFanartMode chatEnabled={chatEnabled} imageModels={imageModels} defaultImageModel={defaultImageModel} initialGenreId={initialGenreId} />
      ) : mode === "coverart" ? (
        <AlbumCoverMode chatEnabled={chatEnabled} imageModels={imageModels} defaultImageModel={defaultImageModel} />
      ) : (<>

      {/* Reference input — submit (Enter or Generate) is the single reset+run action. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          generate();
        }}
        style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}
      >
        <input
          type="text"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="Name a song — e.g. Metallica, Enter Sandman"
          aria-label="Song reference"
          className={controlClass}
          disabled={busy}
          style={{ flex: 1 }}
        />
        <Button type="submit" busy={status === "loading"} disabled={busy || reference.trim() === ""} style={{ whiteSpace: "nowrap" }}>
          {status === "loading" ? "Working" : "Generate"}
        </Button>
      </form>
      <p style={{ color: "var(--color-muted)", fontSize: "var(--text-label)", margin: "0.5rem 0 0" }}>
        MiMo researches the song on the web, captures its style, writes fresh original lyrics on the same theme (never the original words), and sketches cover art. Results are shown once and not stored.
      </p>
      {stale && (
        <p style={{ color: "var(--color-accent-strong)", fontSize: "var(--text-label)", margin: "0.5rem 0 0" }}>
          Press Enter to regenerate for “{reference.trim()}”.
        </p>
      )}

      {/* Live research progress */}
      {busy && (
        <div style={{ marginTop: "var(--space-6)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", color: "var(--color-muted)", ...t.body }}>
            <Spinner size="18px" />
            <span>{current ? current.detail : "Starting research"}</span>
          </div>
          {steps.length > 1 && (
            <ul style={{ listStyle: "none", padding: 0, margin: "var(--space-3) 0 0", color: "var(--color-muted)", fontSize: "var(--text-label)" }}>
              {steps.slice(0, -1).map((s, i) => (
                <li key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "0.15rem 0" }}><Icon name="check" size="13px" /> {s.detail}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && !busy && (
        <p role="alert" style={{ color: "var(--color-accent-strong)", marginTop: "1.4rem" }}>{error}</p>
      )}

      {/* Results */}
      {result && !busy && (
        <div style={{ marginTop: "2rem" }}>
          <ResultCard
            name="Style prompt"
            note="→ Suno “Style”"
            count={`${result.stylePrompt.length} / ${STYLE_LIMIT}`}
            text={result.stylePrompt}
            monospace
          />

          <ResultCard
            name="Lyrics"
            note="→ Suno “Lyrics” · original, editable"
            text={result.lyrics}
            onChange={(value) => setResult({ ...result, lyrics: value })}
          />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              refine();
            }}
            style={{ display: "flex", gap: "0.5rem", margin: "-0.7rem 0 1.6rem" }}
          >
            <input
              type="text"
              value={refineInstruction}
              onChange={(e) => setRefineInstruction(e.target.value)}
              placeholder="Refine the lyrics — e.g. “do not say lullaby”, “darker chorus”"
              aria-label="Refine lyrics instruction"
              className={controlClass}
              disabled={busy}
              style={{ flex: 1 }}
            />
            <Button type="submit" variant="secondary" busy={refining} disabled={busy || refineInstruction.trim() === ""} style={{ whiteSpace: "nowrap" }}>
              Refine
            </Button>
          </form>

          <ResultCard
            name="Cover-art prompt"
            note="→ image generator · editable"
            text={result.coverArtPrompt}
            onChange={(value) => setResult({ ...result, coverArtPrompt: value })}
          />
          {imageGenEnabled && <CoverArtCard key={generatedRef} prompt={result.coverArtPrompt} models={imageModels} defaultModel={defaultImageModel} />}
        </div>
      )}
      </>)}
    </div>
  );
}
