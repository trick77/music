// Resume-state persistence: remember the current track + position so a reload
// can restore playback (without surprise autoplay). Mirrors favorites.ts.

export type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// reported carries whether this listen already counted toward Top-Ten, so a
// resumed play can never re-count it (optional for backward compatibility with
// older saved state).
export type ResumeState = { songId: string; positionMs: number; reported?: boolean };

const KEY = "music.resume";

export function saveResume(store: Store, state: ResumeState): void {
  try {
    store.setItem(KEY, JSON.stringify(state));
  } catch {
    // storage full / unavailable — resume is best-effort
  }
}

export function loadResume(store: Store): ResumeState | null {
  try {
    const raw = store.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.songId === "string" &&
      typeof parsed.positionMs === "number" &&
      Number.isFinite(parsed.positionMs)
    ) {
      const out: ResumeState = { songId: parsed.songId, positionMs: parsed.positionMs };
      if (typeof parsed.reported === "boolean") out.reported = parsed.reported;
      return out;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearResume(store: Store): void {
  try {
    store.removeItem(KEY);
  } catch {
    // ignore
  }
}
