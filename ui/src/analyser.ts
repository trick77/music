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

// attach taps a media element into the analyser exactly once. Safe to call every
// frame: a no-op when el is null, already tapped, or Web Audio is unavailable.
// Audio still reaches the speakers because the analyser is wired to destination.
//
// createMediaElementSource pulls the element out of the browser's default output
// and into our graph. Two consequences worth knowing before calling this from
// anywhere new:
//   1. On an *already-playing* element the reroute cuts the sound out for a
//      moment — the visible first-open equalizer stutter. Unavoidable here.
//   2. A tapped element goes SILENT on an iPhone lock screen: WebKit interrupts
//      the AudioContext and hands the hardware back to the system, so playback
//      dead-ends in the suspended graph (currentTime keeps advancing, sound
//      returns on unlock).
// (2) is much worse than (1), so only the visualizer taps, and only when opened.
// Never call this from the play path.
export function attach(el: HTMLMediaElement | null): void {
  if (!el || sourceEl) return;
  const a = ensureAnalyser();
  if (!a || !ctx) return;
  try {
    ctx.createMediaElementSource(el).connect(a);
  } catch {
    // Throws if the element was already tapped (e.g. a prior mount). Either way
    // it's now routed through our graph, so record it and stop retrying.
  }
  sourceEl = el;
}

// resume un-suspends the context. Browsers start it suspended until a user
// gesture; the play button already provided one before the visualizer opens.
//
// "interrupted" is a non-standard WebKit state used on iOS (e.g. after a lock or
// a phone call) that the spec's "suspended" doesn't cover, so it's matched here
// too. Note this only restores the analyser once the user is back — iOS refuses
// to resume an interrupted context while the screen is still locked. Keeping the
// play path untapped is what actually preserves lock-screen audio.
export function resume(): void {
  const s = ctx?.state as AudioContextState | "interrupted" | undefined;
  if (ctx && (s === "suspended" || s === "interrupted")) void ctx.resume();
}

export function isAttached(): boolean {
  return sourceEl !== null;
}

// bandEdges returns `count` contiguous [lo, hi) bin ranges, log-spaced from bin 1
// (bin 0 is DC / sub-audible offset). The top is capped at ~16 kHz, NOT Nyquist:
// the top few kHz are near-silent in real music and hard low-passed to zero by lossy
// codecs (MP3/AAC), which left the rightmost band permanently dark. Ranges are
// CONTIGUOUS — each starts where the last ended and spans at least one bin. A naive
// floor(pow()) makes the low bands collide on the same bin (every left bar moves in
// unison); chaining from `prev` plus the `hi <= prev` guard fixes it. Pure and
// side-effect free so the mapping is unit-testable without a live AnalyserNode.
export function bandEdges(count: number, bins: number, sampleRate: number): Array<[number, number]> {
  const minBin = 1;
  const nyquist = sampleRate / 2;
  const maxBin = Math.min(bins, Math.max(minBin + count, Math.round((16000 / nyquist) * bins)));
  const edges: Array<[number, number]> = [];
  let prev = minBin;
  for (let i = 0; i < count; i++) {
    let hi = Math.round(minBin * Math.pow(maxBin / minBin, (i + 1) / count));
    if (hi <= prev) hi = prev + 1;
    if (hi > maxBin) hi = maxBin;
    edges.push([prev, hi]);
    prev = hi;
  }
  return edges;
}

// Memoize the band boundaries: bands() runs once per rAF frame (~60fps) but
// count/bins/sampleRate never change within a session, so recomputing (and
// reallocating) the edges every frame is pure waste. bandEdges stays pure.
let edgeCache: { key: string; edges: Array<[number, number]> } | null = null;
function cachedEdges(count: number, bins: number, sampleRate: number): Array<[number, number]> {
  const key = `${count}:${bins}:${sampleRate}`;
  if (!edgeCache || edgeCache.key !== key) {
    edgeCache = { key, edges: bandEdges(count, bins, sampleRate) };
  }
  return edgeCache.edges;
}

// bands folds the FFT bins into `count` log-spaced bands, normalized to 0..1.
// Returns all-zero when the analyser isn't ready or nothing has been tapped yet
// (so the visualizer idles flat instead of erroring).
export function bands(count: number): number[] {
  const out = new Array<number>(count).fill(0);
  if (!analyser || !freq) return out;
  analyser.getByteFrequencyData(freq);
  const sampleRate = ctx?.sampleRate ?? 44100;
  const edges = cachedEdges(count, freq.length, sampleRate);
  for (let i = 0; i < count; i++) {
    const [lo, hi] = edges[i];
    // Peak (max) rather than mean of the band's bins: a beat's energy is narrow,
    // and averaging it across a wide upper band (hundreds of bins at fftSize 2048)
    // dilutes the transient away. Max keeps the hi-hat/cymbal bands lively; low
    // bands span few bins so max≈mean there anyway.
    let peak = 0;
    for (let b = lo; b < hi; b++) {
      if (freq[b] > peak) peak = freq[b];
    }
    out[i] = peak / 255;
  }
  return out;
}
