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
vi.mock("./analyser", () => ({ attach: () => {}, resume: () => {}, bands: (n: number) => new Array(n).fill(0) }));

import { VisualizerView } from "./VisualizerView";

function song(over: Partial<Song> = {}): Song {
  return {
    id: "s1", title: "Nightbird", artistName: "Vesper Lake", album: "", year: 0,
    trackNo: 0, trackTotal: 0, durationMs: 200000, fileSize: 0, createdAt: "", sampleRate: 0, channels: 0, bitrateKbps: 0, genres: [], coverArtId: "", published: true,
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

describe("VisualizerView tap-to-close", () => {
  it("when the visualizer renders, then its control band is marked no-dismiss", () => {
    // The band — not just the buttons — so a tap that misses pause by a few
    // pixels doesn't close the view. The rule itself lives in backgroundDismiss.
    expect(render(song())).toContain("data-player-ui");
  });
});
