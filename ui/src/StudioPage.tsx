import { useState } from "react";
import { studioGenerate, studioRefine, generateStudioCoverArt, studioCoverArtUrl, imageModelOptions, type StudioProgress, type StudioResult } from "./api";
import { copyText } from "./share";
import { Icon } from "./Icon";
import { GenreFanartMode } from "./StudioGenreFanart";
import { AlbumCoverMode } from "./StudioAlbumCover";

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
    <button
      onClick={onCopy}
      aria-label={label}
      style={{
        fontSize: "0.78rem",
        color: "var(--color-ink)",
        background: "var(--color-active)",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        padding: "0.25rem 0.6rem",
        cursor: "pointer",
      }}
    >
      {copied ? "Copied" : label}
    </button>
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
    padding: "0.8rem 0.9rem",
    fontFamily: monospace ? "ui-monospace, SFMono-Regular, Menlo, monospace" : "var(--font-sans)",
    fontSize: monospace ? "0.82rem" : "0.88rem",
    lineHeight: monospace ? 1.55 : 1.7,
    color: "color-mix(in srgb, var(--color-ink) 88%, transparent)",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  };
  return (
    <div style={{ marginBottom: "1.4rem" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: "0.4rem", gap: "0.75rem" }}>
        <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>
          {name}
          {note && <span style={{ fontWeight: 400, color: "var(--color-muted)", fontSize: "0.78rem", marginLeft: "0.4rem" }}>{note}</span>}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {count && <span style={{ color: "var(--color-muted)", fontSize: "0.78rem", fontVariantNumeric: "tabular-nums" }}>{count}</span>}
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
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.6rem" }}>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          aria-label="Cover art model"
          disabled={busy}
          style={{
            background: "var(--color-panel)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-ui)",
            padding: "0.5rem 0.6rem",
            color: "var(--color-ink)",
            fontFamily: "var(--font-sans)",
            fontSize: "0.85rem",
            outline: "none",
          }}
        >
          {options.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
        <button
          onClick={generate}
          disabled={disabled}
          style={{
            background: "var(--color-accent-strong)",
            color: "var(--color-ink)",
            fontWeight: 600,
            fontSize: "0.85rem",
            border: "none",
            borderRadius: "var(--radius-ui)",
            padding: "0.5rem 0.9rem",
            cursor: disabled ? "default" : "pointer",
            opacity: disabled ? 0.6 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {busy ? "Generating…" : image ? "Regenerate" : "Generate cover art"}
        </button>
      </div>
      {busy && (
        <div aria-live="polite" aria-busy="true" style={{ display: "flex", alignItems: "center", gap: "0.6rem", color: "var(--color-ink)", fontSize: "0.9rem" }}>
          <Spinner />
          <span>Generating cover art…</span>
        </div>
      )}
      {error && !busy && (
        <p role="alert" style={{ color: "var(--color-accent-strong)", fontSize: "0.85rem", margin: "0.4rem 0 0" }}>{error}</p>
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
            style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", marginTop: "0.6rem", fontSize: "0.82rem", color: "var(--color-ink)", background: "var(--color-active)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "0.35rem 0.7rem", textDecoration: "none" }}
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
      <h1 style={{ fontFamily: "var(--font-serif)", fontWeight: 500, fontSize: "1.9rem", margin: "0 0 0.25rem" }}>Studio</h1>
      <p style={{ color: "var(--color-muted)", margin: "0 0 1.2rem" }}>
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
              style={{ border: "none", background: mode === m ? "var(--color-active)" : "transparent", color: mode === m ? "var(--color-ink)" : "var(--color-muted)",
                font: "inherit", fontSize: "0.83rem", padding: "0.35rem 0.9rem", borderRadius: 999, cursor: "pointer" }}
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
          disabled={busy}
          style={{
            flex: 1,
            background: "var(--color-panel)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-ui)",
            padding: "0.7rem 0.9rem",
            color: "var(--color-ink)",
            fontFamily: "var(--font-sans)",
            fontSize: "1rem",
            outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={busy || reference.trim() === ""}
          style={{
            background: "var(--color-accent-strong)",
            color: "var(--color-ink)",
            fontWeight: 600,
            fontSize: "0.95rem",
            border: "none",
            borderRadius: "var(--radius-ui)",
            padding: "0.7rem 1.2rem",
            cursor: busy || reference.trim() === "" ? "default" : "pointer",
            opacity: busy || reference.trim() === "" ? 0.6 : 1,
            whiteSpace: "nowrap",
          }}
        >
          {status === "loading" ? "Working…" : "Generate"}
        </button>
      </form>
      <p style={{ color: "var(--color-muted)", fontSize: "0.8rem", margin: "0.5rem 0 0" }}>
        MiMo researches the song on the web, captures its style, writes fresh original lyrics on the same theme (never the original words), and sketches cover art. Results are shown once and not stored.
      </p>
      {stale && (
        <p style={{ color: "var(--color-accent-strong)", fontSize: "0.8rem", margin: "0.5rem 0 0" }}>
          Press Enter to regenerate for “{reference.trim()}”.
        </p>
      )}

      {/* Live research progress */}
      {busy && (
        <div style={{ marginTop: "1.6rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", color: "var(--color-ink)", fontSize: "0.9rem" }}>
            <Spinner />
            <span>{current ? current.detail : "Starting research…"}</span>
          </div>
          {steps.length > 1 && (
            <ul style={{ listStyle: "none", padding: 0, margin: "0.8rem 0 0", color: "var(--color-muted)", fontSize: "0.82rem" }}>
              {steps.slice(0, -1).map((s, i) => (
                <li key={i} style={{ padding: "0.15rem 0" }}>✓ {s.detail}</li>
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
              disabled={busy}
              style={{
                flex: 1,
                background: "var(--color-panel)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                padding: "0.55rem 0.75rem",
                color: "var(--color-ink)",
                fontFamily: "var(--font-sans)",
                fontSize: "0.85rem",
                outline: "none",
              }}
            />
            <button
              type="submit"
              disabled={busy || refineInstruction.trim() === ""}
              style={{
                fontSize: "0.85rem",
                color: "var(--color-ink)",
                fontWeight: 500,
                background: "var(--color-active)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                padding: "0.55rem 0.9rem",
                cursor: busy || refineInstruction.trim() === "" ? "default" : "pointer",
                opacity: busy || refineInstruction.trim() === "" ? 0.6 : 1,
                whiteSpace: "nowrap",
              }}
            >
              Refine
            </button>
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

// Spinner is a small CSS-less rotating indicator using an SVG stroke arc.
function Spinner() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden style={{ animation: "studio-spin 0.8s linear infinite" }}>
      <circle cx="12" cy="12" r="9" stroke="var(--color-border)" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="var(--color-accent-strong)" strokeWidth="3" strokeLinecap="round" />
      <style>{`@keyframes studio-spin { to { transform: rotate(360deg); transform-origin: center; } }`}</style>
    </svg>
  );
}
