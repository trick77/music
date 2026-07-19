// analyser.ts — a Web Audio AnalyserNode fed by a *dedicated, silent* <audio>
// element so the full-screen visualizer can read the real frequency spectrum
// WITHOUT ever touching the element the user actually hears.
//
// Why not tap the main element? createMediaElementSource() permanently pulls an
// element out of the browser's native output into our graph (it cannot be undone
// for that element's lifetime). On WebKit that reroute is audible: a short gap as
// it switches paths, and a changed tonal profile for the rest of the session,
// because Safari's Web Audio output path renders differently from native. Tapping
// a *copy* of the same element (HTMLMediaElement.captureStream) is unsupported on
// Safari. So the only non-destructive option — the documented MDN pattern — is to
// analyse a SEPARATE element and leave the audible one fully native.
//
// The analysis element streams the same track purely to feed the FFT. It is kept
// silent by routing the graph through a gain-0 node (NOT by muting the element —
// a muted element risks being decode-throttled on iOS, which would starve the
// analyser). It is created on startAnalysis() and torn down on stopAnalysis() so
// the second stream only runs while the visualizer is open.
//
// Everything is a guarded no-op when Web Audio is unavailable, so callers don't
// have to feature-detect. startAnalysis() reports whether the tap succeeded; the
// visualizer falls back to synthetic bars when it didn't (or when the analyser
// stays silent, e.g. iOS refusing to decode the second element).

let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let sink: GainNode | null = null; // gain-0 node that keeps the graph pulled but silent
let analysisEl: HTMLAudioElement | null = null; // the dedicated element we tap
let source: MediaElementAudioSourceNode | null = null;
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
    // The window music is mapped through: -25 dBFS is full height, -66 is zero.
    // These are measured, not guessed. Sampling getFloatFrequencyData over three
    // real tracks (metal / classic rock / ambient guitar) at 28 bands:
    //   - per-band peaks live in roughly -66..-25 dBFS, so the old -82 floor spent
    //     17 dB of the window on air. That squeezed every bar's real motion into
    //     the top third and left the bottom permanently lit — the "shimmering
    //     block" this window exists to fix. Narrowing 62 dB -> 41 dB multiplies
    //     each bar's swing by ~1.5x: measured off the rendered canvas on the worst
    //     case (a compressed metal master), a bar's swing goes 4 -> 6 of 18 cells
    //     and its permanently-lit floor 8 -> 6.
    //   - a band's energy only varies ~17-33 dB over time, which is why the span,
    //     not the ceiling, is the lever: peaks already reached the top before.
    // Kept deliberately conservative at the floor. -62 measured slightly livelier
    // but sits right at the cliff: a master only 4 dB quieter starts dropping
    // whole bands to permanent dark. -66 leaves that headroom and still lights
    // every band on all three tracks.
    // Still linear-in-dB and absolute (no per-band AGC), so a quiet passage stays
    // visibly quieter than a loud one instead of being auto-gained up to match.
    a.minDecibels = -66;
    a.maxDecibels = -25;
    // Route analyser -> gain(0) -> destination. The analyser only ever carries the
    // dedicated (silent-by-design) analysis element, so the graph output must be
    // silent; the gain-0 sink still lets `destination` pull the graph so the FFT
    // keeps updating. (An AnalyserNode not connected onward is not pulled.)
    const g = ctx.createGain();
    g.gain.value = 0;
    a.connect(g);
    g.connect(ctx.destination);
    freq = new Uint8Array(a.frequencyBinCount);
    analyser = a;
    sink = g;
    return a;
  } catch {
    return null;
  }
}

// startAnalysis builds the analysis graph and its dedicated <audio> element and
// taps it into the analyser. Returns true if the tap is live, false when Web
// Audio is unavailable (or the tap threw) — in which case the caller should show
// synthetic bars. Idempotent: a second call while already running is a no-op that
// re-reports success. syncAnalysis() then keeps the element in step with playback.
export function startAnalysis(): boolean {
  if (analysisEl) return true;
  const a = ensureAnalyser();
  if (!a || !ctx) return false;
  try {
    const el = new Audio();
    el.preload = "auto";
    el.crossOrigin = "anonymous"; // same-origin today, but explicit keeps the tap untainted
    const src = ctx.createMediaElementSource(el);
    src.connect(a);
    analysisEl = el;
    source = src;
    return true;
  } catch {
    // createMediaElementSource threw (e.g. the element was somehow already tapped).
    // Leave analysisEl null so the caller falls back to synthetic bars.
    return false;
  }
}

// syncAnalysis mirrors the audible element onto the silent analysis element: same
// source, same play/pause, same position (within a small drift tolerance). Called
// every frame while the visualizer is open. Reads truth straight off the main
// element so track changes and seeks are picked up without any extra plumbing.
//
// The main element is NEVER tapped here — this is the guarantee that keeps the
// audible path fully native (no gap, no tonal change, lock-screen audio intact).
export function syncAnalysis(main: HTMLMediaElement | null): void {
  const el = analysisEl;
  if (!el || !main) return;
  const src = main.currentSrc || main.src;
  if (!src) return;
  if (el.src !== src) {
    el.src = src;
    try {
      el.currentTime = main.currentTime;
    } catch {
      // metadata not loaded yet — the drift correction below will snap it once ready
    }
  }
  if (main.paused) {
    if (!el.paused) el.pause();
    return;
  }
  if (el.paused) {
    try {
      el.currentTime = main.currentTime;
    } catch { /* not seekable yet */ }
    void el.play().catch(() => {});
    return;
  }
  if (Math.abs(el.currentTime - main.currentTime) > 0.25) {
    try {
      el.currentTime = main.currentTime;
    } catch { /* not seekable yet */ }
  }
}

// stopAnalysis tears the analysis element down: pause it, unwire its source, and
// drop it so the second stream stops (no data cost while the visualizer is
// closed). The shared ctx/analyser/sink persist and are reused on the next open.
export function stopAnalysis(): void {
  if (source) {
    try {
      source.disconnect();
    } catch { /* already disconnected */ }
    source = null;
  }
  if (analysisEl) {
    try {
      analysisEl.pause();
      analysisEl.removeAttribute("src");
      analysisEl.load(); // release the network stream promptly
    } catch { /* best effort */ }
    analysisEl = null;
  }
}

// resume un-suspends the context. Browsers start it suspended until a user
// gesture; opening the visualizer is itself a gesture (a button/route tap).
//
// "interrupted" is a non-standard WebKit state used on iOS (e.g. after a lock or
// a phone call) that the spec's "suspended" doesn't cover, so it's matched here
// too. Note this only restores the analyser once the user is back — iOS refuses
// to resume an interrupted context while the screen is still locked. Since the
// audible element is never in this graph, that no longer affects playback at all.
export function resume(): void {
  const s = ctx?.state as AudioContextState | "interrupted" | undefined;
  if (ctx && (s === "suspended" || s === "interrupted")) void ctx.resume();
}

export function isAnalysing(): boolean {
  return analysisEl !== null;
}

// analysisTime reports the analysis element's playback position while it is
// actively playing, or -1 when it isn't running (no element, or paused/loading).
// The visualizer uses a *change* in this value between frames to tell "the tap is
// dead" (element advancing but analyser silent → real fallback needed) apart from
// "still loading/seeking" (not advancing yet → not a dead tap, just wait).
export function analysisTime(): number {
  return analysisEl && !analysisEl.paused ? analysisEl.currentTime : -1;
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
