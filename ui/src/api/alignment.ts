// ── Karaoke alignment (Phase 3) ─────────────────────────────────────────────

export type AlignedWord = {
  w: string;
  start: number;
  end: number;
  conf: number;
};
export type AlignedLine = {
  text: string;
  start: number;
  end: number;
  words: AlignedWord[];
};
export type AlignmentData = {
  status: string;
  engine?: string;
  lines?: AlignedLine[];
};

// Alignment is immutable once ready but is re-read every time the karaoke view
// opens, so a per-tab memo makes reopening a track instant: the sweep paints on
// the first frame instead of one round-trip later. Deliberately a bare module
// Map — writing to it does not re-render, so components still hold the fetched
// value in state; this is only the warm-start seed read during render.
const cache = new Map<string, AlignmentData | null>();

// peekAlign returns what we already know about a song, synchronously, so it can
// be read while rendering. undefined means "never asked"; null means "asked, and
// this song has no alignment" — the caller needs to tell those apart.
export function peekAlign(id: string): AlignmentData | null | undefined {
  return cache.get(id);
}

// invalidateAlign forgets a song's memoized timing, so the next read re-fetches
// it from the server. Needed because alignment can be re-run behind the client's
// back: saving changed lyrics in the tag editor enqueues a re-sync server-side,
// and the song echoed back by that save still carries the pre-enqueue status —
// nothing in the response tells us the old timing is now stale.
export function invalidateAlign(id: string): void {
  cache.delete(id);
}

// getAlign polls a song's karaoke alignment. Returns null when none was ever
// requested (404), so callers can distinguish "never synced" from a real error.
export async function getAlign(id: string): Promise<AlignmentData | null> {
  const r = await fetch(`/api/songs/${id}/align`);
  // The 404 is memoized too, so a never-synced song stops re-asking on every open.
  if (r.status === 404) {
    cache.set(id, null);
    return null;
  }
  if (!r.ok) throw new Error(`align status failed (${r.status})`);
  const a: AlignmentData = await r.json();
  cache.set(id, a);
  return a;
}

// postAlign requests karaoke generation. 202 = started. 400/404/409 are quiet
// non-errors (no lyrics / disabled / already running) — nothing for the UI to do.
export async function postAlign(id: string): Promise<void> {
  // Requesting a (re-)sync drops any memoized timing immediately: those lines are
  // about to be replaced, and a stale "ready" entry would otherwise seed the
  // karaoke view with the previous take's words on the next open. Done here
  // rather than at each caller — there are two mutation sites. We forget rather
  // than write a "generating" placeholder because the request may still be
  // refused (no lyrics, alignment disabled); leaving the slot empty lets the
  // server's own status win on the next read instead of inventing one here.
  cache.delete(id);
  const r = await fetch(`/api/songs/${id}/align`, { method: "POST" });
  if (
    r.status === 202 ||
    r.status === 400 ||
    r.status === 404 ||
    r.status === 409
  )
    return;
  if (!r.ok) throw new Error(`align request failed (${r.status})`);
}
