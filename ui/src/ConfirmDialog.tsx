import { useEffect, useRef, useState, type ReactNode } from "react";

// ConfirmDialog is a reusable modal confirmation, mirroring loom's delete modal
// (hardcoded loom hexes, since the app already mirrors loom's Menu colors and
// uses inline styles rather than Tailwind). Escape or the backdrop cancels; the
// confirm button is focused on mount.
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  error = "",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [cancelHot, setCancelHot] = useState(false);
  const [confirmHot, setConfirmHot] = useState(false);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  return (
    <div
      onClick={() => { if (!busy) onCancel(); }}
      style={{ position: "fixed", inset: 0, zIndex: 100, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.5)", backdropFilter: "blur(2px)", padding: "0 1rem" }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 460, borderRadius: 10, border: "1px solid #55524b", background: "#383834", padding: "1.5rem", boxShadow: "0 24px 60px rgba(0,0,0,0.45)", boxSizing: "border-box" }}
      >
        <h2 style={{ margin: 0, fontFamily: "var(--font-sans)", fontSize: 22, fontWeight: 600, color: "#f4f0e8" }}>{title}</h2>
        <div style={{ marginTop: "0.75rem", fontSize: "0.875rem", lineHeight: 1.7, color: "#d5d2c9" }}>{message}</div>
        {error !== "" && <p style={{ margin: "0.75rem 0 0", fontSize: "0.875rem", color: "#d98278" }}>{error}</p>}
        <div style={{ marginTop: "1.25rem", display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <button
            type="button"
            onClick={onCancel}
            onMouseEnter={() => setCancelHot(true)}
            onMouseLeave={() => setCancelHot(false)}
            style={{ height: 32, borderRadius: 6, border: "none", background: cancelHot ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.10)", padding: "0 0.875rem", fontSize: "0.875rem", fontWeight: 500, color: "#f3f0e8", cursor: "pointer" }}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            disabled={busy}
            onClick={onConfirm}
            onMouseEnter={() => setConfirmHot(true)}
            onMouseLeave={() => setConfirmHot(false)}
            style={{
              height: 32,
              borderRadius: 6,
              border: "none",
              background: danger ? (confirmHot ? "#e34948" : "#d03b3b") : "var(--color-accent-strong)",
              padding: "0 0.875rem",
              fontSize: "0.875rem",
              fontWeight: 500,
              color: danger ? "#fff" : "var(--color-ink)",
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.5 : 1,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
