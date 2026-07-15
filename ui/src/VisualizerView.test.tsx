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
    setQueue() {}, restore() {}, remove() {}, patchSong() {}, showAirplayPicker() {},
  }),
}));
vi.mock("./analyser", () => ({ attach: () => {}, resume: () => {}, bands: (n: number) => new Array(n).fill(0) }));

import { VisualizerView } from "./VisualizerView";

function song(over: Partial<Song> = {}): Song {
  return {
    id: "s1", title: "Nightbird", artistName: "Vesper Lake", album: "", year: 0,
    trackNo: 0, durationMs: 200000, fileSize: 0, createdAt: "", genres: [], coverArtId: "", published: true,
    lyrics: "First line of the song\nSecond line here", ...over,
  };
}

// Static markup only — clicking through to the lyrics player is Playwright's job.
function render(current: Song | null) {
  h.current = current;
  return renderToStaticMarkup(
    <VisualizerView fav={{ has: () => false, toggle: () => {} }} onShare={() => {}} onShowLyrics={() => {}} />,
  );
}

describe("VisualizerView control row", () => {
  it("when the song has lyrics, then it offers the karaoke button", () => {
    const html = render(song());
    expect(html).toContain('aria-label="Show lyrics"');
  });

  it("when the song has no lyrics, then the karaoke button is absent", () => {
    // Same gate as the player: nothing to show, so don't offer the trip.
    expect(render(song({ lyrics: "" }))).not.toContain('aria-label="Show lyrics"');
    expect(render(song({ lyrics: "   " }))).not.toContain('aria-label="Show lyrics"');
  });

  it("when rendering the karaoke button, then it is a plain action, not the accent toggle", () => {
    // It navigates to the lyrics player rather than toggling a view in place, so it
    // must not borrow the player's accent-pressed toggle styling.
    const html = render(song());
    const btn = html.slice(html.indexOf('aria-label="Show lyrics"'));
    expect(btn.slice(0, btn.indexOf("</button>"))).toContain("color:#fff");
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain("--color-accent-strong");
  });

  it("when a song is playing, then a divider separates transport from the actions", () => {
    const html = render(song());
    expect(html).toContain("data-divider");
    // On the cover scrim only the white tint survives; the app border token vanishes.
    expect(html).toContain("rgba(255,255,255,0.2)");
    expect(html).not.toContain("var(--color-border)");
  });

  it("when nothing is playing, then the control row and its divider are gone", () => {
    const html = render(null);
    expect(html).toContain("Nothing is playing");
    expect(html).not.toContain("data-divider");
  });
});
