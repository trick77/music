// ── Karaoke alignment (Phase 3) ─────────────────────────────────────────────

export type AlignedWord = { w: string; start: number; end: number; conf: number };
export type AlignedLine = { text: string; start: number; end: number; words: AlignedWord[] };
export type AlignmentData = { status: string; engine?: string; lines?: AlignedLine[] };

// getAlign polls a song's karaoke alignment. Returns null when none was ever
// requested (404), so callers can distinguish "never synced" from a real error.
export async function getAlign(id: string): Promise<AlignmentData | null> {
  const r = await fetch(`/api/songs/${id}/align`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`align status failed (${r.status})`);
  return r.json();
}

// postAlign requests karaoke generation. 202 = started. 400/404/409 are quiet
// non-errors (no lyrics / disabled / already running) — nothing for the UI to do.
export async function postAlign(id: string): Promise<void> {
  const r = await fetch(`/api/songs/${id}/align`, { method: "POST" });
  if (r.status === 202 || r.status === 400 || r.status === 404 || r.status === 409) return;
  if (!r.ok) throw new Error(`align request failed (${r.status})`);
}
