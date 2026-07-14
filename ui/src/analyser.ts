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
    a.fftSize = 512; // 256 bins — enough low-end resolution once folded into ~24 bands
    a.smoothingTimeConstant = 0.8;
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
  const ratio = bins / minBin;
  for (let i = 0; i < count; i++) {
    const lo = Math.floor(minBin * Math.pow(ratio, i / count));
    const hi = Math.max(lo + 1, Math.floor(minBin * Math.pow(ratio, (i + 1) / count)));
    let sum = 0;
    let n = 0;
    for (let b = lo; b < hi && b < bins; b++) {
      sum += freq[b];
      n++;
    }
    out[i] = n ? sum / n / 255 : 0;
  }
  return out;
}
