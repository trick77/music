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

describe("player play path", () => {
  beforeEach(() => {
    order.length = 0;
    vi.resetModules(); // fresh audio-element singleton per test
    vi.stubGlobal("Audio", MockAudio);
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
