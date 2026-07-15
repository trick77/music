import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Song } from "./api";

// Records the order of the two calls that must not be swapped: the analyser tap
// (prime) has to run BEFORE el.play(), so the element is rerouted into the graph
// while still paused (seamless) rather than mid-playback (the first-open glitch).
const { order } = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock("./analyser", () => ({
  prime: vi.fn(() => order.push("prime")),
  attach: vi.fn(),
  resume: vi.fn(),
  bands: vi.fn(() => []),
  isAttached: vi.fn(() => false),
}));

class MockAudio {
  paused = true;
  src = "";
  currentTime = 0;
  preload = "";
  duration = 0;
  addEventListener = vi.fn();
  pause = vi.fn(() => {
    this.paused = true;
  });
  play = vi.fn(() => {
    order.push("play");
    this.paused = false;
    return Promise.resolve();
  });
}

function song(id: string): Song {
  return { id, title: id, artist: "", album: "", durationMs: 1000 } as unknown as Song;
}

// stop() clears resume state via window.localStorage; these tests run in the node
// environment, where window is undefined. A minimal store keeps that path real
// rather than mocked away.
function stubWindow() {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
}

describe("player play path", () => {
  beforeEach(() => {
    order.length = 0;
    vi.resetModules(); // fresh audio-element singleton per test
    vi.stubGlobal("Audio", MockAudio);
    stubWindow();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("primes the analyser before el.play() on first play", async () => {
    const { player } = await import("./player");

    player.play(song("a"));

    expect(order).toEqual(["prime", "play"]);
  });

  it("primes the analyser before el.play() when resuming from pause via toggle", async () => {
    const { player } = await import("./player");

    player.play(song("a")); // start (prime + play)
    order.length = 0;
    player.toggle(); // pause — no prime, no play
    player.toggle(); // resume — must prime before play

    expect(order).toEqual(["prime", "play"]);
  });
});

// Advancing past the last song closes the player rather than parking it at 0:00.
// The `ended` listener calls next() for a song that finishes on its own, so this
// is the end-of-queue behaviour users actually hit; the Next control is greyed out
// (Transport's canNext) before it can reach here.
describe("player end of queue", () => {
  beforeEach(() => {
    order.length = 0;
    vi.resetModules();
    vi.stubGlobal("Audio", MockAudio);
    stubWindow();
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

  it("wipes resume state on close so the finished song is not reopened", async () => {
    const { player } = await import("./player");
    const { loadResume, saveResume } = await import("./resume");

    player.play(song("a"));
    // Seed resume state explicitly: nothing writes it here otherwise (persist()
    // only runs from a timeupdate, which MockAudio never fires), so without this
    // the store is already empty and the assertion would pass against a stop()
    // that never cleared anything.
    saveResume(window.localStorage, { songId: "a", positionMs: 42000, reported: false, savedAt: Date.now() });
    expect(loadResume(window.localStorage)).not.toBeNull();

    player.next(); // empty queue → close

    expect(loadResume(window.localStorage)).toBeNull();
  });
});
