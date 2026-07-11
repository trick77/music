import type { Song } from "./api";

// SyncingBadge shows a small pulsing accent dot + "Syncing" while a song's karaoke
// alignment is generating, so the state is visible everywhere the song appears in a
// list. Renders nothing for any other status (Phase 3).
export function SyncingBadge({ status }: { status: Song["alignmentStatus"] }) {
  if (status !== "generating") return null;
  return (
    <span
      title="Syncing karaoke…"
      aria-label="Syncing karaoke"
      style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--color-accent-strong)", fontSize: "var(--text-label)", flexShrink: 0 }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", animation: "kv-pulse 1.2s ease-in-out infinite" }} />
      Syncing
    </span>
  );
}
