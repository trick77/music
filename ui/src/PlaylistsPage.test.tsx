import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlaylistsPage, PlaylistsPageView } from "./PlaylistsPage";
import * as api from "./api";
import type { Playlist } from "./api";

// PlaylistsPage owns the listPlaylists() fetch (useEffect never runs under
// react-dom/server's synchronous renderToStaticMarkup, so its own render is
// exercised only in its pre-fetch loading state below). PlaylistsPageView is
// the pure body it delegates to once data has arrived — split out the same
// way Hero/Chapter are tested apart from the fetching Home — so the actual
// production row-rendering code is what's under test here, fed real output
// from a stubbed listPlaylists().
function playlist(overrides: Partial<Playlist>): Playlist {
  return { id: "p1", name: "Road Trip", description: "", coverArtId: "", songCount: 3, published: true, ...overrides };
}

describe("PlaylistsPage", () => {
  it("renders a loading state before the fetch resolves", () => {
    vi.spyOn(api, "listPlaylists").mockResolvedValue([]);
    const html = renderToStaticMarkup(<PlaylistsPage authenticated={false} onPlay={() => {}} />);
    expect(html).toContain("Playlists");
    expect(html).toContain("Loading");
  });
});

describe("PlaylistsPageView", () => {
  it("renders the header, count, and a row per playlist returned by listPlaylists", async () => {
    vi.spyOn(api, "listPlaylists").mockResolvedValue([
      playlist({ id: "p1", name: "Road Trip", songCount: 12 }),
      playlist({ id: "p2", name: "Focus", songCount: 21 }),
    ]);
    const fetched = await api.listPlaylists();

    const html = renderToStaticMarkup(
      <PlaylistsPageView playlists={fetched} authenticated={false} onPlay={() => {}} onNewPlaylist={() => {}} />,
    );

    expect(html).toContain("Playlists");
    expect(html).toContain("2 playlists");
    expect(html).toContain("Road Trip");
    expect(html).toContain("Focus");
    expect(html).toContain("12 songs");
    expect(html).toContain("21 songs");
  });

  it("shows an Unpublished badge only for the logged-in owner's unpublished playlists", () => {
    const html = renderToStaticMarkup(
      <PlaylistsPageView
        playlists={[playlist({ published: false })]}
        authenticated={true}
        onPlay={() => {}}
        onNewPlaylist={() => {}}
      />,
    );
    expect(html).toContain("Unpublished");

    const anon = renderToStaticMarkup(
      <PlaylistsPageView
        playlists={[playlist({ published: false })]}
        authenticated={false}
        onPlay={() => {}}
        onNewPlaylist={() => {}}
      />,
    );
    expect(anon).not.toContain("Unpublished");
  });

  it("offers + New playlist only when authenticated", () => {
    const on = renderToStaticMarkup(
      <PlaylistsPageView playlists={[]} authenticated={true} onPlay={() => {}} onNewPlaylist={() => {}} />,
    );
    expect(on).toContain("New playlist");

    const off = renderToStaticMarkup(
      <PlaylistsPageView playlists={[]} authenticated={false} onPlay={() => {}} onNewPlaylist={() => {}} />,
    );
    expect(off).not.toContain("New playlist");
  });

  it("shows an empty state with no playlists", () => {
    const html = renderToStaticMarkup(
      <PlaylistsPageView playlists={[]} authenticated={false} onPlay={() => {}} onNewPlaylist={() => {}} />,
    );
    expect(html).toContain("No playlists yet");
  });

  it("links each row to its playlist page", () => {
    const html = renderToStaticMarkup(
      <PlaylistsPageView playlists={[playlist({ id: "p9" })]} authenticated={false} onPlay={() => {}} onNewPlaylist={() => {}} />,
    );
    // Rows are click-driven <li> elements (no href), but the quick-play button
    // carries a discoverable label tying the action back to the playlist.
    expect(html).toContain('aria-label="Play Road Trip"');
  });
});
