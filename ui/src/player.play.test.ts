import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Song } from "./api";

// Records the calls the play path makes. The invariant under test: playing must
// NEVER tap the element into the Web Audio graph. createMediaElementSource()
// pulls the <audio> out of the browser's normal output and into our graph, and
// WebKit interrupts the AudioContext when an iPhone locks — so a tapped element
// goes silent on the lock screen (timer keeps advancing, no sound, returns on
// unlock). Only the visualizer may tap, and only when actually opened.
const { order } = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock("./analyser", () => ({
  // Any of these firing from the play path would mean playback got routed through
  // the Web Audio graph — the exact regression this file guards against. They push
  // to `order` so an accidental tap shows up alongside the play/pause sequence.
  startAnalysis: vi.fn(() => order.push("startAnalysis")),
  stopAnalysis: vi.fn(() => order.push("stopAnalysis")),
  syncAnalysis: vi.fn(() => order.push("syncAnalysis")),
  resume: vi.fn(),
  bands: vi.fn(() => []),
  isAnalysing: vi.fn(() => false),
}));

// The timeupdate ticks the persistence tests drive make reportPlay reachable; it
// would otherwise hit the network. Everything else in ./api stays real.
const { reportPlayMock } = vi.hoisted(() => ({ reportPlayMock: vi.fn(() => Promise.resolve()) }));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  reportPlay: reportPlayMock,
}));

// The player creates its audio element internally, so tests reach it through here.
const audioInstances: MockAudio[] = [];

class MockAudio {
  constructor() {
    audioInstances.push(this);
  }
  paused = true;
  src = "";
  currentTime = 0;
  preload = "";
  duration = 0;
  // Keyed by type but holding every listener: dropping a second one would hide a
  // handler rather than fail loudly.
  handlers: Record<string, Array<() => void>> = {};
  addEventListener = vi.fn((type: string, fn: () => void) => {
    (this.handlers[type] ??= []).push(fn);
  });
  fire(type: string) {
    for (const fn of this.handlers[type] ?? []) fn();
  }
  pause = vi.fn(() => {
    this.paused = true;
  });
  play = vi.fn(() => {
    order.push("play");
    this.paused = false;
    return Promise.resolve();
  });
}

// A listen counts at >=30s OR >=50% of the track (qualifiesForPlay). Tests that
// mean to exercise the 30s rule need a track long enough that the 50% rule can't
// fire first — a 1s fixture would qualify on the very first tick.
const LONG_TRACK_MS = 5 * 60 * 1000;

function song(id: string, durationMs = 1000): Song {
  return { id, title: id, artist: "", album: "", durationMs } as unknown as Song;
}

// Shared module-level state, reset for every test in the file so no block
// depends on running after another.
beforeEach(() => {
  order.length = 0;
  audioInstances.length = 0;
  reportPlayMock.mockClear();
});

describe("player play path", () => {
  beforeEach(() => {
    vi.resetModules(); // fresh audio-element singleton per test
    vi.stubGlobal("Audio", MockAudio);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("plays without tapping the element into the Web Audio graph", async () => {
    const { player } = await import("./player");

    player.play(song("a"));

    expect(order).toEqual(["play"]);
  });

  it("does not tap the element when resuming from pause via toggle", async () => {
    const { player } = await import("./player");

    player.play(song("a")); // start
    order.length = 0;
    player.toggle(); // pause — no play
    player.toggle(); // resume — plays, still untapped

    expect(order).toEqual(["play"]);
  });

  // The tap itself (startAnalysis → createMediaElementSource) is what breaks
  // lock-screen audio, so the play path must never reach it. Asserted separately
  // from the call order above: a future refactor could reintroduce the tap without
  // disturbing it. (The tap now lands on a dedicated analysis element, never the
  // audible one — but the play path must still never start it.)
  it("never taps the element from the play path, so lock-screen audio survives", async () => {
    const { player } = await import("./player");
    const { startAnalysis } = await import("./analyser");

    player.play(song("a"));
    player.toggle(); // pause
    player.toggle(); // resume

    expect(startAnalysis).not.toHaveBeenCalled();
  });
});

// Advancing past the last song closes the player rather than parking it at 0:00.
// The `ended` listener calls next() for a song that finishes on its own, so this
// is the end-of-queue behaviour users actually hit; the Next control is greyed out
// (Transport's canNext) before it can reach here.
describe("player end of queue", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("Audio", MockAudio);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("closes the player when next() runs with an empty queue", async () => {
    const { player } = await import("./player");

    player.play(song("a")); // nothing queued behind it
    player.next();

    expect(player.getState().current).toBeNull();
    expect(player.getState().playing).toBe(false);
  });

  it("advances normally while the queue still has songs, closing only past the last", async () => {
    const { player } = await import("./player");

    player.play(song("a"), [song("b")]);
    player.next(); // a → b, queue now empty

    expect(player.getState().current?.id).toBe("b");
    expect(player.getState().queue).toEqual([]);

    player.next(); // past the last song → close

    expect(player.getState().current).toBeNull();
  });
});

// A reload brings the docked mini-player back to its exact position — but ONLY
// if a track was actually playing when the page went away. The snapshot is
// written when the page is hidden/unloaded (pagehide / visibilitychange→hidden),
// never on the per-tick timeupdate, and restore() reseeds paused at the saved
// position. This is deliberately narrower than the old `music.resume` feature
// (#178), which reseeded the last track even when paused and only within a
// 30-minute window.
describe("player persistence", () => {
  const KEY = "music.player.v1";
  let store: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };
  // The player registers pagehide (window) and visibilitychange (document) in
  // getAudio; capture their handlers so tests can fire "the page went away".
  let winHandlers: Record<string, Array<() => void>>;
  let docHandlers: Record<string, Array<() => void>>;
  let doc: { hidden: boolean; addEventListener: (t: string, fn: () => void) => void };

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("Audio", MockAudio);
    store = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    winHandlers = {};
    docHandlers = {};
    vi.stubGlobal("window", {
      localStorage: store,
      addEventListener: (t: string, fn: () => void) => (winHandlers[t] ??= []).push(fn),
    });
    doc = {
      hidden: false,
      addEventListener: (t: string, fn: () => void) => (docHandlers[t] ??= []).push(fn),
    };
    vi.stubGlobal("document", doc);
  });
  afterEach(() => vi.unstubAllGlobals());

  const firePageHide = () => (winHandlers["pagehide"] ?? []).forEach((fn) => fn());
  const fireHidden = () => {
    doc.hidden = true;
    (docHandlers["visibilitychange"] ?? []).forEach((fn) => fn());
  };

  async function playTo(seconds: number) {
    const { player } = await import("./player");
    player.play(song("a", LONG_TRACK_MS));
    const el = audioInstances[0];
    for (let t = 1; t <= seconds; t++) {
      el.currentTime = t;
      el.fire("timeupdate");
    }
    return player;
  }

  it("does not write to storage on timeupdate ticks — only when the page hides", async () => {
    await playTo(35);
    expect(store.setItem).not.toHaveBeenCalled();
  });

  it("still counts the listen exactly once, and only once the threshold is crossed", async () => {
    // Guards the ticks the persistence path rides on: if the fixture ever let the
    // 50%-of-track rule fire early, this catches it at 29s.
    const player = await playTo(29);
    expect(reportPlayMock).not.toHaveBeenCalled();

    const el = audioInstances[0];
    for (let t = 30; t <= 40; t++) {
      el.currentTime = t;
      el.fire("timeupdate");
    }

    expect(reportPlayMock).toHaveBeenCalledTimes(1);
    expect(player.getState().current?.id).toBe("a");
  });

  it("saves {id, positionMs} when the page hides while playing", async () => {
    await playTo(35); // playing, currentTime = 35s

    firePageHide();

    expect(store.setItem).toHaveBeenCalledTimes(1);
    const [key, value] = store.setItem.mock.calls[0];
    expect(key).toBe(KEY);
    expect(JSON.parse(value)).toEqual({ id: "a", positionMs: 35_000 });
  });

  it("saves on visibilitychange→hidden too (the mobile signal)", async () => {
    await playTo(12);

    fireHidden();

    expect(store.setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.setItem.mock.calls[0][1])).toEqual({ id: "a", positionMs: 12_000 });
  });

  it("clears the key when the page hides while paused (not playing → no restore)", async () => {
    const player = await playTo(20);
    player.toggle(); // pause

    firePageHide();

    expect(store.setItem).not.toHaveBeenCalled();
    expect(store.removeItem).toHaveBeenCalledWith(KEY);
  });

  it("clears the key when the page hides with the player closed", async () => {
    const player = await playTo(20);
    player.stop(); // current === null

    firePageHide();

    expect(store.setItem).not.toHaveBeenCalled();
    expect(store.removeItem).toHaveBeenCalledWith(KEY);
  });

  it("restore() reseeds paused at the saved position once metadata loads", async () => {
    const { player } = await import("./player");

    player.restore(song("a", LONG_TRACK_MS), 42_000);

    // Cued but paused, position reflected immediately for the scrubber.
    expect(player.getState().current?.id).toBe("a");
    expect(player.getState().playing).toBe(false);
    expect(player.getState().positionMs).toBe(42_000);

    // The seek lands only once the element can seek (loadedmetadata).
    const el = audioInstances[0];
    el.duration = LONG_TRACK_MS / 1000;
    el.fire("loadedmetadata");
    expect(el.currentTime).toBe(42);
  });

  it("does not re-count a listen when restoring past the counting threshold", async () => {
    const { player } = await import("./player");

    player.restore(song("a", LONG_TRACK_MS), 45_000); // already qualifies (>= 30s)
    const el = audioInstances[0];
    el.duration = LONG_TRACK_MS / 1000;
    el.fire("loadedmetadata");
    el.play(); // user resumes
    for (let t = 46; t <= 60; t++) {
      el.currentTime = t;
      el.fire("timeupdate");
    }

    expect(reportPlayMock).not.toHaveBeenCalled(); // counted before the reload
  });

  it("counts a fresh listen when restoring before the threshold", async () => {
    const { player } = await import("./player");

    player.restore(song("a", LONG_TRACK_MS), 5_000); // below 30s — not yet counted
    const el = audioInstances[0];
    el.duration = LONG_TRACK_MS / 1000;
    el.fire("loadedmetadata");
    for (let t = 6; t <= 40; t++) {
      el.currentTime = t;
      el.fire("timeupdate");
    }

    expect(reportPlayMock).toHaveBeenCalledTimes(1);
  });
});
