import { describe, it, expect } from "vitest";
import { advance, back, shouldRestart, qualifiesForPlay, shouldReport, removeSong, replaceSong, shuffle, mediaShouldToggle, type PlayerState } from "./player";
import type { Song } from "./api";

function song(id: string): Song {
  return { id, title: id, artistName: "A", album: "", year: 0, trackNo: 0, trackTotal: 0, durationMs: 200000, fileSize: 0, createdAt: "", sampleRate: 0, channels: 0, bitrateKbps: 0, genres: [], coverArtId: "", published: true };
}

function base(overrides: Partial<PlayerState> = {}): PlayerState {
  return { current: null, queue: [], history: [], playing: false, positionMs: 0, durationMs: 0, airplayAvailable: false, airplayActive: false, ...overrides };
}

describe("mediaShouldToggle", () => {
  // An OS "play" only acts when actually paused; "pause" only when playing. A
  // redundant command (the direction the tab is already in) must be a no-op, so a
  // Continuity-relayed play at an already-playing tab can never flip it to paused.
  it("plays only when paused", () => {
    expect(mediaShouldToggle("play", true)).toBe(true);
    expect(mediaShouldToggle("play", false)).toBe(false);
  });
  it("pauses only when playing", () => {
    expect(mediaShouldToggle("pause", false)).toBe(true);
    expect(mediaShouldToggle("pause", true)).toBe(false);
  });
});

describe("advance", () => {
  it("moves the queue head to current and pushes current onto history", () => {
    const s = advance(base({ current: song("a"), queue: [song("b"), song("c")], history: [] }));
    expect(s.current?.id).toBe("b");
    expect(s.queue.map((x) => x.id)).toEqual(["c"]);
    expect(s.history.map((x) => x.id)).toEqual(["a"]);
    expect(s.positionMs).toBe(0);
  });

  it("stops (playing=false) and resets position when the queue is empty, keeping current", () => {
    const s = advance(base({ current: song("a"), queue: [], playing: true, positionMs: 199000 }));
    expect(s.current?.id).toBe("a");
    expect(s.playing).toBe(false);
    expect(s.positionMs).toBe(0);
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

describe("shouldRestart", () => {
  it("restarts when well into the track (past the threshold)", () => {
    expect(shouldRestart(5000)).toBe(true);
  });
  it("steps back at or below the threshold", () => {
    expect(shouldRestart(3000)).toBe(false);
    expect(shouldRestart(1000)).toBe(false);
    expect(shouldRestart(0)).toBe(false);
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

describe("removeSong", () => {
  it("drops the id from queue and history without touching current", () => {
    const s = removeSong(base({ current: song("a"), queue: [song("b"), song("c")], history: [song("x")] }), "c");
    expect(s.current?.id).toBe("a");
    expect(s.queue.map((q) => q.id)).toEqual(["b"]);
    expect(s.history.map((h) => h.id)).toEqual(["x"]);
  });

  it("clears current and stops when the removed id is the current track", () => {
    const s = removeSong(base({ current: song("a"), queue: [song("b")], playing: true, positionMs: 5000 }), "a");
    expect(s.current).toBeNull();
    expect(s.playing).toBe(false);
    expect(s.positionMs).toBe(0);
    expect(s.queue.map((q) => q.id)).toEqual(["b"]);
  });
});

describe("replaceSong", () => {
  it("swaps the edited song into current/queue/history without disturbing playback", () => {
    const edited = { ...song("a"), title: "New Title", coverArtId: "cover-2" };
    const s = replaceSong(
      base({ current: song("a"), queue: [song("a"), song("b")], history: [song("a")], playing: true, positionMs: 5000 }),
      edited,
    );
    expect(s.current).toBe(edited);
    expect(s.current?.title).toBe("New Title");
    expect(s.queue.map((q) => q.title)).toEqual(["New Title", "b"]);
    expect(s.history[0].title).toBe("New Title");
    // Playback state is untouched — a tag edit changes metadata, not what plays.
    expect(s.playing).toBe(true);
    expect(s.positionMs).toBe(5000);
  });

  it("leaves state unchanged when the edited id is absent", () => {
    const s = replaceSong(base({ current: song("a"), queue: [song("b")] }), { ...song("z"), title: "Z" });
    expect(s.current?.id).toBe("a");
    expect(s.queue.map((q) => q.id)).toEqual(["b"]);
  });
});

describe("shuffle", () => {
  it("returns a permutation without mutating input", () => {
    const src = [1, 2, 3, 4, 5];
    const out = shuffle(src);
    expect(out.slice().sort()).toEqual([1, 2, 3, 4, 5]);
    expect(src).toEqual([1, 2, 3, 4, 5]); // unchanged
  });
});
