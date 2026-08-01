import { useState } from "react";
import { imageModelOptions } from "./api";
import { copyText } from "./share";
import { genreLabel } from "./titleCase";
import { Button, controlClass, fieldLabel, t } from "./ui";

// Studio controls use the shared design-system primitives (docs/design-system.md):
// the 40px `ui-control` and the 13px field label. Re-exported here so existing Studio
// call sites keep importing controlStyle/fieldLabelStyle from this module.
export { controlStyle, fieldLabel as fieldLabelStyle } from "./ui";

// ModelPicker is the shared image-model selector. Options come from the session
// (imageModels); the caller preselects the env default (defaultImageModel).
export function ModelPicker({
  models,
  value,
  onChange,
  disabled,
}: {
  models: string[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const options = imageModelOptions(models);
  return (
    <div style={{ marginBottom: "var(--space-5)" }}>
      <label htmlFor="studio-model" style={fieldLabel}>
        Model
      </label>
      <select
        id="studio-model"
        aria-label="Image model"
        className={controlClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{ maxWidth: 320 }}
      >
        {options.length === 0 && <option value="">Default</option>}
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// RefineRow is the shared "type an instruction → LLM rewrites the prompt" control.
// It owns only its input text; the caller performs the refine call and updates the
// prompt. While busy the input is locked and the button spins (no ellipsis label).
export function RefineRow({
  onRefine,
  busy,
  disabled,
}: {
  onRefine: (instruction: string) => Promise<void>;
  busy: boolean;
  disabled: boolean;
}) {
  const [instruction, setInstruction] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const instr = instruction.trim();
    if (!instr || busy || disabled) return;
    await onRefine(instr);
    setInstruction("");
  };
  return (
    <form
      onSubmit={submit}
      style={{
        display: "flex",
        gap: "var(--space-2)",
        margin: "0 0 var(--space-5)",
      }}
    >
      <input
        type="text"
        className={controlClass}
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="Refine the prompt — e.g. “make it darker”, “add neon”"
        aria-label="Refine prompt instruction"
        disabled={busy || disabled}
        style={{ flex: 1 }}
      />
      <Button
        type="submit"
        variant="secondary"
        busy={busy}
        disabled={disabled || instruction.trim() === ""}
        style={{ whiteSpace: "nowrap" }}
      >
        Refine
      </Button>
    </form>
  );
}

// --- Result cards ---------------------------------------------------------
// These four render a finished Studio run. They live here rather than in
// StudioPage because a saved run in the history sheet shows exactly the same
// cards, minus everything that could change it — ResultCard without onChange is
// literally what makes a box read-only, so no read-only variant is needed.

// CopyButton copies text and briefly confirms, mirroring the app's share flow.
function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  label?: string;
}) {
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
export function ResultCard({
  name,
  note,
  count,
  text,
  monospace = false,
  onChange,
}: {
  name: string;
  note?: string;
  count?: string;
  text: string;
  monospace?: boolean;
  onChange?: (value: string) => void;
}) {
  const boxStyle = {
    background: "color-mix(in srgb, var(--color-bg) 70%, #000)",
    border: "1px solid var(--color-border)",
    borderRadius: "var(--radius-ui)",
    padding: "12px 14px",
    fontFamily: monospace
      ? "ui-monospace, SFMono-Regular, Menlo, monospace"
      : "var(--font-sans)",
    fontSize: monospace ? "var(--text-label)" : "var(--text-ui)",
    lineHeight: monospace ? 1.55 : 1.7,
    color: "color-mix(in srgb, var(--color-ink) 88%, transparent)",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  };
  return (
    <div style={{ marginBottom: "1.4rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          marginBottom: "0.4rem",
          gap: "0.75rem",
        }}
      >
        <span style={{ fontWeight: 600, fontSize: "var(--text-ui)" }}>
          {name}
          {note && (
            <span
              style={{
                fontWeight: 400,
                color: "var(--color-muted)",
                fontSize: "var(--text-label)",
                marginLeft: "0.4rem",
              }}
            >
              {note}
            </span>
          )}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {count && (
            <span
              style={{
                color: "var(--color-muted)",
                fontSize: "var(--text-label)",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {count}
            </span>
          )}
          <CopyButton text={text} />
        </span>
      </div>
      {onChange ? (
        // fontSize overrides boxStyle's: an editable field must follow
        // --text-input, or iOS zooms the page in the moment it takes focus (see
        // index.css). It can't move into boxStyle — that object is also spread
        // onto the read-only box below, which is display text and belongs on the
        // type scale. A monospace card that ever became editable would need the
        // same treatment.
        <textarea
          value={text}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${name} (editable)`}
          spellCheck={false}
          style={{
            ...boxStyle,
            fontSize: "var(--text-input)",
            width: "100%",
            boxSizing: "border-box",
            minHeight: 260,
            resize: "vertical",
            outline: "none",
          }}
        />
      ) : (
        <div style={boxStyle}>{text}</div>
      )}
    </div>
  );
}

// IdeaColumn is one labelled list of name ideas, each with its own copy button.
export function IdeaColumn({
  label,
  options,
}: {
  label: string;
  options: string[];
}) {
  return (
    <div>
      <div style={{ ...t.label, marginBottom: "0.5rem" }}>{label}</div>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: "0.35rem",
        }}
      >
        {options.map((text) => (
          <li
            key={text}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.6rem",
              background: "color-mix(in srgb, var(--color-bg) 70%, #000)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-ui)",
              padding: "6px 6px 6px 12px",
            }}
          >
            <span style={{ fontSize: "var(--text-ui)" }}>{text}</span>
            <CopyButton text={text} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// IdentityCard groups everything that names and classifies the track: up to
// three band-name, song-title and album-name ideas (each varying from an
// obvious pick to a more oblique one, with a copy button), plus the model-picked
// genres as a footer row. Columns wrap responsively (band first, then title,
// then album). Any empty list is omitted; the whole card is hidden when the
// model returned nothing to name or classify.
// PendingColumn is an idea column whose turn has not answered yet: the label is
// already correct, the rows are placeholders. It keeps the card from opening as
// a gap between the description and the genre row.
function PendingColumn({ label }: { label: string }) {
  return (
    <div aria-busy="true">
      <div style={{ ...t.label, marginBottom: "0.5rem" }}>{label}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              display: "block",
              height: 34,
              borderRadius: "var(--radius-ui)",
              background: "color-mix(in srgb, var(--color-bg) 70%, #000)",
              border: "1px solid var(--color-border)",
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function IdentityCard({
  bands,
  titles,
  albums,
  genres,
  namingPending = false,
}: {
  bands: string[];
  titles: string[];
  albums: string[];
  genres: string[];
  // The genres land a turn before the names do, so the card can already be up
  // with its name columns still being written.
  namingPending?: boolean;
}) {
  if (!bands?.length && !titles?.length && !albums?.length && !genres?.length)
    return null;
  return (
    <div
      style={{
        marginBottom: "1.6rem",
        padding: "16px 16px 4px",
        background: "color-mix(in srgb, var(--color-panel) 60%, transparent)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-ui)",
      }}
    >
      <div
        style={{
          fontWeight: 600,
          fontSize: "var(--text-ui)",
          marginBottom: "0.25rem",
        }}
      >
        Identity
        <span
          style={{
            fontWeight: 400,
            color: "var(--color-muted)",
            fontSize: "var(--text-label)",
            marginLeft: "0.4rem",
          }}
        >
          → name it &amp; classify it · pick one, copy
        </span>
      </div>
      <p
        style={{
          color: "var(--color-muted)",
          fontSize: "var(--text-label)",
          margin: "0 0 0.9rem",
        }}
      >
        Band, title and album ideas run from the obvious pick to a more oblique
        one — never a lyric line verbatim.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "1.2rem 1.6rem",
        }}
      >
        {bands?.length > 0 ? (
          <IdeaColumn label="Band name" options={bands} />
        ) : (
          namingPending && <PendingColumn label="Band name" />
        )}
        {titles?.length > 0 ? (
          <IdeaColumn label="Song title" options={titles} />
        ) : (
          namingPending && <PendingColumn label="Song title" />
        )}
        {albums?.length > 0 ? (
          <IdeaColumn label="Album name" options={albums} />
        ) : (
          namingPending && <PendingColumn label="Album name" />
        )}
      </div>
      {genres?.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "0.4rem",
            marginTop: "0.9rem",
            paddingTop: "0.9rem",
            borderTop: "1px solid var(--color-border)",
          }}
        >
          <span style={{ ...t.label, marginRight: "0.15rem" }}>Genres</span>
          {genres.map((g) => (
            <span
              key={g}
              style={{
                background: "var(--color-active)",
                borderRadius: 999,
                padding: "3px 10px",
                fontSize: "var(--text-label)",
                color: "var(--color-ink)",
              }}
            >
              {genreLabel(g)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
