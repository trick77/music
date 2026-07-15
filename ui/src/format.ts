export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Placeholder for a value we don't have, so columns still line up. */
const EMPTY = "—";

// Audio info. The server sends 0 for "unknown" — a row the backfill hasn't reached,
// or a file that wouldn't decode — so every one of these guards zero rather than
// rendering a confident "0 Hz".

/**
 * "44.1 kHz" — the fractional part only shows when there is one. Two decimals,
 * trimmed: one would round 22050 Hz to a wrong-looking "22.1 kHz".
 */
export function formatSampleRate(hz: number): string {
  if (!Number.isFinite(hz) || hz <= 0) return EMPTY;
  return `${parseFloat((hz / 1000).toFixed(2))} kHz`;
}

/** Channel count as a layout name. The server collapses joint/dual stereo to 2. */
export function formatChannels(channels: number): string {
  if (channels === 1) return "Mono";
  if (channels === 2) return "Stereo";
  return EMPTY;
}

/** "128 kbps" — an average across the file, so it's honest for VBR too. */
export function formatBitrate(kbps: number): string {
  if (!Number.isFinite(kbps) || kbps <= 0) return EMPTY;
  return `${Math.round(kbps)} kbps`;
}

/** formatFileSize renders a byte count for the tag editor's Info tab. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return EMPTY;
  const kb = bytes / 1024;
  // Test the ROUNDED value: 1048570 B is 1023.99 KB, which would otherwise print
  // as "1024 KB" rather than rolling over to "1.0 MB".
  if (Math.round(kb) < 1024) return `${Math.round(kb)} KB`;
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

/** Midnight local on the day containing d — the anchor for calendar-day maths. */
function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * formatLastPlayed renders when a song was last played, relative while that's the
 * more useful reading and absolute once it isn't. `now` is injectable for tests.
 *
 * Days are CALENDAR days in the viewer's zone, not elapsed 24h windows: "Yesterday"
 * is a claim about the calendar, so a play at 22:00 last night must not read "Today"
 * merely because it was under 24 hours ago. Rounding absorbs DST's 23/25-hour days.
 */
export function formatLastPlayed(lastPlayedAt: string, now: Date = new Date()): string {
  const d = parseSqlite(lastPlayedAt);
  if (!d) return "Never"; // the server sends "" for a song nobody has played
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(d)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return dayMonthYear.format(d);
}
