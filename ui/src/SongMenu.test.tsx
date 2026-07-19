import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SongMenu } from "./SongMenu";
import type { Song } from "./api";

const song: Song = {
  id: "s1",
  title: "Night Drive",
  artistName: "The Band",
  album: "Neon",
  year: 2026,
  trackNo: 1, trackTotal: 0,
  durationMs: 2000,
  fileSize: 36380,
  createdAt: "2026-07-15 14:08:58",
  sampleRate: 44100,
  channels: 2,
  bitrateKbps: 128,
  genres: [],
  coverArtId: "c1",
  lyrics: "",
  published: true,
  alignmentStatus: "",
};

const noop = () => {};

function render(over: Partial<{ song: Song; authenticated: boolean; alignmentEnabled: boolean }> = {}) {
  return renderToStaticMarkup(
    <SongMenu
      song={over.song ?? song}
      authenticated={over.authenticated ?? true}
      alignmentEnabled={over.alignmentEnabled ?? false}
      onPlayNext={noop}
      onAddToQueue={noop}
      onAddToPlaylist={noop}
      onShare={noop}
      onEdit={noop}
      onPublish={noop}
      onSync={noop}
      onDelete={noop}
      onClose={noop}
    />,
  );
}

const separators = (html: string) => html.split('role="separator"').length - 1;

// Dividers earn their keep only on the long signed-in menu. The anonymous menu is
// four entries; a rule across it reads as a stray mark, not as structure.
describe("SongMenu grouping", () => {
  it("groups the signed-in menu into four groups with three separators", () => {
    expect(separators(render({ authenticated: true }))).toBe(3);
  });

  it("leaves the short anonymous menu flat, with no separators at all", () => {
    expect(separators(render({ authenticated: false }))).toBe(0);
  });

  it("never renders a separator as the last thing in the menu", () => {
    for (const authenticated of [true, false]) {
      const html = render({ authenticated });
      const lastSeparator = html.lastIndexOf('role="separator"');
      const lastItem = html.lastIndexOf('role="menuitem"');
      if (lastSeparator !== -1) expect(lastSeparator).toBeLessThan(lastItem);
    }
  });
});

describe("SongMenu cover-art download", () => {
  it("offers the cover-art download to a signed-in user when the song has art", () => {
    expect(render({ authenticated: true })).toContain("/api/songs/s1/cover/download");
  });

  it("hides it from anonymous listeners, who can still view the art inline", () => {
    expect(render({ authenticated: false })).not.toContain("cover/download");
  });

  it("hides it when the song has no cover art to download", () => {
    const html = render({ authenticated: true, song: { ...song, coverArtId: "" } });
    expect(html).not.toContain("cover/download");
    // The audio download is unaffected by the absence of art.
    expect(html).toContain("/api/songs/s1/download");
  });
});
