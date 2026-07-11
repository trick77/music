import { useEffect, useRef, type ReactNode } from "react";
import { Spinner, buttonStyle } from "./ui";

// ConfirmDialog is a reusable modal confirmation on the elevated surface, over the
// loom-style blurred backdrop. Escape or the backdrop cancels; the confirm button
// is focused on mount. Destructive confirms use the danger fill.
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
      style={{ position: "fixed", inset: 0, zIndex: 100, display: "grid", placeItems: "center", background: "rgba(0,0,0,0.5)", backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)", padding: "0 1rem" }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 460, borderRadius: 14, border: "1px solid var(--color-elevated-border)", background: "var(--color-elevated)", padding: "var(--space-5)", boxShadow: "0 24px 60px rgba(0,0,0,0.5)", boxSizing: "border-box" }}
      >
        <h2 style={{ margin: 0, fontFamily: "var(--font-serif)", fontSize: "var(--text-title)", fontWeight: 500, color: "var(--color-elevated-ink)" }}>{title}</h2>
        <div style={{ marginTop: "0.75rem", fontSize: "var(--text-body)", lineHeight: 1.6, color: "var(--color-elevated-ink)" }}>{message}</div>
        {error !== "" && <p style={{ margin: "0.75rem 0 0", fontSize: "var(--text-label)", color: "var(--color-accent-strong)" }}>{error}</p>}
        <div style={{ marginTop: "var(--space-5)", display: "flex", justifyContent: "flex-end", gap: "var(--space-2)" }}>
          <button type="button" onClick={onCancel} style={buttonStyle("secondary")}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            disabled={busy}
            onClick={onConfirm}
            style={{ ...buttonStyle(danger ? "danger" : "primary"), ...(busy ? { opacity: 0.6, cursor: "default" } : null) }}
          >
            {busy && <Spinner />}{confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
