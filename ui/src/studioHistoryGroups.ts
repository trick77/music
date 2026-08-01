import type { StudioRun } from "./api";

// Date and label helpers for the Studio history drawer. They live outside the
// component so the bucketing rules can be tested without rendering anything.

// parseRunDate turns a stored timestamp into a Date. SQLite's datetime('now')
// writes "2026-08-01 10:00:00" — a space instead of a T, and no zone even though
// the value is UTC. Safari rejects that shape outright, so the column value is
// normalised here and never handed to new Date() raw. An unparseable value falls
// back to the epoch rather than an Invalid Date, so a single bad row sorts to
// the bottom instead of poisoning every comparison it touches.
export function parseRunDate(s: string): Date {
  const d = new Date(`${(s || "").replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

// formatRunDate is the long form shown on an opened run: local date and time, no
// seconds. The drawer rows use the group headers instead.
export function formatRunDate(s: string): string {
  return parseRunDate(s).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export type RunGroup = { label: string; runs: StudioRun[] };

// startOfLocalDay is the boundary "Today" is measured from: the calendar day in
// the viewer's zone, not a rolling 24 hours. A run from 22:30 last night is
// yesterday's, however recent it feels.
function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// groupRuns buckets runs into Today / This week / Earlier, keeping the server's
// newest-first order inside each bucket and dropping any bucket that stayed
// empty — an empty heading reads as a bug.
export function groupRuns(runs: StudioRun[], now: Date): RunGroup[] {
  const today = startOfLocalDay(now).getTime();
  const weekAgo = today - 6 * 24 * 60 * 60 * 1000;
  const buckets: RunGroup[] = [
    { label: "Today", runs: [] },
    { label: "This week", runs: [] },
    { label: "Earlier", runs: [] },
  ];
  for (const run of runs) {
    const at = parseRunDate(run.createdAt).getTime();
    if (at >= today) buckets[0].runs.push(run);
    else if (at >= weekAgo) buckets[1].runs.push(run);
    else buckets[2].runs.push(run);
  }
  return buckets.filter((b) => b.runs.length > 0);
}

// runLabel is decision L3: label a row from the artist and title the model
// identified during research, falling back to the reference exactly as it was
// typed when it declined to name either. The subtitle carries the artist and the
// leading genre — only the first, or a three-genre run wraps the row.
export function runLabel(run: StudioRun): { title: string; subtitle: string } {
  const title = run.referenceTitle.trim() || run.reference;
  const parts = [run.referenceArtist.trim(), run.genres[0] ?? ""].filter(
    (p) => p !== "",
  );
  return { title, subtitle: parts.join(" · ") };
}
