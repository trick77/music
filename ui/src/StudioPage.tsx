import { useEffect, useRef, useState } from "react";
import {
  studioGenerate,
  studioRefine,
  generateStudioCoverArt,
  studioCoverArtUrl,
  imageModelOptions,
  patchStudioRun,
  type StudioProgress,
  type StudioPartial,
  type StudioResult,
} from "./api";
import { copyText } from "./share";
import { Icon } from "./Icon";
import { GenreFanartMode } from "./StudioGenreFanart";
import { AlbumCoverMode } from "./StudioAlbumCover";
import { StudioHistoryDrawer } from "./StudioHistoryDrawer";
import { StudioHistoryRun } from "./StudioHistoryRun";
import { Button, Spinner, buttonStyle, controlClass, t } from "./ui";
import { IdentityCard, ResultCard } from "./StudioShared";

// ResultCard is re-exported for the Studio suite, which has always reached for it
// here; it now lives in StudioShared so the read-only history sheet can use the
// very same card.
export { ResultCard } from "./StudioShared";

const STYLE_LIMIT = 500;

// HAND_EDIT_DEBOUNCE_MS is how long typing in the lyrics box settles before the
// saved copy is updated. Long enough that a sentence is one write, short enough
// that closing the page straight after typing still saves.
const HAND_EDIT_DEBOUNCE_MS = 800;

// EMPTY_RESULT seeds the result the moment generation starts, so every card has
// a slot to sit in while its turn is still running.
const EMPTY_RESULT: StudioResult = {
  stylePrompt: "",
  lyrics: "",
  coverArtPrompt: "",
  genres: [],
  bands: [],
  titles: [],
  albums: [],
};

// hasContent reports whether any turn actually delivered something.
export function hasContent(r: StudioResult): boolean {
  return Boolean(
    r.stylePrompt ||
    r.lyrics ||
    r.coverArtPrompt ||
    r.genres.length ||
    r.bands.length ||
    r.titles.length ||
    r.albums.length,
  );
}

// mergePartial folds one finished part into the result, ignoring blank fields.
// The server sends the whole GenerateResult shape each time, so a plain spread
// would let a later turn's empty strings wipe an earlier turn's answer.
export function mergePartial(
  prev: StudioResult,
  partial: StudioPartial,
): StudioResult {
  const next = { ...prev };
  if (partial.stylePrompt) next.stylePrompt = partial.stylePrompt;
  if (partial.lyrics) next.lyrics = partial.lyrics;
  if (partial.coverArtPrompt) next.coverArtPrompt = partial.coverArtPrompt;
  if (partial.genres?.length) next.genres = partial.genres;
  if (partial.bands?.length) next.bands = partial.bands;
  if (partial.titles?.length) next.titles = partial.titles;
  if (partial.albums?.length) next.albums = partial.albums;
  return next;
}

// PendingCard holds a card's place while the turn that fills it is still
// running: same header, same box, greyed placeholder lines instead of content.
// Reserving the slot is the point — the page keeps its shape as parts land, so
// nothing below jumps when a card fills in.
function PendingCard({
  name,
  note,
  lines = 3,
  tall = false,
}: {
  name: string;
  note?: string;
  lines?: number;
  tall?: boolean;
}) {
  return (
    <div style={{ marginBottom: "1.4rem" }} aria-busy="true">
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "0.5rem",
          marginBottom: "0.4rem",
        }}
      >
        <span
          style={{
            fontWeight: 600,
            fontSize: "var(--text-ui)",
            color: "var(--color-muted)",
          }}
        >
          {name}
        </span>
        {note && (
          <span
            style={{
              color: "var(--color-muted)",
              fontSize: "var(--text-label)",
            }}
          >
            {note}
          </span>
        )}
      </div>
      <div
        style={{
          background: "color-mix(in srgb, var(--color-bg) 70%, #000)",
          border: "1px solid var(--color-border)",
          borderRadius: "var(--radius-ui)",
          padding: "14px",
          minHeight: tall ? 260 : undefined,
          display: "flex",
          flexDirection: "column",
          gap: "0.6rem",
        }}
      >
        {Array.from({ length: lines }).map((_, i) => (
          <span
            key={i}
            className="studio-skeleton"
            style={{
              display: "block",
              height: 10,
              borderRadius: 5,
              // Ragged widths read as text rather than as a loading bar.
              width: `${[92, 78, 85, 64, 88, 72, 80, 58][i % 8]}%`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

// CoverArtCard generates a real album cover from the (editable) cover-art prompt
// using the configured image generator. It picks a model, shows the image inline,
// and offers a download. Ephemeral in the UI: state resets when a new song is
// generated (the parent remounts it via key).
export function CoverArtCard({
  prompt,
  models = [],
  defaultModel = "",
  onGenerated,
}: {
  prompt: string;
  models?: string[];
  defaultModel?: string;
  // Called with the new image's id once one exists, so the caller can attach it
  // to the saved run. Regenerating calls it again and the latest image wins.
  onGenerated?: (id: string) => void;
}) {
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
      onGenerated?.(res.id);
    } catch (e) {
      setError((e as Error).message || "Cover art generation failed");
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || prompt.trim() === "";
  return (
    <div style={{ marginBottom: "1.4rem" }}>
      <div
        style={{
          display: "flex",
          gap: "var(--space-2)",
          alignItems: "center",
          marginBottom: "var(--space-3)",
        }}
      >
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          aria-label="Cover art model"
          className={controlClass}
          disabled={busy}
          style={{ width: "auto", maxWidth: 320 }}
        >
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <Button
          busy={busy}
          disabled={disabled}
          onClick={generate}
          style={{ whiteSpace: "nowrap" }}
        >
          {busy ? "Generating" : image ? "Regenerate" : "Generate cover art"}
        </Button>
      </div>
      {busy && (
        <div
          aria-live="polite"
          aria-busy="true"
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            color: "var(--color-muted)",
            ...t.body,
          }}
        >
          <Spinner size="18px" />
          <span>Generating cover art</span>
        </div>
      )}
      {error && !busy && (
        <p
          role="alert"
          style={{
            color: "var(--color-accent-strong)",
            fontSize: "var(--text-label)",
            margin: "0.4rem 0 0",
          }}
        >
          {error}
        </p>
      )}
      {image && !busy && (
        <div style={{ marginTop: "0.4rem" }}>
          <img
            src={studioCoverArtUrl(image.id)}
            alt="Generated cover art"
            style={{
              width: "100%",
              maxWidth: 360,
              aspectRatio: "1 / 1",
              objectFit: "cover",
              borderRadius: "var(--radius-ui)",
              border: "1px solid var(--color-border)",
              display: "block",
            }}
          />
          <a
            href={studioCoverArtUrl(image.id)}
            download={`cover-${image.id}.png`}
            style={{
              ...buttonStyle("secondary", { small: true }),
              marginTop: "var(--space-3)",
              textDecoration: "none",
            }}
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
export function StudioPage({
  imageGenEnabled = false,
  chatEnabled = false,
  historyEnabled = false,
  imageModels = [],
  defaultImageModel = "",
  initialGenreId,
}: {
  imageGenEnabled?: boolean;
  chatEnabled?: boolean;
  // True when the server has a library to keep runs in. False hides the history
  // icon outright — there is nothing behind it.
  historyEnabled?: boolean;
  imageModels?: string[];
  defaultImageModel?: string;
  initialGenreId?: string;
}) {
  // Genre → Fanart and Album Cover are extra modes that only exist when the image
  // generator is configured; otherwise Studio stays the single-purpose Suno tool.
  // Arriving with a genre (from the Genres grid) opens straight into fanart mode.
  const [mode, setMode] = useState<"suno" | "fanart" | "coverart">(
    imageGenEnabled && initialGenreId ? "fanart" : "suno",
  );
  const [reference, setReference] = useState("");
  const [generatedRef, setGeneratedRef] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  );
  const [steps, setSteps] = useState<StudioProgress[]>([]);
  const [result, setResult] = useState<StudioResult | null>(null);
  const [error, setError] = useState("");
  const [refineInstruction, setRefineInstruction] = useState("");
  const [refining, setRefining] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [openRunId, setOpenRunId] = useState("");
  // The id of this run's row, handed back by the server's `saved` event. It is
  // what makes a refine or a hand edit overwrite this entry instead of leaving a
  // stale copy behind; it is "" whenever nothing was saved.
  const [savedRunId, setSavedRunId] = useState("");
  // Pending hand-edit write. Held in refs so a re-render cannot lose the handle
  // and leave a timer running past unmount.
  const patchTimer = useRef<number | undefined>(undefined);
  const pendingPatch = useRef<{ id: string; lyrics: string } | null>(null);

  // flushLyrics writes a pending hand edit immediately and forgets it. Called on
  // unmount, so an edit typed in the last few hundred milliseconds before
  // leaving Studio is saved rather than dropped: cancelling the timer alone
  // would silently discard exactly the words the user just typed. The request
  // outlives the component — fetch is not tied to the React tree.
  const flushLyrics = () => {
    window.clearTimeout(patchTimer.current);
    const p = pendingPatch.current;
    pendingPatch.current = null;
    if (p) patchStudioRun(p.id, { lyrics: p.lyrics }).catch(() => {});
  };

  // Held in a ref so the unmount cleanup below can stay a mount-only effect and
  // still flush the latest edit rather than one captured on first render.
  const flushRef = useRef(flushLyrics);
  flushRef.current = flushLyrics;
  useEffect(() => {
    return () => flushRef.current();
  }, []);

  // saveLyricsSoon debounces the write behind a hand edit, so a sentence typed
  // into the lyrics box is one request rather than one per keystroke. With no
  // saved run there is nothing to write to, and the edit is simply not persisted
  // — queueing it would mean guessing which row it belongs to.
  const saveLyricsSoon = (lyrics: string) => {
    window.clearTimeout(patchTimer.current);
    pendingPatch.current = null;
    if (!savedRunId) return;
    const id = savedRunId;
    pendingPatch.current = { id, lyrics };
    patchTimer.current = window.setTimeout(() => {
      pendingPatch.current = null;
      // Best effort: a failed background save must not interrupt the editing the
      // user is in the middle of.
      patchStudioRun(id, { lyrics }).catch(() => {});
    }, HAND_EDIT_DEBOUNCE_MS);
  };

  const busy = status === "loading" || refining;
  const stale =
    status === "done" &&
    reference.trim() !== generatedRef &&
    reference.trim() !== "";

  const generate = async () => {
    const ref = reference.trim();
    if (!ref || busy) return;
    setStatus("loading");
    // Seed an empty result rather than null: the cards render straight away as
    // placeholders and fill in as each turn lands, instead of the page sitting
    // blank behind a spinner until everything is done. generatedRef is set here
    // too, so the cover-art card keeps its identity as the parts arrive.
    setResult(EMPTY_RESULT);
    setGeneratedRef(ref);
    setSteps([]);
    setError("");
    setRefineInstruction("");
    // Drop the previous run's id here, or this generation's first refine would
    // overwrite the last run's saved entry instead of its own.
    setSavedRunId("");
    // Abandon any pending hand edit outright: it belongs to the run being
    // replaced, and flushing it later would write those words to whichever run
    // is current then.
    window.clearTimeout(patchTimer.current);
    pendingPatch.current = null;
    try {
      const res = await studioGenerate(
        ref,
        (p) => setSteps((s) => [...s, p]),
        (partial) =>
          setResult((prev) => mergePartial(prev ?? EMPTY_RESULT, partial)),
        (id) => setSavedRunId(id),
      );
      // The closing result is authoritative — it overwrites whatever the
      // partials built up, so a merge slip can't survive into the final state.
      setResult(res);
      setStatus("done");
    } catch (e) {
      setError((e as Error).message || "Generation failed");
      // Whatever finished before the failure stays on screen — those parts are
      // real and usable. A run that produced nothing leaves nothing behind, so
      // the error stands alone instead of over a row of empty boxes.
      setResult((prev) => (prev && hasContent(prev) ? prev : null));
      setStatus("error");
    }
  };

  const refine = async () => {
    const instr = refineInstruction.trim();
    if (!instr || !result || busy) return;
    setRefining(true);
    setSteps([]);
    setError("");
    // A rewrite lands in a moment and replaces these lyrics wholesale; a pending
    // hand-edit save would write the words being replaced.
    window.clearTimeout(patchTimer.current);
    pendingPatch.current = null;
    try {
      const lyrics = await studioRefine(
        generatedRef,
        result.lyrics,
        instr,
        (p) => setSteps((s) => [...s, p]),
        savedRunId,
      );
      setResult({ ...result, lyrics });
      setRefineInstruction("");
    } catch (e) {
      setError((e as Error).message || "Refinement failed");
    } finally {
      setRefining(false);
    }
  };

  const current = steps.length > 0 ? steps[steps.length - 1] : null;

  // A card is "pending" only while the turn that fills it is still running: an
  // empty box the user emptied by hand (or an empty field on a finished run) is
  // theirs to keep, not a placeholder. The lyrics slot is also pending during a
  // refine, since those exact lines are being replaced — the other cards stay up.
  const generating = status === "loading";
  const lyricsPending = generating ? !result?.lyrics : refining;
  const stylePending = generating && !result?.stylePrompt;
  const identityPending =
    generating &&
    !result?.bands.length &&
    !result?.titles.length &&
    !result?.albums.length &&
    !result?.genres.length;
  const coverPending = generating && !result?.coverArtPrompt;
  // After a failed run the parts that never arrived are dropped rather than
  // drawn as empty boxes; on a finished run an empty field is the user's own
  // edit and keeps its card.
  const keepEmptySlots = status !== "error";

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ ...t.display, margin: "0 0 0.25rem" }}>Studio</h1>
      <p style={{ color: "var(--color-muted)", margin: "0 0 var(--space-5)" }}>
        {mode === "fanart"
          ? "Generate cover fanart for a genre."
          : mode === "coverart"
            ? "Create or replace cover art for an album."
            : "Turn a song into a Suno prompt."}
      </p>

      {/* Mode switch appears only when the image generator is configured. Song →
          Suno leads: it is the Studio's primary mode and its default, so it sits
          where the eye lands first rather than at the end of the row. */}
      {imageGenEnabled && (
        <div
          role="tablist"
          aria-label="Studio mode"
          style={{
            display: "inline-flex",
            padding: 3,
            gap: 3,
            border: "1px solid var(--color-border)",
            borderRadius: 999,
            background: "var(--color-panel)",
            marginBottom: "1.6rem",
          }}
        >
          {(
            [
              ["suno", "Song → Suno"],
              ["fanart", "Genre → Fanart"],
              ["coverart", "Album Cover"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              style={{
                border: "none",
                background:
                  mode === m ? "var(--color-accent-fill)" : "transparent",
                color: mode === m ? "var(--color-ink)" : "var(--color-muted)",
                fontFamily: "var(--font-sans)",
                fontSize: "var(--text-ui)",
                padding: "6px 14px",
                borderRadius: 999,
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {mode === "fanart" ? (
        <GenreFanartMode
          chatEnabled={chatEnabled}
          imageModels={imageModels}
          defaultImageModel={defaultImageModel}
          initialGenreId={initialGenreId}
        />
      ) : mode === "coverart" ? (
        <AlbumCoverMode
          chatEnabled={chatEnabled}
          imageModels={imageModels}
          defaultImageModel={defaultImageModel}
        />
      ) : (
        <>
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
            <Button
              type="submit"
              busy={status === "loading"}
              disabled={busy || reference.trim() === ""}
              style={{ whiteSpace: "nowrap" }}
            >
              {status === "loading" ? "Working" : "Generate"}
            </Button>
            {/* A1: an icon, no label and no count — the run total lives in the
                drawer header, where it is information rather than a nag. */}
            {historyEnabled && (
              <button
                type="button"
                aria-label="History"
                title="History"
                onClick={() => setShowHistory(true)}
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 40,
                  height: 40,
                  flexShrink: 0,
                  background: "none",
                  border: "1px solid var(--color-border)",
                  borderRadius: "var(--radius-ui)",
                  color: "var(--color-muted)",
                  cursor: "pointer",
                }}
              >
                <Icon name="history" size="18px" />
              </button>
            )}
          </form>
          <p
            style={{
              color: "var(--color-muted)",
              fontSize: "var(--text-label)",
              margin: "0.5rem 0 0",
            }}
          >
            Studio researches the song on the web, captures its style, writes
            fresh original lyrics on the same theme (never the original words),
            suggests band, title and album names, and sketches cover art.{" "}
            {/* The closing sentence has to follow the truth: with a library
                configured a finished run is kept and can be reopened, so the
                old "shown once and not stored" would be a lie. Without one,
                nothing is stored and the original sentence still holds. */}
            {historyEnabled
              ? "Runs are kept so you can look them up later. Only the run on screen can be refined."
              : "Results are shown once and not stored."}
          </p>
          {stale && (
            <p
              style={{
                color: "var(--color-accent-strong)",
                fontSize: "var(--text-label)",
                margin: "0.5rem 0 0",
              }}
            >
              Press Enter to regenerate for “{reference.trim()}”.
            </p>
          )}

          {/* Live research progress */}
          {busy && (
            <div style={{ marginTop: "var(--space-6)" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-2)",
                  color: "var(--color-muted)",
                  ...t.body,
                }}
              >
                <Spinner size="18px" />
                <span>{current ? current.detail : "Starting research"}</span>
              </div>
              {steps.length > 1 && (
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: "var(--space-3) 0 0",
                    color: "var(--color-muted)",
                    fontSize: "var(--text-label)",
                  }}
                >
                  {steps.slice(0, -1).map((s, i) => (
                    <li
                      key={i}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "0.15rem 0",
                      }}
                    >
                      <Icon name="check" size="13px" /> {s.detail}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {error && !busy && (
            <p
              role="alert"
              style={{
                color: "var(--color-accent-strong)",
                marginTop: "1.4rem",
              }}
            >
              {error}
            </p>
          )}

          {/* Results. Rendered as soon as generation starts: each card shows its
              content the moment its turn lands, and a placeholder until then. */}
          {result && (
            <div style={{ marginTop: "2rem" }}>
              {lyricsPending ? (
                <PendingCard
                  name="Lyrics"
                  note={
                    refining
                      ? "→ Suno “Lyrics” · being rewritten"
                      : "→ Suno “Lyrics” · being written"
                  }
                  lines={8}
                  tall
                />
              ) : (
                (result.lyrics || keepEmptySlots) && (
                  <ResultCard
                    name="Lyrics"
                    note="→ Suno “Lyrics” · original, editable"
                    text={result.lyrics}
                    onChange={(value) => {
                      setResult({ ...result, lyrics: value });
                      saveLyricsSoon(value);
                    }}
                  />
                )
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  refine();
                }}
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  margin: "-0.7rem 0 1.6rem",
                }}
              >
                <input
                  type="text"
                  value={refineInstruction}
                  onChange={(e) => setRefineInstruction(e.target.value)}
                  placeholder="Refine the lyrics — e.g. “do not say lullaby”, “darker chorus”"
                  aria-label="Refine lyrics instruction"
                  className={controlClass}
                  disabled={busy || !result.lyrics}
                  style={{ flex: 1 }}
                />
                <Button
                  type="submit"
                  variant="secondary"
                  busy={refining}
                  disabled={
                    busy || !result.lyrics || refineInstruction.trim() === ""
                  }
                  style={{ whiteSpace: "nowrap" }}
                >
                  Refine
                </Button>
              </form>
              {/* The overwrite happens here, so the rule is stated here — nobody
                  should have to open history to learn it. */}
              {historyEnabled && savedRunId !== "" && (
                <p
                  style={{
                    ...t.label,
                    margin: "-1.2rem 0 1.6rem",
                  }}
                >
                  Refining rewrites these lyrics and updates this run’s saved
                  copy. The previous wording is not kept.
                </p>
              )}

              {stylePending ? (
                <PendingCard
                  name="Style prompt"
                  note="→ Suno “Style” · researching"
                  lines={2}
                />
              ) : (
                (result.stylePrompt || keepEmptySlots) && (
                  <ResultCard
                    name="Style prompt"
                    note="→ Suno “Style”"
                    count={`${result.stylePrompt.length} / ${STYLE_LIMIT}`}
                    text={result.stylePrompt}
                    monospace
                  />
                )
              )}

              {identityPending ? (
                <PendingCard name="Identity" note="→ naming it" lines={3} />
              ) : (
                <IdentityCard
                  bands={result.bands}
                  titles={result.titles}
                  albums={result.albums}
                  genres={result.genres}
                  namingPending={generating && !result.bands.length}
                />
              )}

              {coverPending ? (
                <PendingCard
                  name="Cover-art prompt"
                  note="→ image generator · picturing it"
                  lines={2}
                />
              ) : (
                (result.coverArtPrompt || keepEmptySlots) && (
                  <ResultCard
                    name="Cover-art prompt"
                    note="→ image generator · editable"
                    text={result.coverArtPrompt}
                    onChange={(value) =>
                      setResult({ ...result, coverArtPrompt: value })
                    }
                  />
                )
              )}
              {/* Gated exactly like the prompt card above it: a run that died
                  before the cover-art turn has no prompt to generate from, so the
                  generator is dropped rather than left under the error with a
                  permanently disabled button. */}
              {imageGenEnabled &&
                !coverPending &&
                (result.coverArtPrompt || keepEmptySlots) && (
                  <CoverArtCard
                    key={generatedRef}
                    prompt={result.coverArtPrompt}
                    models={imageModels}
                    defaultModel={defaultImageModel}
                    // Attach the image to this run's saved row so reopening it
                    // later shows the cover. With no saved run the PATCH is
                    // skipped rather than queued — there is no row to attach to,
                    // and guessing one later would attach it to the wrong run.
                    onGenerated={(coverArtId) => {
                      if (!savedRunId) return;
                      patchStudioRun(savedRunId, { coverArtId }).catch(
                        () => {},
                      );
                    }}
                  />
                )}
            </div>
          )}
        </>
      )}

      {/* Both surfaces are unmounted when closed, so Escape unwinds them one at a
          time (the run sheet opens last and therefore closes first). The drawer
          is never told about a run it cannot see: currentRunId is only set once
          the server has confirmed this run's row. */}
      {showHistory && (
        <StudioHistoryDrawer
          onClose={() => setShowHistory(false)}
          onOpen={(id) => setOpenRunId(id)}
          currentRunId={savedRunId || undefined}
        />
      )}
      {openRunId !== "" && (
        <StudioHistoryRun
          id={openRunId}
          onClose={() => setOpenRunId("")}
          onRegenerate={(ref) => {
            // Hand the reference back to the form and get out of the way; the
            // user presses Generate, which starts a new entry. Nothing about the
            // saved run is touched.
            setReference(ref);
            setOpenRunId("");
            setShowHistory(false);
          }}
        />
      )}
    </div>
  );
}
