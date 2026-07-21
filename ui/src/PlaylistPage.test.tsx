import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// The render-based suites below drive the real handlers, which all call the api
// module. Mocking at that boundary keeps these tests about PlaylistPage's own
// state machine (edit mode, the two-step delete, the AI panels) rather than
// about fetch plumbing, and lets the failure branches be exercised at all.
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    getPlaylist: vi.fn(),
    listSongs: vi.fn(),
    updatePlaylist: vi.fn(),
    updatePlaylistDescription: vi.fn(),
    setPlaylistPublished: vi.fn(),
    addSongToPlaylist: vi.fn(),
    removeSongFromPlaylist: vi.fn(),
    reorderPlaylist: vi.fn(),
    deletePlaylist: vi.fn(),
    uploadPlaylistCover: vi.fn(),
    applyPlaylistCover: vi.fn(),
    generateStudioCoverArt: vi.fn(),
    suggestPlaylistPrompt: vi.fn(),
    refinePlaylistPrompt: vi.fn(),
    suggestPlaylistDescriptions: vi.fn(),
  };
});

// navigate() pushes real history; stubbing it isolates the assertion and stops
// one test's navigation from leaking into the next.
vi.mock("./router", () => ({ navigate: vi.fn() }));

import { PlaylistPage, PlaylistPageView, defaultTone } from "./PlaylistPage";
import * as api from "./api";
import { navigate } from "./router";
import type { PlaylistDetail, Song } from "./api";

const mocked = vi.mocked(api);
const mockNavigate = vi.mocked(navigate);

describe("defaultTone", () => {
  it("returns the evocative key", () => {
    expect(defaultTone()).toBe("evocative");
  });
});

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
    trackNo: 0, trackTotal: 0,
    durationMs: 0,
    fileSize: 0,
    createdAt: "",
    sampleRate: 0,
    channels: 0,
    bitrateKbps: 0,
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
    expect(html).not.toContain("Shuffle");
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

  it("shows the AI cover panel and description chips only when their flags are enabled in edit mode", () => {
    const both = renderToStaticMarkup(
      <PlaylistPageView
        playlist={playlistDetail({})}
        authenticated={true}
        onPlay={() => {}}
        onShare={() => {}}
        renderRowActions={() => null}
        onTogglePublish={() => {}}
        initialEditing={true}
        imageGenEnabled={true}
        chatEnabled={true}
      />,
    );
    expect(both).toContain("AI cover art");
    expect(both).toContain("AI description");
    expect(both).toContain("Suggest from songs");
    expect(both).toContain("Suggest descriptions");

    const neither = renderToStaticMarkup(
      <PlaylistPageView
        playlist={playlistDetail({})}
        authenticated={true}
        onPlay={() => {}}
        onShare={() => {}}
        renderRowActions={() => null}
        onTogglePublish={() => {}}
        initialEditing={true}
        imageGenEnabled={false}
        chatEnabled={false}
      />,
    );
    expect(neither).not.toContain("AI cover art");
    expect(neither).not.toContain("AI description");
  });
});

// ── Behavioural suites ─────────────────────────────────────────────────────
// Everything above renders to static markup, which never runs an effect or a
// handler. The suites below mount for real so the fetch, the edit-mode state
// machine and every failure branch are actually exercised.

// Renders the pure view in edit mode with a spy for the state write-back, which
// is how nearly every mutation in this component reports its result.
function renderEditing(
  overrides: Partial<PlaylistDetail> = {},
  props: Partial<React.ComponentProps<typeof PlaylistPageView>> = {},
) {
  const onPlaylistUpdate = vi.fn();
  const view = render(
    <PlaylistPageView
      playlist={playlistDetail(overrides)}
      authenticated={true}
      onPlay={() => {}}
      onShare={() => {}}
      renderRowActions={() => null}
      onTogglePublish={() => {}}
      onPlaylistUpdate={onPlaylistUpdate}
      initialEditing={true}
      {...props}
    />,
  );
  return { ...view, onPlaylistUpdate };
}

beforeEach(() => {
  window.history.replaceState({}, "", "/playlist/p1");
  mocked.getPlaylist.mockResolvedValue(playlistDetail({}));
  mocked.listSongs.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PlaylistPage fetching", () => {
  it("when the fetch resolves, then the loading text is replaced by the playlist", async () => {
    render(
      <PlaylistPage id="p1" authenticated={false} onPlay={() => {}} onShare={() => {}} renderRowActions={() => null} />,
    );

    expect(await screen.findByRole("heading", { name: "Road Trip" })).toBeInTheDocument();
    expect(mocked.getPlaylist).toHaveBeenCalledWith("p1");
  });

  it("when the fetch rejects, then it shows a not-found message with a way home", async () => {
    const user = userEvent.setup();
    mocked.getPlaylist.mockRejectedValue(new Error("404"));

    render(
      <PlaylistPage id="p1" authenticated={false} onPlay={() => {}} onShare={() => {}} renderRowActions={() => null} />,
    );

    // A deleted or private playlist must not sit on "Loading…" forever.
    expect(await screen.findByText(/Not found/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Home" }));
    expect(mockNavigate).toHaveBeenCalledWith("/");
  });

  it("when reloadKey is bumped, then it refetches without blanking the current view", async () => {
    const { rerender } = render(
      <PlaylistPage id="p1" authenticated={false} onPlay={() => {}} onShare={() => {}} renderRowActions={() => null} reloadKey={0} />,
    );
    await screen.findByRole("heading", { name: "Road Trip" });

    rerender(
      <PlaylistPage id="p1" authenticated={false} onPlay={() => {}} onShare={() => {}} renderRowActions={() => null} reloadKey={1} />,
    );

    await waitFor(() => expect(mocked.getPlaylist).toHaveBeenCalledTimes(2));
    // Nulling state on a reloadKey bump would flash "Loading…" over a page the
    // user is already reading, so only an id change is allowed to clear it.
    expect(screen.getByRole("heading", { name: "Road Trip" })).toBeInTheDocument();
  });

  it("when the id changes, then the stale playlist is cleared while the new one loads", async () => {
    mocked.getPlaylist.mockResolvedValue(playlistDetail({ name: "Road Trip" }));
    const { rerender } = render(
      <PlaylistPage id="p1" authenticated={false} onPlay={() => {}} onShare={() => {}} renderRowActions={() => null} />,
    );
    await screen.findByRole("heading", { name: "Road Trip" });

    mocked.getPlaylist.mockReturnValue(new Promise(() => {}));
    rerender(
      <PlaylistPage id="p2" authenticated={false} onPlay={() => {}} onShare={() => {}} renderRowActions={() => null} />,
    );

    // Showing the previous playlist's title under a new URL would be wrong.
    expect(screen.queryByRole("heading", { name: "Road Trip" })).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("when the publish pill is pressed, then the server's updated playlist replaces the local state", async () => {
    const user = userEvent.setup();
    mocked.getPlaylist.mockResolvedValue(playlistDetail({ published: true }));
    mocked.setPlaylistPublished.mockResolvedValue(playlistDetail({ published: false }));

    render(
      <PlaylistPage id="p1" authenticated={true} onPlay={() => {}} onShare={() => {}} renderRowActions={() => null} />,
    );
    await user.click(await screen.findByRole("button", { name: /Unpublish/ }));

    expect(mocked.setPlaylistPublished).toHaveBeenCalledWith("p1", false);
    // The pill has to flip to reflect the new state, not just fire and forget.
    expect(await screen.findByRole("button", { name: /Publish/ })).toBeInTheDocument();
  });

  it("when the publish toggle fails, then the pill keeps its previous state", async () => {
    const user = userEvent.setup();
    mocked.getPlaylist.mockResolvedValue(playlistDetail({ published: true }));
    mocked.setPlaylistPublished.mockRejectedValue(new Error("500"));

    render(
      <PlaylistPage id="p1" authenticated={true} onPlay={() => {}} onShare={() => {}} renderRowActions={() => null} />,
    );
    await user.click(await screen.findByRole("button", { name: /Unpublish/ }));

    // Optimistically flipping to "Publish" would tell the user the playlist is
    // private when the server still has it public.
    await waitFor(() => expect(mocked.setPlaylistPublished).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: /Unpublish/ })).toBeInTheDocument();
  });
});

describe("PlaylistPageView playback", () => {
  it("when Play is pressed, then the first song starts and the rest become the tail", async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    const detail = playlistDetail({});
    render(
      <PlaylistPageView
        playlist={detail}
        authenticated={false}
        onPlay={onPlay}
        onShare={() => {}}
        renderRowActions={() => null}
        onTogglePublish={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Play" }));

    expect(onPlay).toHaveBeenCalledWith(detail.songs[0], [detail.songs[1]]);
  });

  it("when Shuffle is pressed, then every song is still queued exactly once", async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    const detail = playlistDetail({});
    render(
      <PlaylistPageView
        playlist={detail}
        authenticated={false}
        onPlay={onPlay}
        onShare={() => {}}
        renderRowActions={() => null}
        onTogglePublish={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Shuffle" }));

    // The order is random, so assert the invariant that matters: shuffling must
    // not drop or duplicate tracks.
    const [head, tail] = onPlay.mock.calls[0];
    expect([head, ...tail].map((s: Song) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("when a song row is clicked, then it plays from that position onward", async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    const detail = playlistDetail({});
    render(
      <PlaylistPageView
        playlist={detail}
        authenticated={false}
        onPlay={onPlay}
        onShare={() => {}}
        renderRowActions={() => null}
        onTogglePublish={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Play Golden Hour" }));

    expect(onPlay).toHaveBeenCalledWith(detail.songs[0], [detail.songs[1]]);
  });

  it("when Share is pressed, then the caller receives this playlist's share URL", async () => {
    const user = userEvent.setup();
    const onShare = vi.fn();
    render(
      <PlaylistPageView
        playlist={playlistDetail({ id: "p9" })}
        authenticated={false}
        onPlay={() => {}}
        onShare={onShare}
        renderRowActions={() => null}
        onTogglePublish={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Share/ }));

    expect(onShare).toHaveBeenCalledWith(expect.stringContaining("p9"));
  });

  it("when the viewer is signed in, then unpublished songs are badged in the row list", () => {
    render(
      <PlaylistPageView
        playlist={playlistDetail({ songs: [song({ id: "s1", title: "Demo Take", published: false })] })}
        authenticated={true}
        onPlay={() => {}}
        onShare={() => {}}
        renderRowActions={() => null}
        onTogglePublish={() => {}}
      />,
    );

    expect(screen.getByText("Unpublished", { selector: "span" })).toBeInTheDocument();
  });

  it("when renderRowActions supplies controls, then they are rendered per row", () => {
    render(
      <PlaylistPageView
        playlist={playlistDetail({})}
        authenticated={false}
        onPlay={() => {}}
        onShare={() => {}}
        renderRowActions={(s) => <button>menu-{s.id}</button>}
        onTogglePublish={() => {}}
      />,
    );

    // App injects the favourite/overflow cluster this way, so a row that
    // silently ignored the prop would lose every song action.
    expect(screen.getByRole("button", { name: "menu-s1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "menu-s2" })).toBeInTheDocument();
  });
});

describe("PlaylistPageView edit mode", () => {
  it("when Edit is toggled on and off, then the editing panel appears and disappears", async () => {
    const user = userEvent.setup();
    render(
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

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByPlaceholderText("Search by title or artist…")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByPlaceholderText("Search by title or artist…")).not.toBeInTheDocument();
  });

  it("when the URL carries edit=1, then the page opens straight into edit mode", () => {
    window.history.replaceState({}, "", "/playlist/p1?edit=1");

    render(
      <PlaylistPageView
        playlist={playlistDetail({})}
        authenticated={true}
        onPlay={() => {}}
        onShare={() => {}}
        renderRowActions={() => null}
        onTogglePublish={() => {}}
      />,
    );

    // Freshly created playlists deep-link here to be named immediately.
    expect(screen.getByPlaceholderText("Search by title or artist…")).toBeInTheDocument();
  });

  it("when the name is changed and blurred, then the rename is persisted", async () => {
    const user = userEvent.setup();
    mocked.updatePlaylist.mockResolvedValue(playlistDetail({ name: "Night Drive" }));
    const { onPlaylistUpdate } = renderEditing();

    const input = screen.getByDisplayValue("Road Trip");
    await user.clear(input);
    await user.type(input, "Night Drive");
    await user.tab();

    await waitFor(() =>
      expect(mocked.updatePlaylist).toHaveBeenCalledWith("p1", "Night Drive", "Sun-bleached highway pop."),
    );
    expect(onPlaylistUpdate).toHaveBeenCalled();
  });

  it("when the name is blurred unchanged, then no write is issued", async () => {
    const user = userEvent.setup();
    renderEditing();

    await user.click(screen.getByDisplayValue("Road Trip"));
    await user.tab();

    // Blur fires on every focus change, so an unconditional PUT would spam the
    // server with no-op renames.
    expect(mocked.updatePlaylist).not.toHaveBeenCalled();
  });

  it("when the name is emptied, then it reverts rather than saving a nameless playlist", async () => {
    const user = userEvent.setup();
    renderEditing();

    const input = screen.getByDisplayValue("Road Trip");
    await user.clear(input);
    await user.tab();

    expect(mocked.updatePlaylist).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Road Trip")).toBeInTheDocument();
  });

  it("when the rename request fails, then the field snaps back to the saved name", async () => {
    const user = userEvent.setup();
    mocked.updatePlaylist.mockRejectedValue(new Error("500"));
    renderEditing();

    const input = screen.getByDisplayValue("Road Trip");
    await user.clear(input);
    await user.type(input, "Night Drive");
    await user.tab();

    // Leaving the rejected text in the box would imply it was saved.
    expect(await screen.findByDisplayValue("Road Trip")).toBeInTheDocument();
  });

  it("when the description is edited and blurred, then it is persisted", async () => {
    const user = userEvent.setup();
    mocked.updatePlaylistDescription.mockResolvedValue(playlistDetail({ description: "Windows down." }));
    const { onPlaylistUpdate } = renderEditing();

    const box = screen.getByDisplayValue("Sun-bleached highway pop.");
    await user.clear(box);
    await user.type(box, "Windows down.");
    await user.tab();

    await waitFor(() =>
      expect(mocked.updatePlaylistDescription).toHaveBeenCalledWith("p1", "Windows down."),
    );
    expect(onPlaylistUpdate).toHaveBeenCalled();
  });

  it("when the description save fails, then the field reverts to the stored text", async () => {
    const user = userEvent.setup();
    mocked.updatePlaylistDescription.mockRejectedValue(new Error("500"));
    renderEditing();

    const box = screen.getByDisplayValue("Sun-bleached highway pop.");
    await user.clear(box);
    await user.type(box, "Windows down.");
    await user.tab();

    expect(await screen.findByDisplayValue("Sun-bleached highway pop.")).toBeInTheDocument();
  });
});

describe("PlaylistPageView song management", () => {
  it("when the add field is focused, then the library is fetched once and reused", async () => {
    const user = userEvent.setup();
    mocked.listSongs.mockResolvedValue([song({ id: "s3", title: "Protovision" })]);
    renderEditing();

    const field = screen.getByPlaceholderText("Search by title or artist…");
    await user.click(field);
    await waitFor(() => expect(mocked.listSongs).toHaveBeenCalledTimes(1));
    await user.tab();
    await user.click(field);

    // Refetching the whole library on every focus would be wasteful; the cached
    // list is what the suggestions filter against.
    expect(mocked.listSongs).toHaveBeenCalledTimes(1);
  });

  it("when a query is typed, then only matching library songs are suggested", async () => {
    const user = userEvent.setup();
    mocked.listSongs.mockResolvedValue([
      song({ id: "s3", title: "Protovision", artistName: "Kavinsky" }),
      song({ id: "s4", title: "Blinding Lights", artistName: "The Weeknd" }),
    ]);
    renderEditing();

    const field = screen.getByPlaceholderText("Search by title or artist…");
    await user.click(field);
    await waitFor(() => expect(mocked.listSongs).toHaveBeenCalled());
    await user.type(field, "proto");

    expect(await screen.findByText(/Protovision/)).toBeInTheDocument();
    expect(screen.queryByText(/Blinding Lights/)).not.toBeInTheDocument();
  });

  it("when the query matches the artist rather than the title, then the song is still suggested", async () => {
    const user = userEvent.setup();
    mocked.listSongs.mockResolvedValue([song({ id: "s4", title: "Blinding Lights", artistName: "The Weeknd" })]);
    renderEditing();

    const field = screen.getByPlaceholderText("Search by title or artist…");
    await user.click(field);
    await waitFor(() => expect(mocked.listSongs).toHaveBeenCalled());
    await user.type(field, "weeknd");

    // The filter concatenates title and artist, which is what makes the
    // placeholder's "title or artist" promise true.
    expect(await screen.findByText(/Blinding Lights/)).toBeInTheDocument();
  });

  it("when a suggestion is picked, then the song is added and the query is cleared", async () => {
    const user = userEvent.setup();
    const added = song({ id: "s3", title: "Protovision" });
    mocked.listSongs.mockResolvedValue([added]);
    mocked.addSongToPlaylist.mockResolvedValue(playlistDetail({ songs: [added] }));
    const { onPlaylistUpdate } = renderEditing();

    const field = screen.getByPlaceholderText("Search by title or artist…");
    await user.click(field);
    await waitFor(() => expect(mocked.listSongs).toHaveBeenCalled());
    await user.type(field, "proto");
    await user.click(await screen.findByText(/Protovision/));

    expect(mocked.addSongToPlaylist).toHaveBeenCalledWith("p1", "s3");
    expect(onPlaylistUpdate).toHaveBeenCalled();
    // Clearing the box readies it for the next add instead of leaving the
    // just-added song sitting in the suggestion list.
    await waitFor(() => expect(field).toHaveValue(""));
  });

  it("when adding a song fails, then the playlist state is left untouched", async () => {
    const user = userEvent.setup();
    mocked.listSongs.mockResolvedValue([song({ id: "s3", title: "Protovision" })]);
    mocked.addSongToPlaylist.mockRejectedValue(new Error("409"));
    const { onPlaylistUpdate } = renderEditing();

    const field = screen.getByPlaceholderText("Search by title or artist…");
    await user.click(field);
    await waitFor(() => expect(mocked.listSongs).toHaveBeenCalled());
    await user.type(field, "proto");
    await user.click(await screen.findByText(/Protovision/));

    await waitFor(() => expect(mocked.addSongToPlaylist).toHaveBeenCalled());
    expect(onPlaylistUpdate).not.toHaveBeenCalled();
  });

  it("when a row's remove button is pressed, then that song is removed from the playlist", async () => {
    const user = userEvent.setup();
    mocked.removeSongFromPlaylist.mockResolvedValue(playlistDetail({ songs: [] }));
    const { onPlaylistUpdate } = renderEditing();

    await user.click(screen.getByRole("button", { name: "Remove Nightcall" }));

    expect(mocked.removeSongFromPlaylist).toHaveBeenCalledWith("p1", "s2");
    expect(onPlaylistUpdate).toHaveBeenCalled();
  });

  it("when removing a song fails, then the list is not mutated", async () => {
    const user = userEvent.setup();
    mocked.removeSongFromPlaylist.mockRejectedValue(new Error("500"));
    const { onPlaylistUpdate } = renderEditing();

    await user.click(screen.getByRole("button", { name: "Remove Nightcall" }));

    await waitFor(() => expect(mocked.removeSongFromPlaylist).toHaveBeenCalled());
    expect(onPlaylistUpdate).not.toHaveBeenCalled();
  });

  it("when a row is dragged onto another, then the reordered id list is persisted", async () => {
    mocked.reorderPlaylist.mockResolvedValue(playlistDetail({}));
    const { onPlaylistUpdate } = renderEditing();

    // Drag-and-drop has no userEvent equivalent, so the HTML5 events are fired
    // directly. Dragging row 1 onto row 0 must send the swapped order.
    const rows = screen.getAllByText("⠿").map((h) => h.parentElement!);
    fireEvent.dragStart(rows[1]);
    fireEvent.drop(rows[0]);

    await waitFor(() => expect(mocked.reorderPlaylist).toHaveBeenCalledWith("p1", ["s2", "s1"]));
    expect(onPlaylistUpdate).toHaveBeenCalled();
  });

  it("when a drop happens with no drag in progress, then no reorder is sent", () => {
    renderEditing();

    const rows = screen.getAllByText("⠿").map((h) => h.parentElement!);
    fireEvent.drop(rows[0]);

    // A stray drop from elsewhere on the page must not reshuffle the playlist.
    expect(mocked.reorderPlaylist).not.toHaveBeenCalled();
  });
});

describe("PlaylistPageView delete flow", () => {
  it("when delete is pressed once, then it asks for confirmation instead of deleting", async () => {
    const user = userEvent.setup();
    renderEditing();

    await user.click(screen.getByRole("button", { name: /Delete playlist/ }));

    expect(screen.getByText("Really delete this playlist?")).toBeInTheDocument();
    expect(mocked.deletePlaylist).not.toHaveBeenCalled();
  });

  it("when the confirmation is accepted, then the playlist is deleted and the user is sent to the index", async () => {
    const user = userEvent.setup();
    mocked.deletePlaylist.mockResolvedValue(undefined as never);
    renderEditing();

    await user.click(screen.getByRole("button", { name: /Delete playlist/ }));
    await user.click(screen.getByRole("button", { name: "Yes, delete" }));

    expect(mocked.deletePlaylist).toHaveBeenCalledWith("p1");
    // Staying on the page would leave the user looking at a playlist that no
    // longer exists.
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith("/playlists"));
  });

  it("when the confirmation is cancelled, then the destructive button returns to its resting state", async () => {
    const user = userEvent.setup();
    renderEditing();

    await user.click(screen.getByRole("button", { name: /Delete playlist/ }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Really delete this playlist?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Delete playlist/ })).toBeInTheDocument();
  });

  it("when the delete request fails, then the confirmation resets so it can be retried", async () => {
    const user = userEvent.setup();
    mocked.deletePlaylist.mockRejectedValue(new Error("500"));
    renderEditing();

    await user.click(screen.getByRole("button", { name: /Delete playlist/ }));
    await user.click(screen.getByRole("button", { name: "Yes, delete" }));

    // Leaving the button stuck on "Deleting…" would strand the user with no way
    // to retry or back out.
    expect(await screen.findByRole("button", { name: /Delete playlist/ })).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("when edit mode is closed mid-confirmation, then reopening it starts from an unconfirmed state", async () => {
    const user = userEvent.setup();
    renderEditing({}, { initialEditing: false });

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: /Delete playlist/ }));
    await user.click(screen.getByRole("button", { name: "Done" }));
    await user.click(screen.getByRole("button", { name: "Edit" }));

    // A primed delete confirmation surviving a panel close is a foot-gun.
    expect(screen.queryByText("Really delete this playlist?")).not.toBeInTheDocument();
  });
});

describe("PlaylistPageView AI description tones", () => {
  it("when descriptions are suggested, then the three tone chips appear", async () => {
    const user = userEvent.setup();
    mocked.suggestPlaylistDescriptions.mockResolvedValue({
      punchy: "Windows down.",
      evocative: "Sun on chrome.",
      factual: "Twelve synthwave tracks.",
    });
    renderEditing({}, { chatEnabled: true });

    await user.click(screen.getByRole("button", { name: /Suggest descriptions/ }));

    expect(await screen.findByRole("button", { name: "Punchy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Evocative" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Factual" })).toBeInTheDocument();
  });

  it("when a tone chip is picked, then the description is filled in and saved immediately", async () => {
    const user = userEvent.setup();
    mocked.suggestPlaylistDescriptions.mockResolvedValue({
      punchy: "Windows down.",
      evocative: "Sun on chrome.",
      factual: "Twelve synthwave tracks.",
    });
    mocked.updatePlaylistDescription.mockResolvedValue(playlistDetail({ description: "Windows down." }));
    renderEditing({}, { chatEnabled: true });

    await user.click(screen.getByRole("button", { name: /Suggest descriptions/ }));
    await user.click(await screen.findByRole("button", { name: "Punchy" }));

    // A chip click never blurs the textarea, so onBlur cannot save it — the chip
    // has to write through itself or the choice is silently lost.
    expect(await screen.findByDisplayValue("Windows down.")).toBeInTheDocument();
    await waitFor(() =>
      expect(mocked.updatePlaylistDescription).toHaveBeenCalledWith("p1", "Windows down."),
    );
  });

  it("when suggesting descriptions fails, then an error is announced and no chips render", async () => {
    const user = userEvent.setup();
    mocked.suggestPlaylistDescriptions.mockRejectedValue(new Error("503"));
    renderEditing({}, { chatEnabled: true });

    await user.click(screen.getByRole("button", { name: /Suggest descriptions/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not suggest descriptions");
    expect(screen.queryByRole("button", { name: "Punchy" })).not.toBeInTheDocument();
  });
});

describe("PlaylistPageView AI cover art", () => {
  const aiProps = { chatEnabled: true, imageGenEnabled: true };

  it("when a prompt is suggested, then it lands in the prompt box", async () => {
    const user = userEvent.setup();
    mocked.suggestPlaylistPrompt.mockResolvedValue({ prompt: "Neon highway at dusk" });
    renderEditing({}, aiProps);

    await user.click(screen.getByRole("button", { name: /Suggest from songs/ }));

    expect(await screen.findByDisplayValue("Neon highway at dusk")).toBeInTheDocument();
    expect(mocked.suggestPlaylistPrompt).toHaveBeenCalledWith("p1");
  });

  it("when suggesting a prompt fails, then the failure is announced", async () => {
    const user = userEvent.setup();
    mocked.suggestPlaylistPrompt.mockRejectedValue(new Error("503"));
    renderEditing({}, aiProps);

    await user.click(screen.getByRole("button", { name: /Suggest from songs/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not suggest a prompt");
  });

  it("when a refinement is submitted, then the refined prompt replaces the original", async () => {
    const user = userEvent.setup();
    mocked.refinePlaylistPrompt.mockResolvedValue({ prompt: "Neon highway, heavy rain" });
    renderEditing({}, aiProps);

    await user.type(screen.getByLabelText("Cover art prompt"), "Neon highway");
    await user.type(screen.getByLabelText("Refine prompt instruction"), "add rain{Enter}");

    await waitFor(() =>
      expect(mocked.refinePlaylistPrompt).toHaveBeenCalledWith("p1", "Neon highway", "add rain"),
    );
    expect(await screen.findByDisplayValue("Neon highway, heavy rain")).toBeInTheDocument();
  });

  it("when refining fails, then the failure is announced and the prompt is kept", async () => {
    const user = userEvent.setup();
    mocked.refinePlaylistPrompt.mockRejectedValue(new Error("503"));
    renderEditing({}, aiProps);

    await user.type(screen.getByLabelText("Cover art prompt"), "Neon highway");
    await user.type(screen.getByLabelText("Refine prompt instruction"), "add rain{Enter}");

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not refine the prompt");
    // Losing the user's typed prompt because the refinement failed would be a
    // much worse outcome than the failed refinement itself.
    expect(screen.getByLabelText("Cover art prompt")).toHaveValue("Neon highway");
  });

  it("when the prompt is empty, then Generate stays disabled", () => {
    renderEditing({}, aiProps);

    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("when the playlist has no songs, then generation is blocked with an explanation", async () => {
    const user = userEvent.setup();
    renderEditing({ songs: [], songCount: 0 }, aiProps);

    await user.type(screen.getByLabelText("Cover art prompt"), "Neon highway");

    // Cover art is derived from the tracks, so an empty playlist has nothing to
    // draw from — the reason is spelled out rather than left as a dead button.
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
    expect(screen.getByText("Add songs before generating a cover.")).toBeInTheDocument();
  });

  it("when generation succeeds, then a preview and an Apply action appear", async () => {
    const user = userEvent.setup();
    mocked.generateStudioCoverArt.mockResolvedValue({ id: "gen1" } as never);
    renderEditing({}, aiProps);

    await user.type(screen.getByLabelText("Cover art prompt"), "Neon highway");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    expect(await screen.findByAltText("Generated playlist cover")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
    // With a candidate on screen the primary action becomes a retry, not a
    // first-time generate.
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeInTheDocument();
  });

  it("when generation fails, then the server's message is surfaced", async () => {
    const user = userEvent.setup();
    mocked.generateStudioCoverArt.mockRejectedValue(new Error("quota exhausted"));
    renderEditing({}, aiProps);

    await user.type(screen.getByLabelText("Cover art prompt"), "Neon highway");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("quota exhausted");
    expect(screen.queryByAltText("Generated playlist cover")).not.toBeInTheDocument();
  });

  it("when the generated cover is applied, then it is saved and the refreshed playlist is adopted", async () => {
    const user = userEvent.setup();
    mocked.generateStudioCoverArt.mockResolvedValue({ id: "gen1" } as never);
    mocked.applyPlaylistCover.mockResolvedValue(undefined as never);
    mocked.getPlaylist.mockResolvedValue(playlistDetail({ coverArtId: "gen1" }));
    const { onPlaylistUpdate } = renderEditing({}, aiProps);

    await user.type(screen.getByLabelText("Cover art prompt"), "Neon highway");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await user.click(await screen.findByRole("button", { name: "Apply" }));

    expect(mocked.applyPlaylistCover).toHaveBeenCalledWith("p1", "gen1");
    await waitFor(() => expect(onPlaylistUpdate).toHaveBeenCalled());
    // Once applied, the candidate is no longer pending, so the preview clears.
    await waitFor(() =>
      expect(screen.queryByAltText("Generated playlist cover")).not.toBeInTheDocument(),
    );
  });

  it("when applying the cover fails, then the candidate is kept so it can be retried", async () => {
    const user = userEvent.setup();
    mocked.generateStudioCoverArt.mockResolvedValue({ id: "gen1" } as never);
    mocked.applyPlaylistCover.mockRejectedValue(new Error("500"));
    renderEditing({}, aiProps);

    await user.type(screen.getByLabelText("Cover art prompt"), "Neon highway");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    await user.click(await screen.findByRole("button", { name: "Apply" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not apply the cover");
    expect(screen.getByAltText("Generated playlist cover")).toBeInTheDocument();
  });
});

describe("PlaylistPageView cover upload", () => {
  it("when an image is picked, then the returned playlist detail is adopted", async () => {
    const user = userEvent.setup();
    mocked.uploadPlaylistCover.mockResolvedValue(playlistDetail({ coverArtId: "up1" }));
    const { container, onPlaylistUpdate } = renderEditing();

    const file = new File(["png"], "cover.png", { type: "image/png" });
    await user.upload(container.querySelector('input[type="file"]') as HTMLInputElement, file);

    expect(mocked.uploadPlaylistCover).toHaveBeenCalledWith("p1", file);
    await waitFor(() => expect(onPlaylistUpdate).toHaveBeenCalled());
  });

  it("when the cover upload fails, then an error is shown next to the cover", async () => {
    const user = userEvent.setup();
    mocked.uploadPlaylistCover.mockRejectedValue(new Error("413"));
    const { container } = renderEditing();

    await user.upload(
      container.querySelector('input[type="file"]') as HTMLInputElement,
      new File(["png"], "cover.png", { type: "image/png" }),
    );

    // This error lives outside the AI panel deliberately: an upload can fail
    // even when image generation is switched off entirely.
    expect(await screen.findByRole("alert")).toHaveTextContent("Cover upload failed");
  });

  it("when the viewer is anonymous, then the cover is inert with no file input", () => {
    render(
      <PlaylistPageView
        playlist={playlistDetail({})}
        authenticated={false}
        onPlay={() => {}}
        onShare={() => {}}
        renderRowActions={() => null}
        onTogglePublish={() => {}}
      />,
    );

    expect(document.querySelector('input[type="file"]')).toBeNull();
  });
});
