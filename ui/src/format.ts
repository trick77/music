export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Placeholder for a value we don't have, so columns still line up. */
const EMPTY = "—";

/** formatFileSize renders a byte count for the tag editor's Info tab. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return EMPTY;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  // One decimal is useful at track sizes (8.4 MB); past 100 MB it's just noise.
  return mb < 100 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

/**
 * parseSqlite reads a SQLite `datetime('now')` string ("2026-03-12 09:15:00").
 *
 * The value is UTC but carries no zone marker, and Date's parser reads that exact
 * shape as LOCAL time — silently shifting it by the viewer's offset, which near
 * midnight moves the date by a whole day. So we normalise to ISO and pin the Z on
 * ourselves rather than letting the engine guess.
 */
function parseSqlite(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const dayMonthYear = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
});

/** formatDateAdded renders a song's upload date — "12 Mar 2026". */
export function formatDateAdded(createdAt: string): string {
  const d = parseSqlite(createdAt);
  return d ? dayMonthYear.format(d) : EMPTY;
}

const DAY_MS = 86_400_000;

/**
 * formatLastPlayed renders when a song was last played, relative while that's the
 * more useful reading and absolute once it isn't. `now` is injectable for tests.
 */
export function formatLastPlayed(lastPlayedAt: string, now: Date = new Date()): string {
  const d = parseSqlite(lastPlayedAt);
  if (!d) return "Never"; // the server sends "" for a song nobody has played
  const days = Math.floor((now.getTime() - d.getTime()) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return dayMonthYear.format(d);
}
