import { describe, it, expect } from "vitest";
import { formatDuration, formatFileSize, formatDateAdded, formatLastPlayed } from "./format";

describe("formatDuration", () => {
  it("formats minutes and seconds", () => {
    expect(formatDuration(185000)).toBe("3:05");
  });
  it("pads seconds", () => {
    expect(formatDuration(5000)).toBe("0:05");
  });
  it("handles zero and invalid", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(NaN)).toBe("0:00");
  });
});

describe("formatFileSize", () => {
  it("uses MB for a typical track", () => {
    expect(formatFileSize(8_800_000)).toBe("8.4 MB");
  });
  it("uses KB for small files", () => {
    expect(formatFileSize(204_800)).toBe("200 KB");
  });
  it("drops the decimal once past 100 MB", () => {
    expect(formatFileSize(126_353_408)).toBe("121 MB");
  });
  it("handles zero and invalid", () => {
    expect(formatFileSize(0)).toBe("—");
    expect(formatFileSize(NaN)).toBe("—");
  });
});

// SQLite's datetime('now') emits UTC with no zone marker ("2026-03-12 09:15:00").
// Date's parser reads that shape as LOCAL time, which silently shifts the value —
// and near midnight, the date itself. These pin the UTC handling down.
describe("formatDateAdded", () => {
  it("renders a SQLite timestamp as a readable date", () => {
    expect(formatDateAdded("2026-03-12 09:15:00")).toBe("12 Mar 2026");
  });
  it("reads the timestamp as UTC, not as local time", () => {
    // 23:30 UTC on the 12th. Parsed as local in a positive-offset zone (e.g. CET)
    // this lands on the 13th — the classic off-by-one-day.
    const utcMidnightish = formatDateAdded("2026-03-12 23:30:00");
    const asUtc = new Date(Date.UTC(2026, 2, 12, 23, 30));
    const expected = new Intl.DateTimeFormat("en-GB", {
      day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
    }).format(asUtc);
    expect(utcMidnightish).toBe(expected);
  });
  it("handles a missing timestamp", () => {
    expect(formatDateAdded("")).toBe("—");
  });
});

describe("formatLastPlayed", () => {
  const now = new Date(Date.UTC(2026, 6, 15, 12, 0, 0));

  it("says Never when the song has never been played", () => {
    expect(formatLastPlayed("", now)).toBe("Never");
  });
  it("says Today for a play a few hours ago", () => {
    expect(formatLastPlayed("2026-07-15 09:00:00", now)).toBe("Today");
  });
  it("says Yesterday for a play just over a day ago", () => {
    expect(formatLastPlayed("2026-07-14 09:00:00", now)).toBe("Yesterday");
  });
  it("counts days for the recent past", () => {
    expect(formatLastPlayed("2026-07-10 12:00:00", now)).toBe("5 days ago");
  });
  it("falls back to a date once it's old news", () => {
    expect(formatLastPlayed("2026-01-02 12:00:00", now)).toBe("2 Jan 2026");
  });
});
