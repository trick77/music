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
    // NOTE: preservesPitch is deliberately left untouched, and this element's
    // playbackRate must NEVER be changed. Both WebKit off-rate paths are broken
    // for a tapped element: varispeed (preservesPitch=false) can go silent while
    // currentTime advances, and the time-stretcher (default) stalls the pipeline
    // every ~12s under a sustained off-rate — both read as a dead/flat tap and
    // ruined the visualizer on iPad. The clock-lock in syncAnalysis corrects with
    // rare compensated seeks instead. Do not reintroduce rate manipulation.
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

// analysisLeadS is the target offset (analysis position − main.currentTime) both
// tap modes drive to. 0 means the bars ride the player's reported position; a
// runtime-set positive lead would make them render slightly ahead (e.g. to
// compensate a device's audible output latency someday). Keep it runtime-set and
// magnitude-agnostic — do NOT bake in a measured device constant here.
let analysisLeadS = 0;

// Clamped: a small negative lead is legitimate (perceptual tuning), a large one
// is a broken caller.
export function setAnalysisLead(s: number): void {
  if (Number.isFinite(s)) analysisLeadS = Math.max(-0.5, Math.min(2, s));
}

export function analysisLead(): number {
  return analysisLeadS;
}
// Beyond this the offset is the main element seeking or changing track, not
// startup/rebuffer drift — snap promptly (rate-limited by SNAP_COOLDOWN_MS)
// instead of waiting out the settle window below.
const RESYNC_LIMIT_S = 1.0;
// Minimum spacing between hard snaps. Without it, an analysis element that lands
// or stalls >1s out would be re-seeked every rAF frame — each seek aborts the
// fetch, so the element never recovers (a 60Hz seek storm ending in the dead-tap
// fallback). A real user seek waits at most this long: imperceptible.
const SNAP_COOLDOWN_MS = 250;
// The clock is "locked" while |err| stays inside this. ±100ms is at the edge of
// perception for a spectrum meter; corrections only run beyond it so the lock
// converges in one or two seeks and then leaves the element completely alone.
const LOCK_TOLERANCE_S = 0.1;
// After any seek or source change, give the element this long to buffer and reach
// steady playback before measuring the offset again. Measuring mid-rebuffer reads
// a transient and would chase it with another seek — the seek-loop failure mode.
const SETTLE_MS = 1500;
// Upper bound on the learned seek-ahead compensation. MUST stay strictly below
// RESYNC_LIMIT_S: right after a correction the element sits ~seekAheadS AHEAD of
// the player (it hasn't re-buffered yet), and if that could exceed the resync
// limit every correction would immediately re-trigger the snap branch — a seek
// storm. A network that loses more than this per seek isn't rescued by aiming
// further ahead anyway.
const SEEK_AHEAD_MAX_S = 0.8;

// The clock-lock deliberately NEVER touches playbackRate. Both WebKit rate paths
// are broken for this use: varispeed (preservesPitch=false) can go silent while
// currentTime advances, and the time-stretcher (preservesPitch=true, the default)
// stalls the pipeline every ~12s under a sustained off-rate — measured against
// production on Playwright WebKit: the element pinned at 1.06 never converged
// (each stall threw it 200-500ms back) and the FFT dropped to zero at every stall.
// That was the "bars go to zero + never in sync" bug. Instead the element always
// runs at exactly 1.0 and the offset is corrected by RARE, COMPENSATED seeks:
// seek AHEAD of the player by the learned amount the element loses to re-buffering
// (seekAheadS), so it lands aligned when it starts advancing again. nextSeekAhead
// learns that amount: after a correction settles, whatever error remains is folded
// into the next aim. Pure, so convergence is unit-tested without a live element.
export function nextSeekAhead(prevS: number, errSeconds: number): number {
  if (!Number.isFinite(errSeconds)) return prevS;
  return Math.max(0, Math.min(SEEK_AHEAD_MAX_S, prevS - errSeconds));
}

// Count of hard re-anchors (seeks) syncAnalysis has performed; diagnostic only. A
// steadily climbing value means the clock-lock is thrashing (seek → re-buffer →
// big offset → seek …) instead of converging.
let hardSeeks = 0;

// The learned seek-ahead compensation (seconds) and the time of the last
// correction. seekAheadS persists across tracks — it models this session's
// network/decode latency, which doesn't change per song. pendingLearn marks that
// the next settled measurement is the LANDING of a correction this lock issued —
// only those errors feed nextSeekAhead. Errors that appear while the clock was
// locked (a small user scrub, the main element stalling) say nothing about our
// re-buffer loss; learning from them poisoned the aim, so those get a plain
// non-learning re-anchor and only their OWN landing is measured.
let seekAheadS = 0;
let lastCorrectionMs = 0;
let pendingLearn = false;

function correct(el: HTMLMediaElement, main: HTMLMediaElement, aheadS: number): void {
  try {
    el.currentTime = main.currentTime + analysisLeadS + aheadS;
    hardSeeks++;
  } catch { /* not seekable yet — retried next frame */ }
  lastCorrectionMs = performance.now();
  pendingLearn = true;
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
  // The buffer tap must never outlive its track: on a track change, drop the old
  // PCM (and any in-flight decode) immediately or the bars keep rendering the
  // PREVIOUS song while the new one decodes.
  if (trackBufUrl && trackBufUrl !== src) releaseTrackBuffer();
  // Kick the background decode; once it lands, the exact buffer tap takes over
  // and the streaming element (and all its WebKit failure modes) goes idle.
  ensureTrackBuffer(src, main.duration);
  if (trackBuf && trackBufUrl === src) {
    syncBuffer(main);
    // Release the element's stream only once a buffer source has actually
    // started — if startBufAt ever fails, the element remains the fallback
    // instead of leaving a silently dead tap.
    if (bufSource && el.src) {
      try {
        el.pause();
        el.removeAttribute("src");
        el.load(); // release the second network stream — the buffer has the track
      } catch { /* best effort */ }
    }
    if (bufSource || !el.src) return;
    // fall through: buffer ready but not started (paused, tail sliver, or a
    // failed start) while the element still holds the stream — element serves
  }
  if (el.src !== src) {
    el.src = src;
    try {
      el.currentTime = main.currentTime + analysisLeadS + seekAheadS;
    } catch {
      // metadata not loaded yet — the clock-lock below will correct once ready
    }
    lastCorrectionMs = performance.now(); // a src change re-buffers like a seek
    pendingLearn = true; // …and its landing is a real re-buffer loss worth learning
  }
  if (main.paused) {
    if (!el.paused) el.pause();
    return;
  }
  if (el.paused) {
    // A plain resume restarts from data already buffered at this position —
    // near-instant, nothing lost — so aim at the player exactly; aiming ahead here
    // would overshoot and then mislead the learning. Only a cold/unbuffered start
    // (low readyState) re-buffers and warrants the learned aim.
    correct(el, main, el.readyState >= el.HAVE_FUTURE_DATA ? 0 : seekAheadS);
    void el.play().catch(() => {});
    return;
  }
  // Clock-lock via rare, compensated seeks — playbackRate is deliberately never
  // touched (see nextSeekAhead above for the measured WebKit failures that rules
  // out). The element starts a few hundred ms behind the player (it buffers while
  // main keeps advancing) and a naive seek just re-buffers into the same lag; so
  // each correction aims AHEAD by seekAheadS, the loss learned from where previous
  // corrections actually landed. Between corrections the element runs untouched at
  // rate 1.0, and measurements wait out SETTLE_MS so a mid-rebuffer transient is
  // never chased (the seek-loop failure mode). A huge offset is the main element
  // seeking/changing track — snap immediately, nothing to learn from it.
  const err = el.currentTime - main.currentTime - analysisLeadS;
  if (!Number.isFinite(err)) return;
  const now = performance.now();
  if (Math.abs(err) <= LOCK_TOLERANCE_S) {
    // Locked — but only believe it once SETTLED. While the element re-buffers
    // after a correction its clock sits frozen at the seek target and main
    // advances toward it, so err transiently PASSES THROUGH the lock window;
    // clearing pendingLearn on that transient (measured on WebKit) meant the real
    // landing was never learned and the lock re-anchored uncompensated forever.
    // Once genuinely settled-and-locked, later drift (a scrub, a main stall) is
    // external — its magnitude says nothing about our re-buffer loss.
    if (now - lastCorrectionMs > SETTLE_MS) pendingLearn = false;
  } else if (Math.abs(err) > RESYNC_LIMIT_S) {
    // The main element seeked or changed track: snap, rate-limited so a landing
    // or stall this far out can never become a per-frame seek storm.
    if (now - lastCorrectionMs > SNAP_COOLDOWN_MS) correct(el, main, seekAheadS);
  } else if (now - lastCorrectionMs > SETTLE_MS && el.readyState >= el.HAVE_FUTURE_DATA) {
    // Settled yet off. If this error is the landing of our own correction
    // (pendingLearn), fold it into the aim — behind → aim further ahead next
    // time, ahead → aim less. External drift just gets re-anchored; the landing
    // of THAT correction is what gets measured.
    if (pendingLearn) seekAheadS = nextSeekAhead(seekAheadS, err);
    correct(el, main, seekAheadS);
  }
}

// stopAnalysis tears the whole tap down: the buffer source and its decoded PCM
// (tens of MB — released so a closed visualizer costs nothing), any in-flight
// decode, and the fallback element (so its stream stops). The shared
// ctx/analyser/sink persist and are reused on the next open.
export function stopAnalysis(): void {
  releaseTrackBuffer();
  decodeFailedUrl = null; // a fresh open may retry (transient failures heal)
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

// ---- decoded-buffer tap (the primary spectrum source) ----
//
// Streaming a second <audio> element into the analyser turned out to be a pit of
// WebKit failure modes: it cannot run off-rate (stalls/silence), and worse, its
// reported currentTime LIES about the audio feeding the FFT after a seek —
// byte-estimate mp3 seeking lands 0.7-1.1s away from the reported position
// (measured against production; error grows with position, so no learned offset
// can cancel it). Decoded PCM has none of that: an AudioBufferSourceNode starts
// at a SAMPLE-ACCURATE offset and its position derives from the AudioContext
// clock, which cannot drift from what the FFT actually hears. So once the track
// is fetched + decoded, the tap switches from the element to the buffer and the
// element goes idle. The element tap remains as the fallback until decode
// completes (or forever if decodeAudioData fails / Web Audio memory is tight).
let trackBuf: AudioBuffer | null = null;
let trackBufUrl: string | null = null;
let decodePending: string | null = null;
let decodeFailedUrl: string | null = null; // negative cache: one attempt per track
let decodeAbort: AbortController | null = null;
let decodeSeq = 0;
let bufSource: AudioBufferSourceNode | null = null;
let bufStartOffset = 0;
let bufStartCtxT = 0;
let lastBufStartMs = 0;

// Refuse to decode beyond this duration: a 60-minute set decodes to hundreds of
// MB of resident PCM — a guaranteed iOS jetsam. Long tracks keep the element tap.
const MAX_DECODE_DURATION_S = 15 * 60;

// Restart the buffer source when its position drifts this far from the player.
// Restarts are sample-accurate and cheap (no network, no decode), but the two
// clocks (AudioContext vs media element) tick on the same crystal for practical
// purposes, so this fires rarely — mostly on player seeks and track changes.
const BUF_DRIFT_S = 0.08;

function stopBufSource(): void {
  if (bufSource) {
    try {
      bufSource.stop();
      bufSource.disconnect();
    } catch { /* already stopped */ }
    bufSource = null;
  }
}

function bufPos(): number {
  if (!bufSource || !ctx) return -1;
  return bufStartOffset + (ctx.currentTime - bufStartCtxT);
}

function startBufAt(offsetS: number): void {
  if (!ctx || !analyser || !trackBuf) return;
  stopBufSource();
  try {
    const s = ctx.createBufferSource();
    s.buffer = trackBuf;
    s.connect(analyser);
    const off = Math.max(0, Math.min(trackBuf.duration, offsetS));
    s.start(0, off);
    bufSource = s;
    bufStartOffset = off;
    bufStartCtxT = ctx.currentTime;
  } catch { /* bufSource stays null — the dispatch keeps the element serving */ }
  lastBufStartMs = performance.now();
}

// releaseTrackBuffer drops the decoded PCM, any live source, and any in-flight
// decode. Called on track change and on stopAnalysis so a stale track can never
// keep feeding the FFT (and its tens of MB never outlive their use).
function releaseTrackBuffer(): void {
  stopBufSource();
  trackBuf = null;
  trackBufUrl = null;
  decodeSeq++; // invalidate any in-flight decode…
  decodeAbort?.abort(); // …and stop its download spending bandwidth
  decodeAbort = null;
  decodePending = null;
}

// ensureTrackBuffer fetches + decodes the track ONCE per URL, in the background.
// The decoded stereo buffer is folded to a mono mix (half the resident memory)
// and the original dropped. Any failure is memoized per URL — one attempt, no
// refetch storm — and leaves trackBuf null: the element tap keeps serving.
function ensureTrackBuffer(url: string, durationS: number): void {
  if (!ctx || trackBufUrl === url || decodePending === url || decodeFailedUrl === url) return;
  if (Number.isFinite(durationS) && durationS > MAX_DECODE_DURATION_S) {
    decodeFailedUrl = url; // too big to hold decoded — the element tap serves it
    return;
  }
  decodePending = url;
  const seq = ++decodeSeq;
  decodeAbort = new AbortController();
  const signal = decodeAbort.signal;
  void (async () => {
    try {
      const res = await fetch(url, { signal });
      if (seq !== decodeSeq) return;
      if (!res.ok) {
        decodeFailedUrl = url;
        return;
      }
      const raw = await res.arrayBuffer();
      if (seq !== decodeSeq || !ctx) return;
      const decoded = await ctx.decodeAudioData(raw);
      if (seq !== decodeSeq || !ctx) return;
      const ch0 = decoded.getChannelData(0);
      let mix = ch0;
      if (decoded.numberOfChannels > 1) {
        const ch1 = decoded.getChannelData(1);
        mix = new Float32Array(ch0.length);
        for (let i = 0; i < ch0.length; i++) mix[i] = (ch0[i] + ch1[i]) / 2;
      }
      const mono = ctx.createBuffer(1, decoded.length, decoded.sampleRate);
      mono.copyToChannel(mix, 0);
      trackBuf = mono;
      trackBufUrl = url;
      stopBufSource(); // re-anchored to the player on the next frame
    } catch {
      // decode refused / OOM / network — memoize so this track isn't re-attempted
      if (seq === decodeSeq) decodeFailedUrl = url;
    } finally {
      if (seq === decodeSeq) decodePending = null;
    }
  })();
}

// syncBuffer drives the buffer tap: mirror play/pause and keep the buffer
// position on the player's clock (+ analysisLeadS). Positioning is exact, so
// drift past the small window is re-anchored — but rate-limited, and only while
// the context clock is actually running: a suspended/interrupted ctx (iOS lock)
// freezes ctx.currentTime, and an unguarded drift check would then churn a new
// source every few frames. Same guard covers the main element stalling.
function syncBuffer(main: HTMLMediaElement): void {
  if (main.paused) {
    stopBufSource();
    return;
  }
  if (ctx && (ctx.state as string) !== "running") return;
  const target = main.currentTime + analysisLeadS;
  if (trackBuf && target >= trackBuf.duration) {
    // The decoded buffer can run slightly shorter than the streamed track (mp3
    // duration estimates). Don't churn restarts against the clamp at the tail —
    // idle flat for the last sliver until the track changes.
    stopBufSource();
    return;
  }
  const pos = bufPos();
  if (pos < 0 || Math.abs(pos - target) > BUF_DRIFT_S) {
    if (performance.now() - lastBufStartMs > 250) startBufAt(target);
  }
}

// analysisDebug returns a one-line snapshot of the tap's state for the vizdebug
// console trace (see VisualizerView). Diagnostic only — never parsed.
export function analysisDebug(): string {
  if (bufSource) return `mode=buf t=${bufPos().toFixed(3)} lead=${analysisLeadS.toFixed(3)}`;
  const el = analysisEl;
  if (!el) return "el=none";
  return (
    `mode=el t=${el.currentTime.toFixed(3)} rs=${el.readyState} paused=${el.paused} ` +
    `rate=${el.playbackRate.toFixed(2)} ahead=${seekAheadS.toFixed(3)} seeks=${hardSeeks} ` +
    `buf=${trackBuf ? "ready" : decodePending ? "decoding" : "none"}`
  );
}

// analysisTime reports the tap's playback position while it is actively playing,
// or -1 when it isn't running (nothing started, or paused/loading). The
// visualizer uses a *change* in this value between frames to tell "the tap is
// dead" (position advancing but analyser silent → real fallback needed) apart
// from "still loading/seeking" (not advancing yet → not a dead tap, just wait).
export function analysisTime(): number {
  if (bufSource) return bufPos();
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
