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
    play() {}, toggle() {}, stop() {}, next() {}, prev() {}, seek() {},
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
  it("logged out: shows static lyrics with no karaoke-sync CTA", () => {
    // alignmentEnabled is false for any anonymous caller (backend ANDs it with
    // auth), so this is exactly the logged-out expanded-lyrics view.
    const html = render(false, song(), true, true);
    // The lyrics button is offered (mini-bar) and the words render...
    expect(html).toContain('aria-label="Show lyrics"');
    expect(html).toContain("First line of the song");
    // ...but the signed-in-only sync affordances never appear.
    expect(html).not.toContain("Generate karaoke");
    expect(html).not.toContain("Sync lyrics to the music");
    expect(html).not.toContain("Syncing karaoke");
  });

  it("signed in with alignment: the karaoke-sync CTA is reachable", () => {
    // canKaraoke is true, alignment not yet ready → the needs-sync card renders.
    const html = render(true, song({ alignmentStatus: "" }), true, true);
    expect(html).toContain("Generate karaoke");
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
