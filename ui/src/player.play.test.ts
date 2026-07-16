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
  attach: vi.fn(() => order.push("attach")),
  resume: vi.fn(),
  bands: vi.fn(() => []),
  isAttached: vi.fn(() => false),
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

  // The tap itself (attach → createMediaElementSource) is what breaks lock-screen
  // audio, so the play path must never reach it. Asserted separately from the call
  // order above: a future refactor could reintroduce the tap without disturbing it.
  it("never taps the element from the play path, so lock-screen audio survives", async () => {
    const { player } = await import("./player");
    const { attach } = await import("./analyser");

    player.play(song("a"));
    player.toggle(); // pause
    player.toggle(); // resume

    expect(attach).not.toHaveBeenCalled();
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

// A reload starts with an empty player: nothing about playback is persisted, so
// there is nothing to reseed the dock from. Playing a track used to write
// `music.resume` to localStorage every few seconds; a regression that brings any
// of that back would fail here.
describe("player persistence", () => {
  // Asserted against as a whole: the old code both wrote (persist) and cleared
  // (clearResume on stop) the key, so a regression could surface as setItem OR
  // removeItem — and a returning restore() would read via getItem.
  let store: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("Audio", MockAudio);
    store = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    vi.stubGlobal("window", { localStorage: store });
  });
  afterEach(() => vi.unstubAllGlobals());

  // Drives real timeupdate ticks: the write path only ever ran from there, so a
  // test that never fires one would pass against a player that still persists.
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

  it("never touches storage while playing, even past the 30s counting threshold", async () => {
    await playTo(35);

    expect(store.setItem).not.toHaveBeenCalled();
    expect(store.removeItem).not.toHaveBeenCalled();
    expect(store.getItem).not.toHaveBeenCalled();
  });

  it("still counts the listen exactly once, and only once the threshold is crossed", async () => {
    // Guards the ticks the storage assertions ride on: if the fixture ever let
    // the 50%-of-track rule fire early, this catches it at 29s.
    const player = await playTo(29);
    expect(reportPlayMock).not.toHaveBeenCalled();

    const el = audioInstances[0];
    for (let t = 30; t <= 40; t++) {
      el.currentTime = t;
      el.fire("timeupdate");
    }

    expect(reportPlayMock).toHaveBeenCalledTimes(1);
    expect(store.setItem).not.toHaveBeenCalled();
    expect(player.getState().current?.id).toBe("a");
  });

  it("leaves storage untouched when the player is closed", async () => {
    const player = await playTo(35);

    player.stop(); // used to clearResume() → removeItem

    expect(store.removeItem).not.toHaveBeenCalled();
    expect(store.setItem).not.toHaveBeenCalled();
  });
});
