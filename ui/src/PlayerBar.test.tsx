import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Song } from "./api";

// PlayerBar reads the now-playing track from the player singleton (usePlayer),
// which is a side-effecting module exercised via Playwright, not unit tests. We
// mock it here to feed a fixed snapshot so the render is deterministic and no
// audio/DOM is touched. A hoisted holder lets each test swap the current song.
const h = vi.hoisted(() => ({ current: null as Song | null }));
vi.mock("./player", () => ({
  usePlayer: () => ({
    current: h.current,
    queue: [],
    playing: false,
    positionMs: 0,
    durationMs: 0,
    airplayAvailable: false,
    airplayActive: false,
    play() {}, toggle() {}, next() {}, prev() {}, seek() {},
    setQueue() {}, restore() {}, remove() {}, patchSong() {}, showAirplayPicker() {},
  }),
}));

import { PlayerBar } from "./PlayerBar";

function song(over: Partial<Song> = {}): Song {
  return {
    id: "s1", title: "Nightbird", artistName: "Vesper Lake", album: "", year: 0,
    trackNo: 0, durationMs: 200000, genres: [], coverArtId: "", published: true,
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
      onSetMode={() => {}}
      onClose={() => {}}
      onCopyLink={() => {}}
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

  it("logged out, timing ready: takes the karaoke path, not forced static", () => {
    // A synced song must reach the animated player even logged out. The static
    // markup can't run the async getAlign fetch, so it renders the pre-sweep
    // backdrop (blurred/dimmed) — the sweep replaces it once lines load. The key
    // assertion: it's NOT the crisp forced-static "plain" view auth used to force.
    const html = render(false, song({ alignmentStatus: "ready" }), true, true);
    expect(html).toContain("blur(2px)"); // dimmed backdrop, karaoke path
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
});
