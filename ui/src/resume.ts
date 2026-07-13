// Resume-state persistence: remember the current track + position so a reload
// can restore playback (without surprise autoplay). Mirrors favorites.ts.

export type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

// reported carries whether this listen already counted toward Top-Ten, so a
// resumed play can never re-count it (optional for backward compatibility with
// older saved state). savedAt (epoch ms) records when the state was last
// written, so restore can resume the position only after a recent close and
// otherwise start the track fresh (both optional for older saved state).
export type ResumeState = { songId: string; positionMs: number; reported?: boolean; savedAt?: number };

const KEY = "music.resume";

// RESUME_WINDOW_MS bounds how long after the last activity a reopened UI still
// resumes the saved position. Within it (accidental close, short break) playback
// picks up where it left off; past it (hours later, next day) the song loads at
// 0:00. A single tweakable constant.
export const RESUME_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// isResumeFresh reports whether the saved state is recent enough to resume its
// position. Missing savedAt (older saved state) counts as stale → start at 0.
export function isResumeFresh(state: ResumeState, now: number, windowMs = RESUME_WINDOW_MS): boolean {
  return typeof state.savedAt === "number" && now - state.savedAt <= windowMs;
}

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
      if (typeof parsed.savedAt === "number" && Number.isFinite(parsed.savedAt)) out.savedAt = parsed.savedAt;
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
