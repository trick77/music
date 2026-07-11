import { describe, it, expect } from "vitest";
import { advance, back, qualifiesForPlay, shouldReport, type PlayerState } from "./player";
import type { Song } from "./api";

function song(id: string): Song {
  return { id, title: id, artistName: "A", album: "", year: 0, trackNo: 0, durationMs: 200000, genres: [], coverArtId: "", published: true };
}

function base(overrides: Partial<PlayerState> = {}): PlayerState {
  return { current: null, queue: [], history: [], playing: false, positionMs: 0, durationMs: 0, ...overrides };
}

describe("advance", () => {
  it("moves the queue head to current and pushes current onto history", () => {
    const s = advance(base({ current: song("a"), queue: [song("b"), song("c")], history: [] }));
    expect(s.current?.id).toBe("b");
    expect(s.queue.map((x) => x.id)).toEqual(["c"]);
    expect(s.history.map((x) => x.id)).toEqual(["a"]);
    expect(s.positionMs).toBe(0);
  });

  it("stops (playing=false) when the queue is empty, keeping current", () => {
    const s = advance(base({ current: song("a"), queue: [], playing: true }));
    expect(s.current?.id).toBe("a");
    expect(s.playing).toBe(false);
  });
});

describe("back", () => {
  it("pops history to current and pushes current to the front of the queue", () => {
    const s = back(base({ current: song("b"), queue: [song("c")], history: [song("a")] }));
    expect(s.current?.id).toBe("a");
    expect(s.queue.map((x) => x.id)).toEqual(["b", "c"]);
    expect(s.history).toEqual([]);
  });

  it("restarts the current track when history is empty", () => {
    const s = back(base({ current: song("a"), positionMs: 50000, history: [] }));
    expect(s.current?.id).toBe("a");
    expect(s.positionMs).toBe(0);
  });
});

describe("qualifiesForPlay", () => {
  it("is false just under 30s", () => {
    expect(qualifiesForPlay(29999, 200000)).toBe(false);
  });
  it("is true at exactly 30s", () => {
    expect(qualifiesForPlay(30000, 200000)).toBe(true);
  });
  it("is true at >=50% for a short track before 30s", () => {
    expect(qualifiesForPlay(30000, 60000)).toBe(true); // 30s of a 60s track = 50%
    expect(qualifiesForPlay(12000, 20000)).toBe(true); // 60% of a 20s track
  });
  it("is false below both thresholds", () => {
    expect(qualifiesForPlay(8000, 20000)).toBe(false); // 40% and < 30s
  });
  it("falls back to the 30s rule when duration is unknown", () => {
    expect(qualifiesForPlay(15000, 0)).toBe(false);
    expect(qualifiesForPlay(30000, 0)).toBe(true);
  });
});

describe("shouldReport", () => {
  it("reports once when qualifying, then never again for the session", () => {
    const session = { reported: false };
    expect(shouldReport(session, true)).toBe(true);
    expect(session.reported).toBe(true);
    expect(shouldReport(session, true)).toBe(false);
  });
  it("does not report while not qualifying", () => {
    const session = { reported: false };
    expect(shouldReport(session, false)).toBe(false);
    expect(session.reported).toBe(false);
  });
});
