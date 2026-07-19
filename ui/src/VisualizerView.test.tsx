import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Song } from "./api";

// VisualizerView reads the now-playing track from the player singleton and drives
// a canvas off the shared AnalyserNode — both side-effecting modules exercised via
// Playwright, not unit tests. Mock them so the render is deterministic and no
// audio/canvas is touched. A hoisted holder lets each test swap the current song.
const h = vi.hoisted(() => ({ current: null as Song | null }));
vi.mock("./player", () => ({
  player: { getAudioElement: () => null },
  usePlayer: () => ({
    current: h.current,
    queue: [],
    playing: false,
    positionMs: 0,
    durationMs: 0,
    airplayAvailable: false,
    airplayActive: false,
    play() {}, toggle() {}, stop() {}, next() {}, prev() {}, seek() {},
    setQueue() {}, remove() {}, patchSong() {}, showAirplayPicker() {},
  }),
}));
vi.mock("./analyser", () => ({
  startAnalysis: () => true,
  stopAnalysis: () => {},
  syncAnalysis: () => {},
  analysisTime: () => -1,
  resume: () => {},
  bands: (n: number) => new Array(n).fill(0),
}));

import { VisualizerView, synthTargets, accrueStarvation, STARVE_LIMIT_MS } from "./VisualizerView";

function song(over: Partial<Song> = {}): Song {
  return {
    id: "s1", title: "Nightbird", artistName: "Vesper Lake", album: "", year: 0,
    trackNo: 0, durationMs: 200000, fileSize: 0, createdAt: "", sampleRate: 0, channels: 0, bitrateKbps: 0, genres: [], coverArtId: "", published: true,
    lyrics: "First line of the song\nSecond line here", ...over,
  };
}

// Static markup only — clicking through to the lyrics player is Playwright's job.
function render(current: Song | null) {
  h.current = current;
  return renderToStaticMarkup(
    <VisualizerView fav={{ has: () => false, toggle: () => {} }} onShare={() => {}} />,
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
      let sum = 0, n = 0;
      for (let t = 0; t < 6000; t += 100) { const f = synthTargets(t, true); for (let i = lo; i < hi; i++) { sum += f[i]; n++; } }
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
    for (let i = 0; i < 10; i++) ms = accrueStarvation(ms, 500, advancingSilent);
    expect(ms).toBeGreaterThan(STARVE_LIMIT_MS);
  });

  // The HIGH regression the review caught: a mid-track pause longer than the limit
  // used to permanently drop to synthetic bars on resume. Pausing must reset it.
  it("resets on pause, so resuming keeps the real spectrum", () => {
    let ms = accrueStarvation(0, 2000, advancingSilent); // silent while playing
    ms = accrueStarvation(ms, 60000, { playing: false, advancing: false, hasSignal: false }); // long pause
    expect(ms).toBe(0);
  });

  // A slow cold open: the hidden element is still loading/seeking (clock not
  // advancing), which must not count as a dead tap.
  it("does not accumulate while the element is still loading (not advancing)", () => {
    let ms = 0;
    ms = accrueStarvation(ms, 4000, { playing: true, advancing: false, hasSignal: false });
    expect(ms).toBe(0);
  });

  it("resets the moment any real signal appears", () => {
    let ms = accrueStarvation(0, 2000, advancingSilent);
    ms = accrueStarvation(ms, 16, { playing: true, advancing: true, hasSignal: true });
    expect(ms).toBe(0);
  });
});

describe("VisualizerView tap-to-close", () => {
  it("when the visualizer renders, then its control band is marked no-dismiss", () => {
    // The band — not just the buttons — so a tap that misses pause by a few
    // pixels doesn't close the view. The rule itself lives in backgroundDismiss.
    expect(render(song())).toContain("data-player-ui");
  });
});
