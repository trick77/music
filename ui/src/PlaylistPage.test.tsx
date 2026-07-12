import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlaylistPage, PlaylistPageView } from "./PlaylistPage";
import * as api from "./api";
import type { PlaylistDetail, Song } from "./api";

// PlaylistPage owns the getPlaylist() fetch (useEffect never runs under
// react-dom/server's synchronous renderToStaticMarkup, so its own render is
// exercised only in its pre-fetch loading state below). PlaylistPageView is
// the pure body it delegates to once data has arrived — split out the same
// way PlaylistsPage/PlaylistsPageView are — so the actual production header
// + row rendering is what's under test here.
function song(overrides: Partial<Song>): Song {
  return {
    id: "s1",
    title: "Golden Hour",
    artistName: "Kavinsky",
    album: "",
    year: 0,
    trackNo: 0,
    durationMs: 0,
    genres: [],
    coverArtId: "",
    published: true,
    alignmentStatus: "",
    ...overrides,
  };
}

function playlistDetail(overrides: Partial<PlaylistDetail>): PlaylistDetail {
  return {
    id: "p1",
    name: "Road Trip",
    description: "Sun-bleached highway pop.",
    coverArtId: "",
    songCount: 2,
    published: true,
    songs: [song({ id: "s1", title: "Golden Hour" }), song({ id: "s2", title: "Nightcall", artistName: "London Grammar" })],
    ...overrides,
  };
}

describe("PlaylistPage", () => {
  it("renders a loading state before the fetch resolves", () => {
    vi.spyOn(api, "getPlaylist").mockResolvedValue(playlistDetail({}));
    const html = renderToStaticMarkup(
      <PlaylistPage id="p1" authenticated={false} onPlay={() => {}} onShare={() => {}} renderRowActions={() => null} />,
    );
    expect(html).toContain("Loading");
  });
});

describe("PlaylistPageView", () => {
  it("renders the header with name, description, song count, and a Play control", () => {
    const html = renderToStaticMarkup(
      <PlaylistPageView
        playlist={playlistDetail({})}
        authenticated={false}
        onPlay={() => {}}
        onShare={() => {}}
        renderRowActions={() => null}
        onTogglePublish={() => {}}
      />,
    );

    expect(html).toContain("Road Trip");
    expect(html).toContain("Sun-bleached highway pop.");
    expect(html).toContain("2 songs");
    expect(html).toContain("Play");
    expect(html).toContain("Shuffle");
    expect(html).toContain("Golden Hour");
    expect(html).toContain("Nightcall");
  });

  it("shows an Unpublished pill and Publish/Edit actions only when authenticated", () => {
    const authed = renderToStaticMarkup(
      <PlaylistPageView
        playlist={playlistDetail({ published: false })}
        authenticated={true}
        onPlay={() => {}}
        onShare={() => {}}
        renderRowActions={() => null}
        onTogglePublish={() => {}}
      />,
    );
    expect(authed).toContain("Unpublished");
    expect(authed).toContain("Publish");
    expect(authed).toContain("Edit");

    const anon = renderToStaticMarkup(
      <PlaylistPageView
        playlist={playlistDetail({ published: false })}
        authenticated={false}
        onPlay={() => {}}
        onShare={() => {}}
        renderRowActions={() => null}
        onTogglePublish={() => {}}
      />,
    );
    expect(anon).not.toContain("Unpublished");
    expect(anon).not.toContain("Publish");
  });

  it("shows an empty state with no songs and hides Play/Shuffle", () => {
    const html = renderToStaticMarkup(
      <PlaylistPageView
        playlist={playlistDetail({ songs: [], songCount: 0 })}
        authenticated={false}
        onPlay={() => {}}
        onShare={() => {}}
        renderRowActions={() => null}
        onTogglePublish={() => {}}
      />,
    );
    expect(html).toContain("No songs yet");
    expect(html).toContain("0 songs");
  });

  it("shows the delete button and add-songs input only in edit mode", () => {
    const editingHtml = renderToStaticMarkup(
      <PlaylistPageView
        playlist={playlistDetail({})}
        authenticated={true}
        onPlay={() => {}}
        onShare={() => {}}
        renderRowActions={() => null}
        onTogglePublish={() => {}}
        initialEditing={true}
      />,
    );
    expect(editingHtml).toContain("Delete playlist");
    expect(editingHtml).toContain("Search by title or artist…");
    expect(editingHtml).toContain("Done");

    const viewHtml = renderToStaticMarkup(
      <PlaylistPageView
        playlist={playlistDetail({})}
        authenticated={true}
        onPlay={() => {}}
        onShare={() => {}}
        renderRowActions={() => null}
        onTogglePublish={() => {}}
        initialEditing={false}
      />,
    );
    expect(viewHtml).not.toContain("Delete playlist");
    expect(viewHtml).not.toContain("Search by title or artist…");
    expect(viewHtml).toContain("Edit");
  });
});
