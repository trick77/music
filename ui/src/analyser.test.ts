import { describe, it, expect, beforeEach, vi } from "vitest";
import { bandEdges, rateTrim } from "./analyser";

// rateTrim is the pure core of the visualizer's clock-lock: it maps a clock-offset
// error (seconds) to a playbackRate delta that drives the silent analysis element
// back onto the player's clock. The sign is the only part of the fix that could be
// subtly wrong, so it is pinned here without needing a live media element.
describe("rateTrim", () => {
  it("speeds up (positive trim) when the analysis element is behind (negative error)", () => {
    expect(rateTrim(-0.1)).toBeGreaterThan(0);
  });
  it("slows down (negative trim) when the analysis element is ahead (positive error)", () => {
    expect(rateTrim(0.1)).toBeLessThan(0);
  });
  it("is zero at zero error — a locked element holds rate 1", () => {
    expect(rateTrim(0)).toBeCloseTo(0); // may be -0; 1 + -0 === 1, so functionally locked
  });
  it("clamps to ±6% however large the error", () => {
    expect(rateTrim(-10)).toBeCloseTo(0.06);
    expect(rateTrim(10)).toBeCloseTo(-0.06);
  });
  it("returns 0 for a non-finite error so playbackRate is never assigned NaN", () => {
    expect(rateTrim(NaN)).toBe(0);
    expect(rateTrim(Infinity)).toBe(0);
    expect(rateTrim(-Infinity)).toBe(0);
  });
});

// A minimal, controllable AudioContext mock. createMediaElementSource is the tap
// we care about; resume() records that the context was un-suspended.
let lastCtx: MockAudioContext;
let lastAnalyser: MockAnalyser;
let lastAudio: MockAudio; // the dedicated analysis element the module creates
// "interrupted" is WebKit's non-standard state on iOS (lock screen, phone call).
type CtxState = "suspended" | "running" | "interrupted";
let initialState: CtxState = "suspended"; // starting ctx state a test opts into

// Fills a caller-provided Uint8Array in place, mirroring getByteFrequencyData.
type FreqFiller = (arr: Uint8Array) => void;
let freqFiller: FreqFiller = () => {}; // default: silence (all zero)

interface MockAnalyser {
  fftSize: number;
  smoothingTimeConstant: number;
  minDecibels: number;
  maxDecibels: number;
  frequencyBinCount: number;
  connect: () => void;
  getByteFrequencyData: (arr: Uint8Array) => void;
}

// Stand-in for the dedicated <audio> element (global Audio). Records the transport
// calls so tests can assert the analysis element — not the main one — is driven.
class MockAudio {
  src = "";
  currentSrc = "";
  currentTime = 0;
  paused = true;
  preload = "";
  crossOrigin: string | null = null;
  play = vi.fn(() => {
    this.paused = false;
    return Promise.resolve();
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  removeAttribute = vi.fn();
  load = vi.fn();
  constructor() {
    lastAudio = this;
  }
}

class MockAudioContext {
  state: CtxState = "suspended";
  destination = {};
  createMediaElementSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() }));
  resume = vi.fn(() => {
    this.state = "running";
  });

  constructor() {
    lastCtx = this; // capture the instance the module under test creates
    this.state = initialState;
  }

  sampleRate = 44100;
  createAnalyser(): MockAnalyser {
    lastAnalyser = {
      fftSize: 0,
      smoothingTimeConstant: 0,
      minDecibels: 0,
      maxDecibels: 0,
      frequencyBinCount: 128,
      connect: vi.fn(),
      getByteFrequencyData: (arr: Uint8Array) => freqFiller(arr),
    };
    return lastAnalyser;
  }
}

// Fresh module state per test (analyser.ts holds module-level singletons). The
// module creates the context + a dedicated Audio element itself; the mocks capture
// those instances so the test can inspect their calls.
async function freshAnalyser(state: CtxState = "suspended") {
  vi.resetModules();
  initialState = state;
  freqFiller = () => {}; // reset to silence unless a test opts in
  lastCtx = undefined as unknown as MockAudioContext; // no context created until startAnalysis()
  lastAudio = undefined as unknown as MockAudio;
  vi.stubGlobal("window", { AudioContext: MockAudioContext });
  vi.stubGlobal("Audio", MockAudio);
  return import("./analyser");
}

describe("bandEdges", () => {
  const BINS = 1024; // frequencyBinCount at fftSize 2048

  it("caps the top band at the ~16 kHz bin, not Nyquist (44.1 kHz)", () => {
    const edges = bandEdges(28, BINS, 44100);
    // 16000 / 22050 * 1024 ≈ 743 — well below the 1024 Nyquist bin that left the
    // rightmost bar permanently dark.
    expect(edges[edges.length - 1][1]).toBe(743);
    expect(edges[edges.length - 1][1]).toBeLessThan(BINS);
  });

  it("caps the top band at the ~16 kHz bin, not Nyquist (48 kHz)", () => {
    const edges = bandEdges(28, BINS, 48000);
    // 16000 / 24000 * 1024 ≈ 683
    expect(edges[edges.length - 1][1]).toBe(683);
    expect(edges[edges.length - 1][1]).toBeLessThan(BINS);
  });

  it("produces contiguous, strictly increasing bands starting at bin 1", () => {
    const edges = bandEdges(28, BINS, 44100);
    expect(edges).toHaveLength(28);
    expect(edges[0][0]).toBe(1); // skips bin 0 (DC)
    for (let i = 0; i < edges.length; i++) {
      expect(edges[i][1]).toBeGreaterThan(edges[i][0]); // spans at least one bin
      if (i > 0) expect(edges[i][0]).toBe(edges[i - 1][1]); // contiguous: no gaps/overlaps
    }
  });
});

describe("bands (rightmost bar lights on real high-frequency energy)", () => {
  beforeEach(() => vi.unstubAllGlobals());

  // With 128 bins at 44.1 kHz the cap lands at bin 93 (~16 kHz); the last of 28
  // bands spans roughly bins 79–92 (~13.6–16 kHz), where cymbals/hi-hats live.
  it("gives the last band nonzero level when energy sits just below 16 kHz", async () => {
    const { startAnalysis, bands } = await freshAnalyser("running");
    startAnalysis(); // wires the analyser (ctx already running)
    freqFiller = (arr) => arr.fill(255, 60, 93); // energy across the upper audible bins

    const out = bands(28);
    expect(out[out.length - 1]).toBeGreaterThan(0); // the rightmost bar is reachable
  });

  it("keeps the last band dark when all energy is above the 16 kHz cap", async () => {
    const { startAnalysis, bands } = await freshAnalyser("running");
    startAnalysis();
    freqFiller = (arr) => arr.fill(255, 93); // only the near-silent >16 kHz region

    const out = bands(28);
    // The old code stretched the top band to Nyquist and read this dead range;
    // the cap deliberately excludes it, so the bar tracks audible content only.
    expect(out[out.length - 1]).toBe(0);
  });
});

// A stand-in for the AUDIBLE element that playback owns. The invariant under test
// is that this element is never handed to createMediaElementSource.
function mainEl(over: Partial<HTMLMediaElement> = {}): HTMLMediaElement {
  return { src: "", currentSrc: "", currentTime: 0, paused: true, play: vi.fn(), pause: vi.fn(), ...over } as unknown as HTMLMediaElement;
}

describe("startAnalysis", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("taps a DEDICATED element, never the audible one (the whole point of the fix)", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser();
    const main = mainEl({ currentSrc: "/api/songs/1/stream", paused: false });

    const ok = startAnalysis();
    syncAnalysis(main); // even after mirroring, the main element is never tapped

    expect(ok).toBe(true);
    expect(lastCtx.createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(lastCtx.createMediaElementSource).toHaveBeenCalledWith(lastAudio); // the hidden element
    expect(lastCtx.createMediaElementSource).not.toHaveBeenCalledWith(main); // NEVER the audible one
  });

  it("routes the graph through a gain-0 sink so the analysis element stays silent", async () => {
    const { startAnalysis } = await freshAnalyser();
    startAnalysis();
    const gain = lastCtx.createGain.mock.results[0].value;
    expect(gain.gain.value).toBe(0);
  });

  it("is idempotent — a second call does not create a second source", async () => {
    const { startAnalysis } = await freshAnalyser();
    startAnalysis();
    startAnalysis();
    expect(lastCtx.createMediaElementSource).toHaveBeenCalledTimes(1);
  });

  it("reports false when Web Audio is unavailable (caller shows synthetic bars)", async () => {
    vi.resetModules();
    vi.stubGlobal("window", {}); // no AudioContext / webkitAudioContext
    vi.stubGlobal("Audio", MockAudio);
    const { startAnalysis, isAnalysing } = await import("./analyser");
    expect(startAnalysis()).toBe(false);
    expect(isAnalysing()).toBe(false);
  });
});

describe("syncAnalysis", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("mirrors the main element's source and starts the hidden element playing", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/42/stream", currentTime: 12, paused: false });

    syncAnalysis(main);

    expect(lastAudio.src).toBe("/api/songs/42/stream");
    expect(lastAudio.play).toHaveBeenCalled();
  });

  it("pauses the hidden element when the main element is paused", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    startAnalysis();
    // First bring it up to speed while playing…
    syncAnalysis(mainEl({ currentSrc: "/api/songs/1/stream", paused: false }));
    // …then pause the main element.
    syncAnalysis(mainEl({ currentSrc: "/api/songs/1/stream", paused: true }));

    expect(lastAudio.pause).toHaveBeenCalled();
  });

  it("is a no-op when nothing has been started", async () => {
    const { syncAnalysis } = await freshAnalyser("running");
    // No startAnalysis(): must not throw and must not create anything.
    expect(() => syncAnalysis(mainEl({ currentSrc: "/x", paused: false }))).not.toThrow();
    expect(lastAudio).toBeUndefined();
  });
});

describe("stopAnalysis", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("pauses and releases the analysis element so the second stream stops", async () => {
    const { startAnalysis, stopAnalysis, isAnalysing } = await freshAnalyser("running");
    startAnalysis();
    const el = lastAudio;

    stopAnalysis();

    expect(el.pause).toHaveBeenCalled();
    expect(el.load).toHaveBeenCalled(); // releases the network stream
    expect(isAnalysing()).toBe(false);
  });

  it("lets a fresh element be tapped again on the next open", async () => {
    const { startAnalysis, stopAnalysis } = await freshAnalyser("running");
    startAnalysis();
    stopAnalysis();
    startAnalysis();
    expect(lastCtx.createMediaElementSource).toHaveBeenCalledTimes(2);
  });
});

describe("resume", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("un-suspends a suspended context", async () => {
    const { startAnalysis, resume } = await freshAnalyser("suspended");
    startAnalysis(); // creates the context

    resume();

    expect(lastCtx.resume).toHaveBeenCalled();
    expect(lastCtx.state).toBe("running");
  });

  // iOS parks the context in "interrupted" (not "suspended") after a lock screen
  // or phone call. Matching only the spec's "suspended" left the visualizer dead
  // on return; the analyser must come back once the user is.
  it("un-suspends a context left interrupted by iOS", async () => {
    const { startAnalysis, resume } = await freshAnalyser("interrupted");
    startAnalysis();

    resume();

    expect(lastCtx.resume).toHaveBeenCalled();
    expect(lastCtx.state).toBe("running");
  });

  it("leaves an already-running context alone", async () => {
    const { startAnalysis, resume } = await freshAnalyser("running");
    startAnalysis();

    resume();

    expect(lastCtx.resume).not.toHaveBeenCalled();
  });

  it("is a no-op when no context exists yet", async () => {
    const { resume } = await freshAnalyser();

    resume();

    expect(lastCtx).toBeUndefined();
  });
});
