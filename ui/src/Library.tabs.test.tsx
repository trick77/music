import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Song } from "./api";
import { Library } from "./Library";

function song(over: Partial<Song> = {}): Song {
  return {
    id: "s1", title: "Neon Rain", artistName: "Aurora Fields", album: "", year: 0, trackNo: 0, trackTotal: 0,
    durationMs: 200000, fileSize: 0, createdAt: "", sampleRate: 0, channels: 0, bitrateKbps: 0,
    genres: [], coverArtId: "", published: true, ...over,
  };
}

const render = (authenticated = true) =>
  renderToStaticMarkup(
    <Library songs={[song()]} favoriteIds={[]} authenticated={authenticated} initialTab="all" onPlay={() => {}} renderRowActions={() => null} />,
  );

// Four pills are ~387px — wider than a phone. The strip has to keep that
// overflow to itself (scrollable, like the cover rails) instead of letting the
// last pill hang off the right edge and the whole page scroll sideways.
describe("Library tab strip", () => {
  it("when the pills overflow, then the strip scrolls rather than the page", () => {
    expect(render()).toContain('class="hscroll"');
  });

  it("when the strip scrolls, then the pills keep their width instead of compressing", () => {
    // flex-shrink:0 is what makes the strip overflow (and so scroll) rather than
    // squeezing four pills into the viewport.
    const html = render();
    const strip = html.slice(html.indexOf('class="hscroll"'));
    expect(strip.slice(0, strip.indexOf("</div>"))).toContain("flex-shrink:0");
  });

  it("when the viewer is anonymous, then the strip carries no Unpublished pill", () => {
    expect(render(false)).not.toContain("Unpublished");
  });
});
