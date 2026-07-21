import { useState } from "react";
import { imageModelOptions } from "./api";
import { Button, controlClass, fieldLabel } from "./ui";

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
