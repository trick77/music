import { useState } from "react";
import { imageModelOptions } from "./api";

// controlStyle is the shared look for Studio inputs (select / textarea / text).
// fontSize is 1rem so inputs match their field labels, which in turn match the
// panel's "Generate cover fanart for a genre" caption (body default, 16px).
export const controlStyle: React.CSSProperties = {
  background: "var(--color-panel)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--radius-ui)",
  padding: "0.5rem 0.6rem",
  color: "var(--color-ink)",
  fontFamily: "var(--font-sans)",
  fontSize: "1rem",
  outline: "none",
};

// fieldLabelStyle sizes a field label to match the panel caption (1rem).
export const fieldLabelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "1rem",
  color: "var(--color-muted)",
  marginBottom: 7,
};

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
    <div style={{ marginBottom: "1.1rem" }}>
      <label htmlFor="studio-model" style={fieldLabelStyle}>Model</label>
      <select
        id="studio-model"
        aria-label="Image model"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{ ...controlStyle, minWidth: 260 }}
      >
        {options.length === 0 && <option value="">Default</option>}
        {options.map((m) => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>
    </div>
  );
}

// RefineRow is the shared "type an instruction → LLM rewrites the prompt" control.
// It owns only its input text; the caller performs the refine call and updates the
// prompt. Rendered under a prompt textarea.
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
    <form onSubmit={submit} style={{ display: "flex", gap: "0.5rem", margin: "0 0 1.1rem" }}>
      <input
        type="text"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="Refine the prompt — e.g. “make it darker”, “add neon”"
        aria-label="Refine prompt instruction"
        disabled={busy || disabled}
        style={{ ...controlStyle, flex: 1 }}
      />
      <button
        type="submit"
        disabled={busy || disabled || instruction.trim() === ""}
        style={{
          fontSize: "1rem", color: "var(--color-ink)", fontWeight: 500,
          background: "var(--color-active)", border: "1px solid var(--color-border)",
          borderRadius: 8, padding: "0.5rem 0.9rem",
          cursor: busy || disabled || instruction.trim() === "" ? "default" : "pointer",
          opacity: busy || disabled || instruction.trim() === "" ? 0.6 : 1, whiteSpace: "nowrap",
        }}
      >
        {busy ? "Refining…" : "Refine"}
      </button>
    </form>
  );
}
