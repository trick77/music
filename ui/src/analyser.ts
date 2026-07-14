// analyser.ts — a single Web Audio AnalyserNode tapping the shared <audio>
// element so the full-screen visualizer can read the real frequency spectrum.
//
// The graph is created lazily and the media element is tapped at most once
// (createMediaElementSource is permanent for an element's lifetime). Everything
// is a guarded no-op when Web Audio is unavailable, so callers can attach() on
// every rAF frame without checking support themselves.

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let sourceEl: HTMLMediaElement | null = null; // the element we've already tapped
let pendingEl: HTMLMediaElement | null = null; // element waiting for a running ctx to tap
let freq: Uint8Array<ArrayBuffer> | null = null;

function ensureAnalyser(): AnalyserNode | null {
  if (analyser) return analyser;
  const AC: typeof AudioContext | undefined =
    window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
    const a = ctx.createAnalyser();
    a.fftSize = 2048; // 1024 bins — plenty of resolution to give every band distinct bins
    // Low smoothing lets near-raw transients through so beats actually spike.
    // getByteFrequencyData applies this per call (once per rAF frame ~60fps), so a
    // high value (0.8) flattens a ~50ms kick before we ever read it; the visual
    // envelope is instead owned by ease() in VisualizerView.
    a.smoothingTimeConstant = 0.4;
    // Dynamic range tuned for music: without this, typical loud tracks peg most
    // bins at 255 (bars stuck at max). -20 dBFS maps to full height, -82 to zero.
    a.minDecibels = -82;
    a.maxDecibels = -20;
    a.connect(ctx.destination);
    freq = new Uint8Array(a.frequencyBinCount);
    analyser = a;
    return a;
  } catch {
    return null;
  }
}

// tapNow routes an element into the analyser. Only call once the context is
// running: createMediaElementSource pulls the element out of the browser's
// default output path, so doing it while the graph is still suspended (silent)
// leaves playback muted until resume() lands — an audible gap on first open.
function tapNow(el: HTMLMediaElement): void {
  if (!analyser || !ctx) return;
  try {
    ctx.createMediaElementSource(el).connect(analyser);
  } catch {
    // Throws if the element was already tapped (e.g. a prior mount). Either way
    // it's now routed through our graph, so record it and stop retrying.
  }
  sourceEl = el;
  pendingEl = null;
}

// attach taps a media element into the analyser exactly once. Safe to call every
// frame: a no-op when el is null, already tapped, or Web Audio is unavailable.
// Audio still reaches the speakers because the analyser is wired to destination.
//
// The tap is deferred until the context is running so the element is never
// rerouted into a suspended (silent) graph. If the context isn't running yet we
// kick resume() and register a one-time statechange listener to tap the moment
// it starts — this also covers the reduced-motion caller, which attaches once
// rather than on every frame.
export function attach(el: HTMLMediaElement | null): void {
  if (!el || sourceEl) return;
  const a = ensureAnalyser();
  if (!a || !ctx) return;
  void ctx.resume();
  if (ctx.state === "running") {
    tapNow(el);
    return;
  }
  if (pendingEl) return; // already waiting for the context to start
  pendingEl = el;
  const c = ctx;
  const onState = () => {
    if (c.state === "running" && pendingEl) {
      c.removeEventListener("statechange", onState);
      tapNow(pendingEl);
    }
  };
  c.addEventListener("statechange", onState);
}

// resume un-suspends the context. Browsers start it suspended until a user
// gesture; the play button already provided one before the visualizer opens.
export function resume(): void {
  if (ctx && ctx.state === "suspended") void ctx.resume();
}

export function isAttached(): boolean {
  return sourceEl !== null;
}

// bands folds the FFT bins into `count` log-spaced bands, normalized to 0..1.
// Returns all-zero when the analyser isn't ready or nothing has been tapped yet
// (so the visualizer idles flat instead of erroring).
export function bands(count: number): number[] {
  const out = new Array<number>(count).fill(0);
  if (!analyser || !freq) return out;
  analyser.getByteFrequencyData(freq);
  const bins = freq.length;
  const minBin = 1; // skip bin 0 (DC / sub-audible offset)
  // Log-spaced bands, but CONTIGUOUS: each band starts where the last ended and
  // spans at least one bin. A naive floor(pow()) makes the low bands collide on
  // the same bin (every left bar moves in unison); chaining from `prev` fixes it.
  let prev = minBin;
  for (let i = 0; i < count; i++) {
    let hi = Math.round(minBin * Math.pow(bins / minBin, (i + 1) / count));
    if (hi <= prev) hi = prev + 1;
    if (hi > bins) hi = bins;
    // Peak (max) rather than mean of the band's bins: a beat's energy is narrow,
    // and averaging it across a wide upper band (hundreds of bins at fftSize 2048)
    // dilutes the transient away. Max keeps the hi-hat/cymbal bands lively; low
    // bands span few bins so max≈mean there anyway.
    let peak = 0;
    for (let b = prev; b < hi; b++) {
      if (freq[b] > peak) peak = freq[b];
    }
    out[i] = peak / 255;
    prev = hi;
  }
  return out;
}
