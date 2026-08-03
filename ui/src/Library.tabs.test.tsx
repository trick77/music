import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Song } from "./api";
import { Library } from "./Library";

function song(over: Partial<Song> = {}): Song {
  return {
    id: "s1",
    title: "Neon Rain",
    artistName: "Aurora Fields",
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
    ...over,
  };
}

const render = (authenticated = true) =>
  renderToStaticMarkup(
    <Library
      songs={[song()]}
      favoriteIds={[]}
      authenticated={authenticated}
      initialTab="all"
      onPlay={() => {}}
      renderRowActions={() => null}
    />,
  );

// Four pills were already ~387px — wider than a phone's ~350px content box — and
// the fifth takes the strip past 500px. It has to keep that overflow to itself
// (scrollable, like the cover rails) instead of letting the last pill hang off the
// right edge and the whole page scroll sideways.
describe("Library tab strip", () => {
  it("when the pills overflow, then the strip scrolls rather than the page", () => {
    expect(render()).toContain('class="hscroll"');
  });

  it("when the strip scrolls, then the pills keep their width instead of compressing", () => {
    // flex-shrink:0 is what makes the strip overflow (and so scroll) rather than
    // squeezing the pills into the viewport.
    const html = render();
    const strip = html.slice(html.indexOf('class="hscroll"'));
    expect(strip.slice(0, strip.indexOf("</div>"))).toContain("flex-shrink:0");
  });

  it("when the viewer is anonymous, then the strip carries no Unpublished pill", () => {
    expect(render(false)).not.toContain("Unpublished");
  });

  it("when the strip renders, then Recently added sits second, right after All songs", () => {
    // Position is the claim: "recently added" is the second thing you reach for
    // after "everything", not an afterthought parked past Genres.
    const html = render();
    expect(html.indexOf("All songs")).toBeLessThan(
      html.indexOf("Recently added"),
    );
    expect(html.indexOf("Recently added")).toBeLessThan(
      html.indexOf("Favorites"),
    );
  });

  it("when a pill counts songs, then the label and the number are separated in text, not just by gap", () => {
    // `gap` separates them visually but not textually — without an explicit
    // space the button's accessible name reads "All songs1".
    expect(render()).toMatch(/All songs (<!-- -->)? ?<span/);
  });
});
