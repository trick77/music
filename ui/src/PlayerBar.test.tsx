import { describe, it, expect, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Song } from "./api";

// PlayerBar reads the now-playing track from the player singleton (usePlayer),
// which is a side-effecting module exercised via Playwright, not unit tests. We
// mock it here to feed a fixed snapshot so the render is deterministic and no
// audio/DOM is touched. A hoisted holder lets each test swap the current song.
const h = vi.hoisted(() => ({ current: null as Song | null, queue: [] as Song[] }));
vi.mock("./player", () => ({
  usePlayer: () => ({
    current: h.current,
    queue: h.queue,
    playing: false,
    positionMs: 0,
    durationMs: 0,
    airplayAvailable: false,
    airplayActive: false,
    play() {}, toggle() {}, stop() {}, next() {}, prev() {}, seek() {},
    setQueue() {}, remove() {}, patchSong() {}, showAirplayPicker() {},
  }),
}));

import { PlayerBar } from "./PlayerBar";

function song(over: Partial<Song> = {}): Song {
  return {
    id: "s1", title: "Nightbird", artistName: "Vesper Lake", album: "", year: 0,
    trackNo: 0, trackTotal: 0, durationMs: 200000, fileSize: 0, createdAt: "", sampleRate: 0, channels: 0, bitrateKbps: 0, genres: [], coverArtId: "", published: true,
    lyrics: "First line of the song\nSecond line here", ...over,
  };
}

function render(alignmentEnabled: boolean, current: Song, open: boolean, lyrics: boolean) {
  h.current = current;
  return renderToStaticMarkup(
    <PlayerBar
      fav={{ has: () => false, toggle: () => {} }}
      onShare={() => {}}
      alignmentEnabled={alignmentEnabled}
      open={open}
      lyrics={lyrics}
      onExpand={() => {}}
      onLyricsUnavailable={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("PlayerBar lyrics gating", () => {
  it("logged out, no timing: crisp static lyrics with no karaoke-sync CTA", () => {
    // alignmentEnabled is false for any anonymous caller (backend ANDs it with
    // auth); with no ready timing this is the static-lyrics view.
    const html = render(false, song({ alignmentStatus: "" }), true, true);
    // The lyrics button is offered (mini-bar) and the words render crisply...
    expect(html).toContain('aria-label="Show lyrics"');
    expect(html).toContain("First line of the song");
    expect(html).toContain("rgba(250,249,245,.85)"); // "plain" crisp color
    // ...but the signed-in-only sync affordances never appear.
    expect(html).not.toContain("Generate karaoke");
    expect(html).not.toContain("Sync lyrics to the music");
    expect(html).not.toContain("Syncing karaoke");
  });

  it("timing ready but lines not loaded: an empty stage, never a lyric flash", () => {
    // A synced song must reach the animated player even logged out. The static
    // markup can't run the async getAlign fetch, so this is the cold window
    // before the lines land — and it must show NOTHING. Rendering the lyric
    // sheet here (as it once did) flashed a full page of words in and straight
    // back out the moment the sweep arrived, which read as a glitch.
    const html = render(false, song({ alignmentStatus: "ready" }), true, true);
    expect(html).not.toContain("First line of the song"); // no lyric sheet at all
    expect(html).not.toContain("blur(2px)"); // nor the dimmed backdrop it used
    expect(html).not.toContain("rgba(250,249,245,.85)"); // not the crisp static view
    expect(html).not.toContain("Generate karaoke");
    expect(html).not.toContain("Syncing karaoke");
  });

  it("signed in without timing: the karaoke-generate CTA is reachable", () => {
    // canGenerate is true, no alignment yet → the needs-sync card renders.
    const html = render(true, song({ alignmentStatus: "" }), true, true);
    expect(html).toContain("Generate karaoke");
  });

  it("signed in while generating: crisp static lyrics, no CTA or spinner", () => {
    // A sync in progress shows no in-progress chrome — just the static lyrics
    // until the sweep takes over. The Generate CTA is suppressed so it can't be
    // re-clicked mid-run.
    const html = render(true, song({ alignmentStatus: "generating" }), true, true);
    expect(html).toContain("rgba(250,249,245,.85)"); // "plain" crisp color
    expect(html).not.toContain("Generate karaoke");
    expect(html).not.toContain("Aligning");
    expect(html).not.toContain("Syncing karaoke");
  });

  it("offers the lyrics button whenever the track has lyrics, even logged out", () => {
    expect(render(false, song(), false, false)).toContain('aria-label="Show lyrics"');
  });

  it("hides the lyrics button for a track with no lyrics", () => {
    const html = render(false, song({ lyrics: "" }), false, false);
    expect(html).not.toContain('aria-label="Show lyrics"');
  });

  it("offers a stop-and-close button in the mini bar", () => {
    expect(render(false, song(), false, false)).toContain('aria-label="Stop and close"');
  });
});

// With nothing queued behind the current track there is nowhere to skip to, so the
// Next control must not look live: pressing it would close the player (see next()).
// Previous stays enabled throughout — with empty history it restarts the track.
describe("PlayerBar next-button gating", () => {
  afterEach(() => {
    h.queue = [];
  });

  const nextButton = (html: string) => /<button aria-label="Next"[^>]*>/.exec(html)?.[0] ?? "";

  it("disables Next when the queue is empty", () => {
    h.queue = [];
    expect(nextButton(render(false, song(), false, false))).toContain("disabled");
  });

  it("enables Next when a song is queued behind the current one", () => {
    h.queue = [song({ id: "s2" })];
    expect(nextButton(render(false, song(), false, false))).not.toContain("disabled");
  });

  it("keeps Previous enabled even with an empty queue", () => {
    h.queue = [];
    const html = render(false, song(), false, false);
    expect(/<button aria-label="Previous"[^>]*>/.exec(html)?.[0] ?? "").not.toContain("disabled");
  });

  it("gates Next in the full-screen player too, not just the mini bar", () => {
    h.queue = [];
    expect(nextButton(render(false, song(), true, false))).toContain("disabled");
  });
});

describe("PlayerBar transport divider", () => {
  // Every control row separates the transport from the actions that follow it.
  const dividers = (html: string) => (html.match(/data-divider/g) ?? []).length;
  // Each row's divider is tinted for the surface it sits on: the docked panel takes
  // the app border token, the cover-scrim overlays take white (the token vanishes
  // against the art). An overlay row also renders the mini bar underneath, so a
  // white-tinted divider there is the overlay's.
  const white = (html: string) => (html.match(/rgba\(255,255,255,0\.2\)/g) ?? []).length;

  it("when the mini bar renders, then a divider follows the transport", () => {
    const html = render(false, song(), false, false);
    expect(dividers(html)).toBe(1);
    expect(html).toContain("var(--color-border)");
    expect(white(html)).toBe(0);
  });

  it("when the full player is open, then its row carries a white-tinted divider", () => {
    const html = render(false, song(), true, false);
    expect(dividers(html)).toBe(2); // the overlay row + the mini bar below it
    expect(white(html)).toBe(1);
  });

  it("when the karaoke player is open, then its row carries a white-tinted divider", () => {
    const html = render(false, song(), true, true);
    expect(dividers(html)).toBe(2);
    expect(white(html)).toBe(1);
  });
});

describe("PlayerBar visualizer/lyrics buttons", () => {
  // The mini bar renders first, the expanded overlay after it, so the overlay is
  // everything from its close X onwards. Splitting there keeps an assertion about
  // one surface from being satisfied by the other's copy of the same button.
  const split = (html: string) => {
    const at = html.indexOf('aria-label="Close player"');
    return at === -1 ? { mini: html, overlay: "" } : { mini: html.slice(0, at), overlay: html.slice(at) };
  };
  const orderedVisThenLyrics = (row: string) => {
    const vis = row.indexOf('aria-label="Open visualizer"');
    const lyr = row.indexOf('aria-label="Show lyrics"');
    expect(vis).toBeGreaterThan(-1);
    expect(lyr).toBeGreaterThan(vis);
  };

  it("when the mini bar renders, then the visualizer sits left of the lyrics button", () => {
    orderedVisThenLyrics(split(render(false, song(), false, false)).mini);
  });

  it("when the artwork player is open, then the visualizer sits left of the lyrics button", () => {
    orderedVisThenLyrics(split(render(false, song(), true, false)).overlay);
  });

  it("when the karaoke player is open, then its row offers neither button — the X is the way out", () => {
    // The overlay row holds no lyrics/visualizer/artwork toggle: it is left via
    // the X (or Esc), not swapped away in place. The mini bar below is unaffected.
    const { overlay, mini } = split(render(false, song(), true, true));
    expect(overlay).not.toContain('aria-label="Open visualizer"');
    expect(overlay).not.toContain('aria-label="Show lyrics"');
    expect(overlay).not.toContain('aria-label="Show artwork"');
    expect(overlay).toContain('aria-label="Close player"');
    // The mini bar underneath is untouched — it still launches both views.
    expect(mini).toContain('aria-label="Open visualizer"');
    expect(mini).toContain('aria-label="Show lyrics"');
  });
});

describe("expanded player tap-to-close", () => {
  it("when the big player is open, then its scrubber and transport are marked no-dismiss", () => {
    // Tapping the background closes the player (backgroundDismiss.ts); the
    // control cluster must be excluded so near-misses around the buttons don't.
    const html = render(false, song(), true, false);
    const markers = html.match(/data-player-ui/g) ?? [];
    expect(markers.length).toBe(1); // ONE cluster wrapping both rows — covers the gap between them
  });

  it("when the karaoke player is open, then its docked control band is marked no-dismiss", () => {
    const html = render(false, song({ alignmentStatus: "" }), true, true);
    expect(html).toContain("data-player-ui");
  });

  it("when the player is collapsed, then the mini bar carries no dismiss zone", () => {
    // The mini bar isn't an immersive view — nothing there closes on a tap.
    expect(render(false, song(), false, false)).not.toContain("data-player-ui");
  });
});
