import { describe, it, expect } from "vitest";
import {
  formatDuration,
  formatFileSize,
  formatDateAdded,
  formatLastPlayed,
  formatSampleRate,
  formatChannels,
  formatBitrate,
} from "./format";

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

// Zero means "unknown" across all three: a row the backfill hasn't reached, or a
// file that wouldn't decode. It must never render as "0 Hz" / "0 kbps".
describe("audio info formatters", () => {
  it("renders sample rate in kHz", () => {
    expect(formatSampleRate(44100)).toBe("44.1 kHz");
    expect(formatSampleRate(48000)).toBe("48 kHz");
  });
  it("doesn't round a half-rate up to a wrong number", () => {
    expect(formatSampleRate(22050)).toBe("22.05 kHz"); // one decimal would say 22.1
  });
  it("names channel layouts", () => {
    expect(formatChannels(1)).toBe("Mono");
    expect(formatChannels(2)).toBe("Stereo");
  });
  it("renders bitrate", () => {
    expect(formatBitrate(128)).toBe("128 kbps");
  });
  it("renders unknown values as an em dash, never as zero", () => {
    expect(formatSampleRate(0)).toBe("—");
    expect(formatChannels(0)).toBe("—");
    expect(formatBitrate(0)).toBe("—");
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
  it("rolls over to MB instead of printing 1024 KB", () => {
    expect(formatFileSize(1_048_570)).toBe("1.0 MB");
  });
  it("handles zero and invalid", () => {
    expect(formatFileSize(0)).toBe("—");
    expect(formatFileSize(NaN)).toBe("—");
  });
});

// SQLite's datetime('now') emits UTC with no zone marker ("2026-03-12 09:15:00").
// Date's parser reads that shape as LOCAL time, which silently shifts the value —
// and near midnight, the date itself.
//
// THIS SUITE MUST RUN IN A NON-UTC ZONE or these tests are theatre: where local ==
// UTC the mistake is invisible and every fixture passes with the bug present. The
// `test` script pins TZ=Europe/Zurich (the deploy's zone) — see package.json. The
// fixture below is chosen to break there specifically: a positive offset shifts an
// early-morning UTC stamp *backwards* into the previous day. (A 23:30 fixture only
// breaks in negative-offset zones, so it would prove nothing here.)
describe("formatDateAdded", () => {
  it("renders a SQLite timestamp as a readable date", () => {
    expect(formatDateAdded("2026-03-12 09:15:00")).toBe("12 Mar 2026");
  });
  it("reads the timestamp as UTC, not as local time", () => {
    // 00:30 UTC on the 12th. Misparsed as local in CET this is 23:30 on the 11th.
    expect(formatDateAdded("2026-03-12 00:30:00")).toBe("12 Mar 2026");
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
  // Calendar days, not elapsed 24h windows. Both of these read wrong if you just
  // floor the elapsed milliseconds. (TZ is pinned to Europe/Zurich — see above.)
  it("says Yesterday for last night, even though it's under 24 hours ago", () => {
    // 22:00 local on the 14th; `now` is 14:00 local on the 15th — 16 hours, but
    // unambiguously yesterday.
    expect(formatLastPlayed("2026-07-14 20:00:00", now)).toBe("Yesterday");
  });
  it("says 2 days ago across two calendar days, even though it's under 48 hours", () => {
    // 15:00 local on the 13th; `now` is 14:00 local on the 15th — 47 hours.
    expect(formatLastPlayed("2026-07-13 13:00:00", now)).toBe("2 days ago");
  });
  it("falls back to a date once it's old news", () => {
    expect(formatLastPlayed("2026-01-02 12:00:00", now)).toBe("2 Jan 2026");
  });
});
