import { describe, it, expect } from "vitest";
import {
  groupRuns,
  runLabel,
  parseRunDate,
  formatRunDate,
} from "./studioHistoryGroups";
import type { StudioRun } from "./api";

function run(over: Partial<StudioRun> = {}): StudioRun {
  return {
    id: "r",
    reference: "Metallica, Enter Sandman",
    referenceArtist: "",
    referenceTitle: "",
    stylePrompt: "",
    lyrics: "",
    coverArtPrompt: "",
    genres: [],
    bands: [],
    titles: [],
    albums: [],
    coverArtId: "",
    refineCount: 0,
    createdAt: "2026-08-01 10:00:00",
    updatedAt: "2026-08-01 10:00:00",
    ...over,
  };
}

// SQLite's datetime('now') emits "2026-08-01 10:00:00" — a space instead of a T,
// and no zone even though the value is UTC. Safari's Date parser rejects that
// shape outright, so the column value must never reach new Date() untouched.
describe("parseRunDate", () => {
  it("reads a SQLite datetime as UTC", () => {
    expect(parseRunDate("2026-08-01 10:00:00").toISOString()).toBe(
      "2026-08-01T10:00:00.000Z",
    );
  });

  it("survives an unparseable value instead of returning Invalid Date", () => {
    expect(Number.isNaN(parseRunDate("").getTime())).toBe(false);
    expect(Number.isNaN(parseRunDate("not a date").getTime())).toBe(false);
  });
});

describe("groupRuns", () => {
  const now = new Date("2026-08-01T12:00:00Z");

  it("buckets into today, this week and earlier", () => {
    const groups = groupRuns(
      [
        run({ id: "a", createdAt: "2026-08-01 09:00:00" }),
        run({ id: "b", createdAt: "2026-07-29 09:00:00" }),
        run({ id: "c", createdAt: "2026-06-01 09:00:00" }),
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "This week",
      "Earlier",
    ]);
    expect(groups[0].runs.map((r) => r.id)).toEqual(["a"]);
    expect(groups[1].runs.map((r) => r.id)).toEqual(["b"]);
    expect(groups[2].runs.map((r) => r.id)).toEqual(["c"]);
  });

  it("omits empty buckets rather than rendering an empty heading", () => {
    const groups = groupRuns([run({ createdAt: "2026-06-01 09:00:00" })], now);
    expect(groups.map((g) => g.label)).toEqual(["Earlier"]);
  });

  it("preserves the server's newest-first order within a bucket", () => {
    const groups = groupRuns(
      [
        run({ id: "a", createdAt: "2026-08-01 11:00:00" }),
        run({ id: "b", createdAt: "2026-08-01 09:00:00" }),
      ],
      now,
    );
    expect(groups[0].runs.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("groups nothing into nothing", () => {
    expect(groupRuns([], now)).toEqual([]);
  });

  // Yesterday is not Today even when it is well under 24 hours back — the bucket
  // is the calendar day, not a rolling window.
  it("puts yesterday in this week, not today", () => {
    const groups = groupRuns(
      [run({ id: "a", createdAt: "2026-07-31 12:00:00" })],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(["This week"]);
  });

  // Bucketing is done in the viewer's zone, not UTC: 22:30 UTC on 31 July is
  // already 1 August in Zurich, so it belongs to Today.
  it("buckets by the local calendar day, not the UTC one", () => {
    const groups = groupRuns(
      [run({ id: "a", createdAt: "2026-07-31 22:30:00" })],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(["Today"]);
  });
});

describe("runLabel", () => {
  it("prefers the model's artist and title", () => {
    expect(
      runLabel(
        run({ referenceArtist: "Metallica", referenceTitle: "Enter Sandman" }),
      ),
    ).toEqual({ title: "Enter Sandman", subtitle: "Metallica" });
  });

  // L3's fallback: the model may decline, and a run must still be identifiable.
  it("falls back to the reference verbatim when the metadata is empty", () => {
    expect(runLabel(run({ reference: "blue monday new order" }))).toEqual({
      title: "blue monday new order",
      subtitle: "",
    });
  });

  it("uses the title alone when only the artist is missing", () => {
    expect(runLabel(run({ referenceTitle: "Enter Sandman" }))).toEqual({
      title: "Enter Sandman",
      subtitle: "",
    });
  });

  // An artist without a title still beats a raw reference for the subtitle, but
  // the reference has to carry the title line — a row with no name is useless.
  it("keeps the reference as the title when only the artist came back", () => {
    expect(
      runLabel(
        run({
          referenceArtist: "Metallica",
          reference: "enter sandman metallica",
        }),
      ),
    ).toEqual({ title: "enter sandman metallica", subtitle: "Metallica" });
  });

  it("appends genres to the subtitle when there are any", () => {
    expect(
      runLabel(
        run({
          referenceArtist: "Metallica",
          referenceTitle: "Enter Sandman",
          genres: ["thrash metal"],
        }),
      ),
    ).toEqual({ title: "Enter Sandman", subtitle: "Metallica · thrash metal" });
  });

  it("shows genres alone when there is no artist", () => {
    expect(
      runLabel(
        run({ referenceTitle: "Enter Sandman", genres: ["thrash metal"] }),
      ),
    ).toEqual({ title: "Enter Sandman", subtitle: "thrash metal" });
  });

  // Only the first genre — a three-genre run would otherwise wrap the row.
  it("uses only the leading genre", () => {
    expect(
      runLabel(
        run({
          referenceTitle: "Enter Sandman",
          genres: ["thrash metal", "heavy metal", "speed metal"],
        }),
      ),
    ).toEqual({ title: "Enter Sandman", subtitle: "thrash metal" });
  });
});

describe("formatRunDate", () => {
  it("renders a saved run's timestamp as a readable local date", () => {
    // TZ is pinned to Europe/Zurich for the suite, so 10:00 UTC is 12:00 local.
    expect(formatRunDate("2026-08-01 10:00:00")).toMatch(/2026/);
    expect(formatRunDate("2026-08-01 10:00:00")).toMatch(/12:00/);
  });
});
