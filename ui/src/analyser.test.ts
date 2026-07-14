import { describe, it, expect, beforeEach, vi } from "vitest";
import { bandEdges } from "./analyser";

// A minimal, controllable AudioContext mock. state is flipped manually so tests
// can reproduce the suspended -> running transition that resume() triggers
// asynchronously in a real browser.
let lastCtx: MockAudioContext;
let lastAnalyser: MockAnalyser;

// Fills a caller-provided Uint8Array in place, mirroring getByteFrequencyData.
type FreqFiller = (arr: Uint8Array) => void;
let freqFiller: FreqFiller = () => {}; // default: silence (all zero)

interface MockAnalyser {
  fftSize: number;
  smoothingTimeConstant: number;
  frequencyBinCount: number;
  connect: () => void;
  getByteFrequencyData: (arr: Uint8Array) => void;
}

class MockAudioContext {
  state: "suspended" | "running" = "suspended";
  destination = {};
  createMediaElementSource = vi.fn(() => ({ connect: vi.fn() }));
  resume = vi.fn();
  private listeners: Array<() => void> = [];

  constructor() {
    lastCtx = this; // capture the instance the module under test creates
    lastCtx.state = initialState;
  }

  sampleRate = 44100;
  createAnalyser(): MockAnalyser {
    lastAnalyser = {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 128,
      connect: vi.fn(),
      getByteFrequencyData: (arr: Uint8Array) => freqFiller(arr),
    };
    return lastAnalyser;
  }
  addEventListener(_type: "statechange", cb: () => void) {
    this.listeners.push(cb);
  }
  removeEventListener(_type: "statechange", cb: () => void) {
    this.listeners = this.listeners.filter((l) => l !== cb);
  }
  // Test helper: move to running and fire statechange, like a resolved resume().
  goRunning() {
    this.state = "running";
    for (const l of [...this.listeners]) l();
  }
}

let initialState: "suspended" | "running" = "suspended";

// Fresh module state per test (analyser.ts holds module-level singletons). The
// module creates the context itself; MockAudioContext's constructor captures the
// instance into lastCtx so the test can drive its state.
async function freshAnalyser(state: "suspended" | "running") {
  vi.resetModules();
  initialState = state;
  freqFiller = () => {}; // reset to silence unless a test opts in
  lastCtx = undefined as unknown as MockAudioContext; // no context created until attach() needs one
  vi.stubGlobal("window", { AudioContext: MockAudioContext });
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
    const { attach, bands } = await freshAnalyser("running");
    attach(el); // wires the analyser (ctx already running)
    freqFiller = (arr) => arr.fill(255, 60, 93); // energy across the upper audible bins

    const out = bands(28);
    expect(out[out.length - 1]).toBeGreaterThan(0); // the rightmost bar is reachable
  });

  it("keeps the last band dark when all energy is above the 16 kHz cap", async () => {
    const { attach, bands } = await freshAnalyser("running");
    attach(el);
    freqFiller = (arr) => arr.fill(255, 93); // only the near-silent >16 kHz region

    const out = bands(28);
    // The old code stretched the top band to Nyquist and read this dead range;
    // the cap deliberately excludes it, so the bar tracks audible content only.
    expect(out[out.length - 1]).toBe(0);
  });
});

const el = {} as HTMLMediaElement;

describe("attach", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("defers the tap while the context is suspended, then taps once it runs", async () => {
    const { attach, isAttached } = await freshAnalyser("suspended");

    attach(el);

    // The element must NOT be rerouted into a still-suspended (silent) graph.
    expect(lastCtx.createMediaElementSource).not.toHaveBeenCalled();
    expect(isAttached()).toBe(false);
    expect(lastCtx.resume).toHaveBeenCalled();

    // Once the context reaches running, the deferred tap fires exactly once.
    lastCtx.goRunning();
    expect(lastCtx.createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(lastCtx.createMediaElementSource).toHaveBeenCalledWith(el);
    expect(isAttached()).toBe(true);
  });

  it("taps immediately when the context is already running", async () => {
    const { attach, isAttached } = await freshAnalyser("running");

    attach(el);

    expect(lastCtx.createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(isAttached()).toBe(true);
  });

  it("does not stack statechange listeners across repeated frame-loop calls", async () => {
    const { attach } = await freshAnalyser("suspended");

    attach(el);
    attach(el);
    attach(el);

    // Three attach() calls while suspended must still tap exactly once when the
    // context starts (one pending element, one listener).
    lastCtx.goRunning();
    expect(lastCtx.createMediaElementSource).toHaveBeenCalledTimes(1);
  });

  it("is a no-op once tapped (element already routed)", async () => {
    const { attach } = await freshAnalyser("running");

    attach(el);
    attach({} as HTMLMediaElement); // a different element must be ignored
    expect(lastCtx.createMediaElementSource).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when passed a null element", async () => {
    const { attach, isAttached } = await freshAnalyser("running");

    attach(null);
    expect(lastCtx).toBeUndefined(); // no AudioContext even created for a null element
    expect(isAttached()).toBe(false);
  });
});
