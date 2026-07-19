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
    // NOTE: preservesPitch is deliberately left at its default (true). Setting it
    // false looked attractive (a clean resample instead of a time-stretch while the
    // clock-lock trims the rate), but on WebKit the varispeed path it selects can go
    // SILENT while currentTime keeps advancing — exactly the "clock advancing,
    // spectrum flat" signature the dead-tap detector reads as a dead tap, which
    // flipped the whole visualizer to synthetic bars on iPad. At the lock's ±6% max
    // trim, pitch-corrected vs. resampled audio is indistinguishable on 28 log
    // bands, so the flag bought nothing and cost the feature. Do not reintroduce it.
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

// ANALYSIS_LEAD_S is the target offset (analysisEl.currentTime − main.currentTime)
// the soft clock-lock drives to. 0 means the bars ride the same media position the
// player's clock reports. It is an on-device-tunable perceptual knob (cf.
// KaraokeView's SWEEP_LEAD): raise it slightly if the bars ever feel late against
// what you hear (e.g. to compensate a device's own audible output latency). Keep it
// magnitude-agnostic — do NOT bake in a measured device offset here.
const ANALYSIS_LEAD_S = 0;
// Beyond this the offset is a seek or track change, not startup drift, so snap the
// element hard to re-anchor. Deliberately generous: a Bluetooth/AirPods output
// latency can legitimately sit a few hundred ms out, and that must be trimmed by
// rate (below), never turned into a constant re-seek that flattens the FFT.
const RESYNC_LIMIT_S = 1.0;
const RATE_TRIM_MAX = 0.06; // cap the soft-lock nudge at ±6% (inaudible; gain-0 element)
const RATE_GAIN = 2; // proportional gain mapping the offset error (s) → rate trim
// Inside this offset the clock is "locked": the target rate is exactly 1.0 and no
// correction runs. ±50ms is invisible on a spectrum meter, and the deadband is what
// lets playbackRate SIT at 1.0 instead of being rewritten every frame — WebKit
// reconfigures the media pipeline on rate writes, and a 60Hz stream of them is how
// the analysis element ended up stalling (silent tap → synthetic bars) on iPad.
const RATE_DEADBAND_S = 0.05;
// Correction rates are quantized to this step so consecutive frames of a converging
// err compute the SAME value, letting the write-on-change guard in syncAnalysis skip
// the assignment. Coarse on purpose: a correction episode should write playbackRate
// a handful of times, not 60 times a second.
const RATE_QUANTUM = 0.01;

// rateTrim maps a clock-offset error (seconds; negative = analysis element behind
// the player) to the playbackRate delta that closes it: behind → speed up
// (positive), ahead → slow down. Clamped to ±RATE_TRIM_MAX, and NaN-safe: a
// non-finite error (e.g. currentTime read before load) yields 0 so playbackRate is
// never assigned a non-finite value — that throws a TypeError, and since the
// visualizer's rAF loop calls syncAnalysis unguarded, one throw would cancel the
// loop and freeze the bars. Pure so the sign/convergence is unit-tested without a
// live media element.
export function rateTrim(errSeconds: number): number {
  if (!Number.isFinite(errSeconds)) return 0;
  return Math.max(-RATE_TRIM_MAX, Math.min(RATE_TRIM_MAX, -errSeconds * RATE_GAIN));
}

// targetRate is the rate the clock-lock wants the analysis element to run at for a
// given offset error: exactly 1 inside the deadband (locked — nothing to do), else
// 1 + rateTrim(err) snapped to RATE_QUANTUM steps. Quantizing makes the value
// stable across consecutive frames so syncAnalysis's write-on-change guard turns a
// correction into a handful of playbackRate writes instead of one per frame. Pure,
// like rateTrim, so deadband/sign/quantization are unit-tested without media.
export function targetRate(errSeconds: number): number {
  if (!Number.isFinite(errSeconds) || Math.abs(errSeconds) < RATE_DEADBAND_S) return 1;
  return Math.round((1 + rateTrim(errSeconds)) / RATE_QUANTUM) * RATE_QUANTUM;
}

// The playbackRate value last written to the analysis element, or 0 when unknown
// (fresh element, or after a re-anchor forced a write). syncAnalysis only assigns
// el.playbackRate when the target differs from this — see RATE_DEADBAND_S above for
// why WebKit must not see per-frame rate writes. Nothing else ever writes the
// silent element's rate, so the cache cannot go stale.
let lastRateWritten = 0;

// Count of hard re-anchors (seeks) syncAnalysis has performed; diagnostic only. A
// steadily climbing value means the clock-lock is thrashing (seek → re-buffer →
// big offset → seek …) instead of converging.
let hardSeeks = 0;

function setRate(el: HTMLMediaElement, rate: number): void {
  if (rate === lastRateWritten) return;
  el.playbackRate = rate;
  lastRateWritten = rate;
}

// syncAnalysis mirrors the audible element onto the silent analysis element: same
// source, same play/pause, and — via a soft clock-lock — the same position. Called
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
    lastRateWritten = 0; // assigning src triggers load(), which resets playbackRate
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
    lastRateWritten = 0; // force the write: re-anchor cleanly at rate 1
    setRate(el, 1); // the clock-lock re-trims from the next frame
    void el.play().catch(() => {});
    return;
  }
  // Soft clock-lock. The analysis element starts a few hundred ms BEHIND the main
  // element — it must buffer and start playing while main keeps advancing — and,
  // once both run at rate 1.0, that startup offset is otherwise frozen, so the bars
  // render audio a fixed lag in the past (measured ~244 ms). A hard seek can't cure
  // it: seeking re-buffers and recreates the very same lag. So nudge the *silent*
  // element's playbackRate to drive the offset to ANALYSIS_LEAD_S, then hold at 1.0.
  // A large offset (a real seek or track change) is snapped hard instead; small
  // residuals are trimmed by rate. Magnitude-agnostic, so it works whatever the
  // device's true offset is (Bluetooth latency, a slower decode, etc.).
  const err = el.currentTime - main.currentTime - ANALYSIS_LEAD_S;
  if (Math.abs(err) > RESYNC_LIMIT_S) {
    try {
      el.currentTime = main.currentTime + ANALYSIS_LEAD_S;
    } catch { /* not seekable yet */ }
    hardSeeks++;
    setRate(el, 1);
  } else {
    // err < 0 → element is behind → targetRate > 1 → play faster to catch up (and
    // vice versa); exactly 1 inside the deadband. setRate skips the assignment when
    // the value is unchanged, so WebKit sees a stable rate, not a 60Hz write stream.
    setRate(el, targetRate(err));
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
  lastRateWritten = 0; // the next element starts fresh; don't inherit this one's rate
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

// analysisDebug returns a one-line snapshot of the analysis element's state for the
// vizdebug console trace (see VisualizerView). Diagnostic only — never parsed.
export function analysisDebug(): string {
  const el = analysisEl;
  if (!el) return "el=none";
  return (
    `t=${el.currentTime.toFixed(3)} rs=${el.readyState} paused=${el.paused} ` +
    `rate=${el.playbackRate.toFixed(2)} seeks=${hardSeeks}`
  );
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
