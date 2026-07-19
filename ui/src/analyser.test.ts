import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { bandEdges, nextSeekAhead } from "./analyser";

// Some clock-lock tests spy on performance.now; restore so no spy leaks across tests.
afterEach(() => vi.restoreAllMocks());

// nextSeekAhead is the pure core of the visualizer's clock-lock: it learns how far
// AHEAD of the player each correcting seek must aim so that, after the element
// re-buffers, it lands aligned instead of recreating the same lag. playbackRate is
// deliberately never used (WebKit stalls/silences a tapped element under any
// sustained off-rate), so this learned aim is the whole convergence mechanism.
describe("nextSeekAhead", () => {
  it("aims further ahead when the element settled behind (negative error)", () => {
    expect(nextSeekAhead(0, -0.4)).toBeCloseTo(0.4);
    expect(nextSeekAhead(0.4, -0.1)).toBeCloseTo(0.5);
  });
  it("aims less far ahead after overshooting (positive error)", () => {
    expect(nextSeekAhead(0.4, 0.15)).toBeCloseTo(0.25);
  });
  it("never aims backwards and caps the aim below the resync limit", () => {
    expect(nextSeekAhead(0.1, 0.5)).toBe(0);
    // The cap must stay under RESYNC_LIMIT_S (1s): right after a correction the
    // element sits ~aim AHEAD, and an aim past the limit would re-trigger the
    // snap branch every frame — a seek storm.
    expect(nextSeekAhead(0.7, -5)).toBe(0.8);
  });
  it("keeps the previous aim on a non-finite error (currentTime read before load)", () => {
    expect(nextSeekAhead(0.3, NaN)).toBe(0.3);
    expect(nextSeekAhead(0.3, Infinity)).toBe(0.3);
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
  // Every playbackRate assignment is recorded: the clock-lock must NEVER touch the
  // rate (any sustained off-rate stalls/silences a tapped element on WebKit — the
  // "bars go to zero / never in sync" bug), so tests assert zero writes.
  rateWrites: number[] = [];
  private _rate = 1;
  get playbackRate(): number {
    return this._rate;
  }
  set playbackRate(v: number) {
    this._rate = v;
    this.rateWrites.push(v);
  }
  // The clock-lock only corrects while the element is settled and consuming data.
  readyState = 4;
  HAVE_FUTURE_DATA = 3;
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

// Stand-in for AudioBufferSourceNode — records the sample-accurate start offset.
class MockBufferSource {
  buffer: unknown = null;
  started: Array<[number, number]> = [];
  connect = vi.fn();
  disconnect = vi.fn();
  stop = vi.fn();
  start = vi.fn((when: number, offset: number) => {
    this.started.push([when, offset]);
  });
}
let lastBufSource: MockBufferSource | undefined;

class MockAudioContext {
  state: CtxState = "suspended";
  destination = {};
  currentTime = 0; // tests advance this to simulate the audio clock ticking
  createMediaElementSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() }));
  // Decode result: a fake 300s track. getChannelData returns a tiny array — the
  // module only copies it, length/duration are what matter.
  decodeAudioData = vi.fn(async () => ({
    length: 300 * 44100,
    sampleRate: 44100,
    duration: 300,
    getChannelData: () => new Float32Array(8),
  }));
  createBuffer = vi.fn((_ch: number, length: number, sampleRate: number) => ({
    length,
    sampleRate,
    duration: length / sampleRate,
    copyToChannel: vi.fn(),
    getChannelData: () => new Float32Array(8),
  }));
  createBufferSource = vi.fn(() => {
    lastBufSource = new MockBufferSource();
    return lastBufSource;
  });
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
  lastBufSource = undefined;
  vi.stubGlobal("window", { AudioContext: MockAudioContext });
  vi.stubGlobal("Audio", MockAudio);
  // The background track decode fetches the stream URL; tests opt into a working
  // fetch explicitly — by default it fails fast and the element tap stays.
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("no network in tests"))));
  return import("./analyser");
}

// The track decode runs as a background async chain; a couple of macrotask turns
// let it finish (or fail) deterministically.
async function flushDecode() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function stubFetchOk() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })),
  );
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

  // The WebKit pin: ANY playbackRate manipulation stalls/silences a tapped
  // element (varispeed can go silent; the time-stretcher stalls every ~12s under
  // a sustained off-rate — both measured). The clock-lock must never write it.
  it("never writes playbackRate, whatever the offset does", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false });

    syncAnalysis(main); // cold start
    lastAudio.currentTime = 9.5; // behind
    nowMs = 5000;
    syncAnalysis(main); // correction (a seek)
    main.currentTime = 60; // user seek
    syncAnalysis(main); // immediate snap
    for (let i = 0; i < 10; i++) syncAnalysis(main);

    expect(lastAudio.rateWrites.length).toBe(0);
    expect(lastAudio.playbackRate).toBe(1);
  });

  // The core of the lock: a naive seek re-buffers into the same lag, so each
  // correction aims AHEAD by the loss learned from where the last one landed.
  it("learns the re-buffer loss and aims the next correction ahead by it", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false });
    syncAnalysis(main); // cold start: anchors at main's position (nothing learned yet)
    expect(lastAudio.currentTime).toBe(10);

    // The element buffered and landed 0.4s behind; both now advance at 1.0.
    main.currentTime = 12;
    lastAudio.currentTime = 11.6;
    nowMs = 1000; // still inside the settle window — must not chase the transient
    syncAnalysis(main);
    expect(lastAudio.currentTime).toBe(11.6);

    nowMs = 2000; // settled: fold the 0.4s loss into the aim and re-anchor ahead
    syncAnalysis(main);
    expect(lastAudio.currentTime).toBeCloseTo(12.4);
  });

  // WebKit regression pin: while the element re-buffers after a correction its
  // clock sits frozen at the seek target while main advances toward it, so err
  // transiently passes THROUGH the lock window. That pass-through must not end
  // the learning session, or the landing is never measured and the lock
  // re-anchors uncompensated forever (measured live: 60 seeks, stuck -320ms).
  it("still learns the landing when err passes through the lock window mid-rebuffer", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false });
    syncAnalysis(main); // cold start

    // Mid-rebuffer pass-through: frozen element clock ≈ main clock for a frame.
    main.currentTime = 10.5;
    lastAudio.currentTime = 10.5;
    nowMs = 500; // inside the settle window
    syncAnalysis(main);

    // The real landing: 0.4s behind once playback resumes. Must still be learned.
    main.currentTime = 12;
    lastAudio.currentTime = 11.6;
    nowMs = 2000;
    syncAnalysis(main);
    expect(lastAudio.currentTime).toBeCloseTo(12.4);
  });

  it("leaves a settled element completely alone inside the lock tolerance", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false });
    syncAnalysis(main);

    main.currentTime = 12;
    lastAudio.currentTime = 11.93; // 70ms behind — within ±100ms, locked
    nowMs = 10000;
    syncAnalysis(main);
    expect(lastAudio.currentTime).toBe(11.93); // untouched: no seek, no rate write
    expect(lastAudio.rateWrites.length).toBe(0);
  });

  it("does not correct while the element is still buffering (readyState low)", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false });
    syncAnalysis(main);

    main.currentTime = 12;
    lastAudio.currentTime = 11.5; // 0.5s behind…
    lastAudio.readyState = 2; // …but mid-rebuffer: measuring now reads a transient
    nowMs = 10000;
    syncAnalysis(main);
    expect(lastAudio.currentTime).toBe(11.5); // wait, don't seek-loop
  });

  it("snaps promptly when the main element seeks, bypassing the settle window", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false });
    syncAnalysis(main);

    nowMs = 400; // inside the settle window, past the snap cooldown
    main.currentTime = 40; // user seeked +30s — a real jump, nothing to learn
    syncAnalysis(main);
    expect(lastAudio.currentTime).toBe(40);
  });

  it("rate-limits hard snaps so a >1s landing can never become a per-frame seek storm", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false });
    syncAnalysis(main);

    nowMs = 400;
    main.currentTime = 40;
    syncAnalysis(main); // snap #1
    // The element stalls right back >1s out; frames keep coming inside the cooldown.
    lastAudio.currentTime = 38;
    nowMs = 450;
    syncAnalysis(main);
    nowMs = 500;
    syncAnalysis(main);
    expect(lastAudio.currentTime).toBe(38); // no per-frame re-seek

    nowMs = 700; // cooldown over — one retry is allowed
    syncAnalysis(main);
    expect(lastAudio.currentTime).toBe(40);
  });

  // The poisoning pin: an error that appears while the clock was LOCKED (a small
  // user scrub, a main-element stall) is external — folding it into the aim
  // inflated or wiped the learned compensation. External drift gets a plain
  // re-anchor with the aim intact; only our own correction's landing is learned.
  it("does not learn from external drift — a small scrub keeps the learned aim", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false });
    syncAnalysis(main); // cold start

    // Landing measured 0.4s behind → aim learns 0.4.
    main.currentTime = 12;
    lastAudio.currentTime = 11.6;
    nowMs = 2000;
    syncAnalysis(main);
    expect(lastAudio.currentTime).toBeCloseTo(12.4);

    // It settles into lock — the learning session is over.
    main.currentTime = 14;
    lastAudio.currentTime = 14.02;
    nowMs = 4000;
    syncAnalysis(main);

    // A 0.5s scrub: re-anchor aims player + the PRESERVED 0.4 aim, not 0.9.
    main.currentTime = 14.5;
    lastAudio.currentTime = 14.02;
    nowMs = 6000;
    syncAnalysis(main);
    expect(lastAudio.currentTime).toBeCloseTo(14.9);
  });

  it("resumes from pause aimed at the player exactly — buffered data loses nothing", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false });
    syncAnalysis(main); // cold start

    // Learn a nonzero aim first.
    main.currentTime = 12;
    lastAudio.currentTime = 11.6;
    nowMs = 2000;
    syncAnalysis(main);

    // Pause, then resume: the element is buffered (readyState 4), so it must NOT
    // aim 0.4 ahead — that would overshoot and then wipe the learned aim.
    (main as { paused: boolean }).paused = true;
    syncAnalysis(main);
    expect(lastAudio.pause).toHaveBeenCalled();
    (main as { paused: boolean }).paused = false;
    main.currentTime = 12.5;
    nowMs = 4000;
    syncAnalysis(main);
    expect(lastAudio.currentTime).toBe(12.5);
  });
});

// The decoded-buffer tap: once the track is fetched + decoded, the streaming
// element (whose reported clock LIES about the FFT's audio after WebKit mp3
// seeks — measured 0.7-1.1s) is released and an AudioBufferSourceNode with
// SAMPLE-ACCURATE positioning takes over.
describe("decoded-buffer tap", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("switches from the element to the buffer once the decode lands, and releases the stream", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    stubFetchOk();
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false });

    syncAnalysis(main); // element tap starts streaming; decode kicks off
    expect(lastAudio.src).toBe("/api/songs/7/stream");
    await flushDecode();

    lastCtx.currentTime = 5;
    main.currentTime = 20;
    nowMs = 5000;
    syncAnalysis(main); // decode is ready — switch taps
    expect(lastAudio.removeAttribute).toHaveBeenCalledWith("src"); // stream released
    expect(lastBufSource).toBeDefined();
    expect(lastBufSource!.started).toEqual([[0, 20]]); // sample-accurate at the player position
  });

  it("leaves a tracking buffer alone and re-anchors it on a player seek", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    stubFetchOk();
    let nowMs = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false });
    syncAnalysis(main);
    await flushDecode();
    nowMs = 2000;
    syncAnalysis(main); // buffer starts at 10 (ctx time 0)
    const first = lastBufSource!;

    // Both clocks advance in step: position tracks exactly, no restart.
    lastCtx.currentTime = 30;
    main.currentTime = 40;
    nowMs = 3000;
    syncAnalysis(main);
    expect(lastBufSource).toBe(first);
    expect(first.started).toHaveLength(1);

    // Player seeks +60s: restart exactly there.
    main.currentTime = 100;
    nowMs = 4000;
    syncAnalysis(main);
    expect(lastBufSource).not.toBe(first);
    expect(lastBufSource!.started).toEqual([[0, 100]]);
  });

  it("pauses with the player and resumes at the player's position", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    stubFetchOk();
    let nowMs = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false });
    syncAnalysis(main);
    await flushDecode();
    nowMs = 2000;
    syncAnalysis(main);
    const playingSource = lastBufSource!;

    (main as { paused: boolean }).paused = true;
    syncAnalysis(main);
    expect(playingSource.stop).toHaveBeenCalled();

    (main as { paused: boolean }).paused = false;
    main.currentTime = 12;
    nowMs = 3000;
    syncAnalysis(main);
    expect(lastBufSource!.started).toEqual([[0, 12]]);
  });

  it("keeps the element tap when the decode fails", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    // default fetch stub rejects
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false });
    syncAnalysis(main);
    await flushDecode();
    syncAnalysis(main);
    expect(lastBufSource).toBeUndefined();
    expect(lastAudio.src).toBe("/api/songs/7/stream"); // element still serving the FFT
  });

  it("attempts a failed decode only once — no per-frame refetch storm", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false });
    syncAnalysis(main);
    await flushDecode(); // the one attempt fails (default rejecting fetch)
    syncAnalysis(main);
    syncAnalysis(main);
    syncAnalysis(main);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses to decode very long tracks — the element tap serves them", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    stubFetchOk();
    startAnalysis();
    const main = mainEl({
      currentSrc: "/api/songs/7/stream",
      currentTime: 10,
      paused: false,
      duration: 60 * 60, // an hour-long set would decode to hundreds of MB
    });
    syncAnalysis(main);
    await flushDecode();
    syncAnalysis(main);
    expect(fetch).not.toHaveBeenCalled();
    expect(lastBufSource).toBeUndefined();
    expect(lastAudio.src).toBe("/api/songs/7/stream");
  });

  it("drops the old track's buffer the moment the player changes track", async () => {
    const { startAnalysis, syncAnalysis } = await freshAnalyser("running");
    stubFetchOk();
    let nowMs = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false });
    syncAnalysis(main);
    await flushDecode();
    nowMs = 2000;
    syncAnalysis(main); // buffer tap live for song 7
    const oldSource = lastBufSource!;

    // Player advances to the next track: the stale source must stop feeding the
    // FFT immediately, and the element must take over streaming the new song.
    (main as { currentSrc: string }).currentSrc = "/api/songs/8/stream";
    main.currentTime = 0;
    nowMs = 3000;
    syncAnalysis(main);
    expect(oldSource.stop).toHaveBeenCalled();
    expect(lastAudio.src).toBe("/api/songs/8/stream"); // element bridges the new track
  });

  it("drops the decoded PCM on stopAnalysis so a closed visualizer costs nothing", async () => {
    const { startAnalysis, syncAnalysis, stopAnalysis } = await freshAnalyser("running");
    stubFetchOk();
    let nowMs = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false });
    syncAnalysis(main);
    await flushDecode();
    nowMs = 2000;
    syncAnalysis(main);
    const src = lastBufSource!;

    stopAnalysis();
    expect(src.stop).toHaveBeenCalled();
    // Reopening decodes afresh (buffer was released, not cached).
    startAnalysis();
    (fetch as ReturnType<typeof vi.fn>).mockClear();
    syncAnalysis(mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false }));
    expect(fetch).toHaveBeenCalled();
  });
});

describe("analysis lead (content-alignment knob)", () => {
  beforeEach(() => vi.unstubAllGlobals());

  // contentAlign measures how far the FFT's real content sits from the player's
  // clock (WebKit mp3 seeks land away from the reported position) and cancels it
  // via this lead: corrections then aim player + lead (+ learned re-buffer aim).
  it("corrections aim ahead by the lead set via setAnalysisLead", async () => {
    const { startAnalysis, syncAnalysis, setAnalysisLead } = await freshAnalyser("running");
    let nowMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    startAnalysis();
    const main = mainEl({ currentSrc: "/api/songs/7/stream", currentTime: 10, paused: false });
    syncAnalysis(main); // cold start, lead 0 → anchors at 10

    // Let the lock settle into a genuine lock first (ends the learning session).
    main.currentTime = 12;
    lastAudio.currentTime = 12;
    nowMs = 2000;
    syncAnalysis(main);

    // contentAlign discovers the content runs 1s in the past → lead 1.0. The
    // resulting err is external drift: re-anchored with the aim left alone.
    setAnalysisLead(1.0);
    nowMs = 4000;
    syncAnalysis(main);
    expect(lastAudio.currentTime).toBeCloseTo(13); // player + 1.0 lead, + 0 aim
  });

  it("clamps the lead to a sane range and ignores non-finite values", async () => {
    const { setAnalysisLead, analysisLead } = await freshAnalyser("running");
    setAnalysisLead(5);
    expect(analysisLead()).toBe(2);
    setAnalysisLead(-3);
    expect(analysisLead()).toBe(-0.5);
    setAnalysisLead(NaN);
    expect(analysisLead()).toBe(-0.5); // unchanged
    setAnalysisLead(0.8);
    expect(analysisLead()).toBe(0.8);
  });
});

describe("startAnalysis leaves pitch preservation alone", () => {
  beforeEach(() => vi.unstubAllGlobals());

  // Regression pin: preservesPitch=false put WebKit's varispeed path in play, which
  // can go SILENT while currentTime advances — read as a dead tap, flipping the
  // visualizer to synthetic bars on iPad. The default (true) must stay untouched.
  it("does not set preservesPitch or webkitPreservesPitch", async () => {
    const { startAnalysis } = await freshAnalyser("running");
    startAnalysis();
    const el = lastAudio as unknown as Record<string, unknown>;
    expect(el.preservesPitch).toBeUndefined();
    expect(el.webkitPreservesPitch).toBeUndefined();
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
