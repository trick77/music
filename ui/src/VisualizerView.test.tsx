import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  render as rtlRender,
  screen,
  act,
  cleanup,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Song } from "./api";
import type { Fav } from "./PlayerControls";

// VisualizerView reads the now-playing track from the player singleton and drives
// a canvas off the shared AnalyserNode — both side-effecting modules exercised via
// Playwright, not unit tests. Mock them so the render is deterministic and no
// audio/canvas is touched. A hoisted holder lets each test swap the current song,
// the AirPlay state, the audio element, and every analyser reading — which is what
// makes the animation loop's branches (starvation, give-up, synthetic fallback)
// reachable from a unit test at all.
const h = vi.hoisted(() => ({
  current: null as Song | null,
  airplayActive: false,
  audioEl: null as HTMLAudioElement | null,
  startAnalysis: vi.fn<() => boolean>(),
  stopAnalysis: vi.fn(),
  syncAnalysis: vi.fn(),
  analysisTime: vi.fn<() => number>(),
  analysisDebug: vi.fn<() => string>(),
  resume: vi.fn(),
  bands: vi.fn<(n: number) => number[]>(),
}));
vi.mock("./player", () => ({
  player: { getAudioElement: () => h.audioEl },
  usePlayer: () => ({
    current: h.current,
    queue: [],
    playing: false,
    positionMs: 0,
    durationMs: 0,
    airplayAvailable: false,
    airplayActive: h.airplayActive,
    play() {},
    toggle() {},
    stop() {},
    next() {},
    prev() {},
    seek() {},
    setQueue() {},
    remove() {},
    patchSong() {},
    showAirplayPicker() {},
  }),
}));
vi.mock("./analyser", () => ({
  startAnalysis: h.startAnalysis,
  stopAnalysis: h.stopAnalysis,
  syncAnalysis: h.syncAnalysis,
  analysisTime: h.analysisTime,
  analysisDebug: h.analysisDebug,
  resume: h.resume,
  bands: h.bands,
}));

// Restores the holder to the quiet defaults the static-markup tests below were
// written against: a live-but-silent tap, no audio element, no AirPlay.
beforeEach(() => {
  h.current = null;
  h.airplayActive = false;
  h.audioEl = null;
  h.startAnalysis.mockReset().mockReturnValue(true);
  h.stopAnalysis.mockReset();
  h.syncAnalysis.mockReset();
  h.resume.mockReset();
  h.analysisTime.mockReset().mockReturnValue(-1);
  h.analysisDebug.mockReset().mockReturnValue("el=none");
  h.bands.mockReset().mockImplementation((n: number) => new Array(n).fill(0));
  window.localStorage.clear();
});

import {
  VisualizerView,
  synthTargets,
  accrueStarvation,
  nextSynthetic,
  STARVE_LIMIT_MS,
  GIVE_UP_MS,
} from "./VisualizerView";

function song(over: Partial<Song> = {}): Song {
  return {
    id: "s1",
    title: "Nightbird",
    artistName: "Vesper Lake",
    album: "",
    year: 0,
    trackNo: 0,
    trackTotal: 0,
    durationMs: 200000,
    fileSize: 0,
    createdAt: "",
    sampleRate: 0,
    channels: 0,
    bitrateKbps: 0,
    genres: [],
    coverArtId: "",
    published: true,
    lyrics: "First line of the song\nSecond line here",
    ...over,
  };
}

// Static markup only — clicking through to the lyrics player is Playwright's job.
function render(current: Song | null) {
  h.current = current;
  return renderToStaticMarkup(
    <VisualizerView
      fav={{ has: () => false, toggle: () => {} }}
      onShare={() => {}}
    />,
  );
}

describe("VisualizerView control row", () => {
  it("when the visualizer is open, then it offers no lyrics button — the X is the way out", () => {
    // Nothing swaps views in place here: the visualizer is left via its X (or Esc).
    expect(render(song())).not.toContain('aria-label="Show lyrics"');
  });

  it("when the visualizer is open, then it always offers a close X", () => {
    expect(render(song())).toContain('aria-label="Close visualizer"');
  });

  // markup of a single element, so an assertion about one control can't be satisfied
  // (or broken) by another one sharing the row.
  function el(html: string, match: string, tag = "button") {
    const start = html.lastIndexOf("<" + tag, html.indexOf(match));
    return html.slice(start, html.indexOf("</" + tag + ">", start));
  }

  it("when a song is playing, then a divider separates transport from the actions", () => {
    const html = render(song());
    expect(html).toContain("data-divider");
    // On the cover scrim only the white tint survives; the app border token vanishes.
    const divider = el(html, "data-divider", "span");
    expect(divider).toContain("rgba(255,255,255,0.2)");
    expect(divider).not.toContain("var(--color-border)");
  });

  it("when nothing is playing, then the control row and its divider are gone", () => {
    const html = render(null);
    expect(html).toContain("Nothing is playing");
    expect(html).not.toContain("data-divider");
  });
});

describe("synthTargets (fallback bars when the real analyser can't run)", () => {
  it("is flat when paused — no motion without playback", () => {
    expect(synthTargets(1234, false).every((v) => v === 0)).toBe(true);
  });

  it("produces in-range, bass-weighted bars while playing", () => {
    const out = synthTargets(1000, true);
    expect(out).toHaveLength(28);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // Averaged over a full cycle the low columns should out-energise the top ones.
    const avg = (lo: number, hi: number) => {
      let sum = 0,
        n = 0;
      for (let t = 0; t < 6000; t += 100) {
        const f = synthTargets(t, true);
        for (let i = lo; i < hi; i++) {
          sum += f[i];
          n++;
        }
      }
      return sum / n;
    };
    expect(avg(0, 6)).toBeGreaterThan(avg(22, 28));
  });

  it("is deterministic for a given (t, playing)", () => {
    expect(synthTargets(777, true)).toEqual(synthTargets(777, true));
  });
});

describe("accrueStarvation (dead-tap detector for the synthetic fallback)", () => {
  const advancingSilent = { playing: true, advancing: true, hasSignal: false };

  it("accumulates only while the element advances but stays silent", () => {
    let ms = 0;
    ms = accrueStarvation(ms, 1000, advancingSilent);
    ms = accrueStarvation(ms, 1000, advancingSilent);
    expect(ms).toBe(2000);
  });

  it("trips the fallback once past the limit on a genuinely dead tap", () => {
    let ms = 0;
    for (let i = 0; i < 10; i++)
      ms = accrueStarvation(ms, 500, advancingSilent);
    expect(ms).toBeGreaterThan(STARVE_LIMIT_MS);
  });

  // The HIGH regression the review caught: a mid-track pause longer than the limit
  // used to permanently drop to synthetic bars on resume. Pausing must reset it.
  it("resets on pause, so resuming keeps the real spectrum", () => {
    let ms = accrueStarvation(0, 2000, advancingSilent); // silent while playing
    ms = accrueStarvation(ms, 60000, {
      playing: false,
      advancing: false,
      hasSignal: false,
    }); // long pause
    expect(ms).toBe(0);
  });

  // A slow cold open: the hidden element is still loading/seeking (clock not
  // advancing), which must not count as a dead tap.
  it("does not accumulate while the element is still loading (not advancing)", () => {
    let ms = 0;
    ms = accrueStarvation(ms, 4000, {
      playing: true,
      advancing: false,
      hasSignal: false,
    });
    expect(ms).toBe(0);
  });

  it("resets the moment any real signal appears", () => {
    let ms = accrueStarvation(0, 2000, advancingSilent);
    ms = accrueStarvation(ms, 16, {
      playing: true,
      advancing: true,
      hasSignal: true,
    });
    expect(ms).toBe(0);
  });
});

// nextSynthetic is the synthetic↔real transition: the old code latched synthetic
// permanently (one 3s stall ruined the session); now the fallback is recoverable.
describe("nextSynthetic (recoverable fallback, not a latch)", () => {
  it("stays real while starvation is under the limit", () => {
    expect(nextSynthetic(false, 0, 0.5)).toBe(false);
    expect(nextSynthetic(false, STARVE_LIMIT_MS, 0)).toBe(false); // at the limit, not past it
  });

  it("falls back once starvation crosses the limit", () => {
    expect(nextSynthetic(false, STARVE_LIMIT_MS + 1, 0)).toBe(true);
  });

  // THE fix: a transient stall (buffering, an iOS context interruption) must not
  // condemn the session — real signal returning flips the real spectrum back on.
  it("returns to the real spectrum the moment signal reappears", () => {
    expect(nextSynthetic(true, 5000, 0.5)).toBe(false);
  });

  it("stays synthetic while the tap remains silent", () => {
    expect(nextSynthetic(true, 5000, 0)).toBe(true);
    expect(nextSynthetic(true, 5000, 0.01)).toBe(true); // below the signal floor
  });

  it("keeps probing well past the fallback limit — only GIVE_UP_MS ends it", () => {
    // The give-up cap (handled in frame(), not here) is far beyond the fallback
    // threshold, so a slow recovery still gets its chance.
    expect(GIVE_UP_MS).toBeGreaterThan(STARVE_LIMIT_MS * 10);
    expect(nextSynthetic(true, GIVE_UP_MS - 1, 0.5)).toBe(false); // recoverable right up to it
  });
});

describe("VisualizerView tap-to-close", () => {
  it("when the visualizer renders, then its control band is marked no-dismiss", () => {
    // The band — not just the buttons — so a tap that misses pause by a few
    // pixels doesn't close the view. The rule itself lives in backgroundDismiss.
    expect(render(song())).toContain("data-player-ui");
  });
});

// ── Live rendering: the animation loop ─────────────────────────────────────────
// Everything above renders to static markup, which never runs effects — so the
// whole draw loop went untested. These mount for real. jsdom implements neither
// canvas nor rAF, so both are stubbed here (not in the shared setup, which the
// rest of the suite shares): the rAF stub CAPTURES the callback instead of
// invoking it, because frame() re-arms itself and an immediate-invoke stub would
// recurse until the stack blew.

type FakeCtx = {
  fillStyle: string;
  setTransform: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
};

let ctx: FakeCtx;
let frameCb: FrameRequestCallback | null;
let nowMs: number;
const cancelRaf = vi.fn();

// A stand-in for the audible <audio> element. Only `paused` and `currentTime` are
// read by the view, so the rest of HTMLAudioElement is irrelevant here.
function audio(
  over: { paused?: boolean; currentTime?: number } = {},
): HTMLAudioElement {
  return { paused: false, currentTime: 12.5, ...over } as HTMLAudioElement;
}

function mount(over: { fav?: Fav; onShare?: (s: Song) => void } = {}) {
  return rtlRender(
    <VisualizerView
      fav={over.fav ?? { has: () => false, toggle: () => {} }}
      onShare={over.onShare ?? (() => {})}
    />,
  );
}

// Advances the clock and runs exactly one animation frame. Frames are stepped by
// hand so a test can say precisely how much time passed — which is the only way
// the starvation and give-up thresholds are reachable in finite time.
function step(dtMs = 16) {
  nowMs += dtMs;
  act(() => {
    frameCb?.(nowMs);
  });
}

// How many cells the bars painted this frame. Silence draws nothing at all (no
// lit cells, no peak caps), so a non-zero count is direct evidence that the view
// is showing energy rather than an empty grid.
function cellsPainted() {
  return ctx.fillRect.mock.calls.length;
}

describe("VisualizerView animation loop", () => {
  beforeEach(() => {
    ctx = {
      fillStyle: "",
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
    };
    // The effect bails out entirely when getContext returns null, so this must be
    // a working stub rather than jsdom's not-implemented default.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );
    frameCb = null;
    cancelRaf.mockClear();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frameCb = cb;
      return 7;
    });
    vi.stubGlobal("cancelAnimationFrame", cancelRaf);
    // A non-zero base matters: dt is only accrued once lastFrameMs is truthy.
    nowMs = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("when the analyser reports a real spectrum, then the bars are painted from it", () => {
    h.current = song();
    h.audioEl = audio();
    h.bands.mockImplementation((n: number) => new Array(n).fill(0.8));

    mount();
    step();
    step();
    step();

    // The tap is read every frame and mirrored onto the hidden element, and the
    // energy actually reaches the canvas.
    expect(h.syncAnalysis).toHaveBeenCalledWith(h.audioEl);
    expect(h.bands).toHaveBeenCalled();
    expect(cellsPainted()).toBeGreaterThan(0);
  });

  it("when the analyser is silent, then nothing is painted rather than a floor of lit cells", () => {
    h.current = song();
    h.audioEl = audio();

    mount();
    step();
    step();

    // The bars must go genuinely dark on silence — a permanently lit bottom row
    // was the exact artefact the heat-mapped cell grid exists to avoid.
    expect(ctx.clearRect).toHaveBeenCalled();
    expect(cellsPainted()).toBe(0);
  });

  it("when Web Audio is unavailable, then it never taps and paints synthetic bars instead", () => {
    h.current = song();
    h.audioEl = audio();
    h.startAnalysis.mockReturnValue(false);

    mount();
    step();
    step();

    // With no tap there is nothing to read or mirror — but a playing track must
    // still look alive.
    expect(h.syncAnalysis).not.toHaveBeenCalled();
    expect(h.bands).not.toHaveBeenCalled();
    expect(cellsPainted()).toBeGreaterThan(0);
  });

  it("when Web Audio is unavailable and playback is paused, then the synthetic bars stay flat", () => {
    h.current = song();
    h.audioEl = audio({ paused: true });
    h.startAnalysis.mockReturnValue(false);

    mount();
    step();
    step();

    // Motion with no playback would be a lie about what the speakers are doing.
    expect(cellsPainted()).toBe(0);
  });

  it("when the tap starves past the limit while the clock advances, then it falls back to synthetic bars", () => {
    h.current = song();
    h.audioEl = audio();
    // An advancing analysis clock with a flat spectrum is the dead-tap signature:
    // the element is decoding, but nothing reaches the analyser.
    let t = 0;
    h.analysisTime.mockImplementation(() => (t += 0.5));

    mount();
    step(500);
    const beforeLimit = cellsPainted();
    step(STARVE_LIMIT_MS + 100);
    step(16);

    // Under the limit a brief silence is just silence; past it the view stops
    // pretending the dead tap is a quiet passage and shows synthetic motion.
    expect(beforeLimit).toBe(0);
    expect(cellsPainted()).toBeGreaterThan(0);
  });

  it("when real signal returns after a starved stretch, then the tap is kept and the real spectrum resumes", () => {
    h.current = song();
    h.audioEl = audio();
    let t = 0;
    h.analysisTime.mockImplementation(() => (t += 0.5));

    mount();
    step(16); // the first frame has no elapsed time to attribute, so prime it
    step(STARVE_LIMIT_MS + 100); // starve into the synthetic fallback
    h.bands.mockImplementation((n: number) => new Array(n).fill(0.9));
    step(16);
    const callsAfterRecovery = h.syncAnalysis.mock.calls.length;
    step(16);

    // The fallback is recoverable, not a latch: the second stream is never torn
    // down, so the real spectrum can come back.
    expect(h.stopAnalysis).not.toHaveBeenCalled();
    expect(h.syncAnalysis.mock.calls.length).toBeGreaterThan(
      callsAfterRecovery,
    );
  });

  it("when starvation runs unbroken past the give-up point, then the second stream is torn down for good", () => {
    h.current = song();
    h.audioEl = audio();
    let t = 0;
    h.analysisTime.mockImplementation(() => (t += 0.5));

    mount();
    step(16); // the first frame has no elapsed time to attribute, so prime it
    step(GIVE_UP_MS);
    step(2000); // pushes the unbroken total past the give-up point
    const syncCallsAtGiveUp = h.syncAnalysis.mock.calls.length;
    step(16);
    step(16);

    // A tap that never comes back would otherwise keep a second stream
    // downloading and decoding forever, spending data and battery on nothing.
    expect(h.stopAnalysis).toHaveBeenCalled();
    expect(h.syncAnalysis.mock.calls.length).toBe(syncCallsAtGiveUp);
  });

  it("when AirPlay is active, then the bars are suppressed and the reason is shown", () => {
    h.current = song();
    h.audioEl = audio();
    h.airplayActive = true;
    h.bands.mockImplementation((n: number) => new Array(n).fill(0.9));

    mount();
    step();
    step();

    // The sound is on a remote speaker, so there is nothing local to visualize —
    // drawing bars would be inventing a spectrum.
    expect(cellsPainted()).toBe(0);
    expect(screen.getByText("Playing on AirPlay")).toBeInTheDocument();
  });

  it("when the window is resized, then the backing store is rescaled for the new size", () => {
    h.current = song();

    mount();
    const initial = ctx.setTransform.mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    // Without this the canvas keeps the old device-pixel backing store and the
    // bars render blurred or clipped after a rotation.
    expect(ctx.setTransform.mock.calls.length).toBeGreaterThan(initial);
  });

  it("when the visualizer is closed, then it stops the frame loop, the tap and the resize listener", () => {
    h.current = song();

    const { unmount } = mount();
    step();
    unmount();
    const transformsAtUnmount = ctx.setTransform.mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    // Leaving the second stream running after the view closes is the leak this
    // teardown exists to prevent.
    expect(cancelRaf).toHaveBeenCalled();
    expect(h.stopAnalysis).toHaveBeenCalled();
    expect(ctx.setTransform.mock.calls.length).toBe(transformsAtUnmount);
  });
});

describe("VisualizerView reduced motion", () => {
  beforeEach(() => {
    ctx = {
      fillStyle: "",
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );
    frameCb = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frameCb = cb;
      return 7;
    });
    // jsdom has no matchMedia at all, which is why the rest of the suite takes the
    // live path by default; this branch needs it stated explicitly.
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("when the viewer prefers reduced motion, then it draws one settled frame and starts no loop or second stream", () => {
    h.current = song();
    h.audioEl = audio();

    mount();

    // A live sample would need the analysis element to load and play — exactly the
    // motion this branch avoids — so it must not open a stream or schedule frames.
    expect(h.startAnalysis).not.toHaveBeenCalled();
    expect(frameCb).toBeNull();
    expect(ctx.fillRect.mock.calls.length).toBeGreaterThan(0);
  });

  it("when reduced motion is preferred and nothing is playing, then the settled frame is empty", () => {
    h.current = song();
    h.audioEl = audio({ paused: true });

    mount();

    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});

describe("VisualizerView debug tracing", () => {
  beforeEach(() => {
    ctx = {
      fillStyle: "",
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );
    frameCb = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frameCb = cb;
      return 7;
    });
    vi.stubGlobal("cancelAnimationFrame", cancelRaf);
    nowMs = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function logLines() {
    return vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
  }

  it("when vizdebug is off, then nothing is logged", () => {
    h.current = song();
    h.audioEl = audio();

    mount();
    step(1500);
    step(1500);

    // The trace is opt-in precisely so it costs nothing in normal use.
    expect(console.log).not.toHaveBeenCalled();
  });

  it("when vizdebug is set, then it traces the tap state about once a second", () => {
    window.localStorage.setItem("vizdebug", "1");
    h.current = song();
    h.audioEl = audio();
    h.analysisDebug.mockReturnValue("el=ready");

    mount();
    step(1200);
    step(50); // well inside the same second

    const lines = logLines().filter((l) => l.startsWith("[viz]"));
    // One line per second, not per frame — a 60fps trace is unreadable on a
    // remote Web Inspector.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("synth=false");
    expect(lines[0]).toContain("el=ready");
  });

  it("when vizdebug is set to measurement mode and the spectrum is real, then it also traces every frame", () => {
    window.localStorage.setItem("vizdebug", "2");
    h.current = song();
    h.audioEl = audio({ currentTime: 3.25 });
    h.bands.mockImplementation((n: number) => new Array(n).fill(0.5));
    h.analysisTime.mockReturnValue(3.2);

    mount();
    step(16);
    step(16);

    // Mode 2 exists to cross-correlate the bars against the decoded envelope
    // offline, which needs both clocks on every frame.
    const frames = logLines().filter((l) => l.startsWith("[vizf]"));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain("3.2500");
  });

  it("when the bars go synthetic and then recover, then the per-frame measurement stops and resumes with them", () => {
    window.localStorage.setItem("vizdebug", "2");
    h.current = song();
    h.audioEl = audio();
    h.bands.mockImplementation((n: number) => new Array(n).fill(0.5));
    let t = 0;
    h.analysisTime.mockImplementation(() => (t += 0.5));

    mount();
    step(16); // real spectrum: measured
    const whileReal = logLines().filter((l) => l.startsWith("[vizf]")).length;
    h.bands.mockImplementation((n: number) => new Array(n).fill(0));
    step(STARVE_LIMIT_MS + 100); // starved: falls back to synthetic
    const whileSynthetic = logLines().filter((l) =>
      l.startsWith("[vizf]"),
    ).length;
    h.bands.mockImplementation((n: number) => new Array(n).fill(0.5));
    step(16); // signal returns: measured again

    // Synthetic bars carry no measurement — logging them would poison the
    // correlation with numbers that never came from the audio. And the trace has
    // to come back with the signal, or a recovered session looks permanently dead.
    expect(whileReal).toBe(1);
    expect(whileSynthetic).toBe(1);
    expect(logLines().filter((l) => l.startsWith("[vizf]"))).toHaveLength(2);
  });

  it("when localStorage is unavailable, then the visualizer still animates instead of crashing", () => {
    h.current = song();
    h.audioEl = audio();
    h.startAnalysis.mockReturnValue(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    mount();
    step();
    step();

    // Private-mode Safari throws on storage access; the trace flag is a debug
    // nicety and must never take the whole view down with it.
    expect(cellsPainted()).toBeGreaterThan(0);
  });
});

describe("VisualizerView dismissal and actions", () => {
  beforeEach(() => {
    ctx = {
      fillStyle: "",
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frameCb = cb;
      return 7;
    });
    vi.stubGlobal("cancelAnimationFrame", cancelRaf);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("when the close X is clicked on an in-app entry, then it steps back to where it was opened from", async () => {
    const user = userEvent.setup();
    // An entry this app pushed has something real behind it to return to.
    window.history.replaceState({ appPushed: true }, "", "/visualizer");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    h.current = song();

    mount();
    await user.click(screen.getByRole("button", { name: "Close visualizer" }));

    expect(back).toHaveBeenCalled();
  });

  it("when Escape is pressed, then it leaves exactly as the X does", async () => {
    const user = userEvent.setup();
    window.history.replaceState({ appPushed: true }, "", "/visualizer");
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    h.current = song();

    mount();
    await user.keyboard("{Escape}");

    expect(back).toHaveBeenCalled();
  });

  it("when closed from a cold deep link, then it lands on Home rather than a bare URL", async () => {
    const user = userEvent.setup();
    // No appPushed marker: the visitor opened /visualizer directly, so there is
    // nothing behind this entry to go back to.
    window.history.replaceState({}, "", "/visualizer");
    h.current = song();

    mount();
    await user.click(screen.getByRole("button", { name: "Close visualizer" }));

    expect(window.location.pathname).toBe("/");
  });

  it("when the playing song is published, then sharing it hands the track to the share handler", async () => {
    const user = userEvent.setup();
    const onShare = vi.fn();
    const s = song({ published: true });
    h.current = s;

    mount({ onShare });
    await user.click(screen.getByRole("button", { name: "Share" }));

    expect(onShare).toHaveBeenCalledWith(s);
  });

  it("when the playing song is unpublished, then no share action is offered", () => {
    h.current = song({ published: false });

    mount();

    // An unpublished song's /song/:id link 404s for the recipient, so offering
    // Share would only ever produce a broken link.
    expect(
      screen.queryByRole("button", { name: "Share" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close visualizer" }),
    ).toBeInTheDocument();
  });

  it("when a song is playing, then its title and artist label the view", () => {
    h.current = song({ title: "Nightbird", artistName: "Vesper Lake" });

    mount();

    expect(screen.getByText("Nightbird")).toBeInTheDocument();
    expect(screen.getByText("Vesper Lake")).toBeInTheDocument();
    expect(screen.queryByText("Nothing is playing")).not.toBeInTheDocument();
  });

  it("when the visualizer is opened with nothing cued, then it says so and offers no transport", () => {
    h.current = null;

    mount();

    expect(screen.getByText("Nothing is playing")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Share" }),
    ).not.toBeInTheDocument();
  });
});
