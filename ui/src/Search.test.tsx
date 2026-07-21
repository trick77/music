import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ArtistSummary,
  GenreSummary,
  Playlist,
  SearchResults,
  Song,
} from "./api";

// Search owns a debounced fetch and then fans the response out into five
// sections. Mocking at the api module boundary keeps these tests about that
// fan-out and the click handlers, rather than about fetch plumbing that
// api.test.ts already covers.
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, search: vi.fn() };
});

// navigate() performs a real history push and dispatches to the router, so
// stubbing it both isolates the assertion and stops one test's navigation from
// leaking into the next.
vi.mock("./router", () => ({ navigate: vi.fn() }));

import { Search } from "./Search";
import * as api from "./api";
import { navigate } from "./router";
import { player as playerApi } from "./player";

const mocked = vi.mocked(api);
const mockNavigate = vi.mocked(navigate);

function song(overrides: Partial<Song> = {}): Song {
  return {
    id: "s1",
    title: "Golden Hour",
    artistName: "Kavinsky",
    album: "",
    year: 0,
    trackNo: 0,
    trackTotal: 0,
    durationMs: 210000,
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

function artist(overrides: Partial<ArtistSummary> = {}): ArtistSummary {
  return { id: "a1", name: "Kavinsky", songCount: 3, ...overrides };
}

function genre(overrides: Partial<GenreSummary> = {}): GenreSummary {
  return {
    id: "g1",
    name: "synthwave",
    songCount: 12,
    accentColor: "",
    hasBackground: false,
    backgroundFanartId: "",
    ...overrides,
  };
}

function playlist(overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: "p1",
    name: "Road Trip",
    description: "",
    coverArtId: "",
    songCount: 2,
    published: true,
    ...overrides,
  };
}

function results(overrides: Partial<SearchResults> = {}): SearchResults {
  return {
    top: null,
    songs: [],
    artists: [],
    genres: [],
    playlists: [],
    ...overrides,
  };
}

// Types into the search box and waits for the 200ms debounce to elapse and the
// mocked search() to be consumed. Real timers are used deliberately: userEvent
// awaits timers internally, so fake timers here would deadlock rather than fail.
async function searchFor(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
) {
  await user.type(screen.getByPlaceholderText(/Search songs, artists/), text);
  await waitFor(() => expect(mocked.search).toHaveBeenCalled());
}

beforeEach(() => {
  // The player is a module-level singleton, so a track cued by an earlier test
  // would otherwise still read as "current" here and light up the playing state.
  playerApi.setQueue([]);
  playerApi.remove(playerApi.getState().current?.id ?? "");
  mocked.search.mockResolvedValue(results());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Search empty state", () => {
  it("when the query is blank, then it prompts the user instead of showing sections", () => {
    render(<Search onPlay={() => {}} />);

    expect(
      screen.getByText("Start typing to search your library."),
    ).toBeInTheDocument();
    // A blank query must not hit the backend at all — the effect returns early.
    expect(mocked.search).not.toHaveBeenCalled();
  });

  it("when the query is only whitespace, then no search is issued", async () => {
    const user = userEvent.setup();
    render(<Search onPlay={() => {}} />);

    await user.type(
      screen.getByPlaceholderText(/Search songs, artists/),
      "   ",
    );

    expect(
      screen.getByText("Start typing to search your library."),
    ).toBeInTheDocument();
    expect(mocked.search).not.toHaveBeenCalled();
  });

  it("when the query is cleared after a search, then the results are dropped and the prompt returns", async () => {
    const user = userEvent.setup();
    mocked.search.mockResolvedValue(
      results({ songs: [song({ title: "Nightcall" })] }),
    );
    render(<Search onPlay={() => {}} />);

    await searchFor(user, "night");
    expect(await screen.findByText("Nightcall")).toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText(/Search songs, artists/));

    // Stale results for a query the user has deleted would be actively
    // misleading, so the effect nulls them rather than leaving them on screen.
    expect(screen.queryByText("Nightcall")).not.toBeInTheDocument();
    expect(
      screen.getByText("Start typing to search your library."),
    ).toBeInTheDocument();
  });
});

describe("Search request handling", () => {
  it("when the user types, then the query is passed through to the search API", async () => {
    const user = userEvent.setup();
    render(<Search onPlay={() => {}} />);

    await searchFor(user, "kavinsky");

    expect(mocked.search).toHaveBeenCalledWith("kavinsky");
  });

  it("when the search request rejects, then it degrades to the blank result set rather than crashing", async () => {
    const user = userEvent.setup();
    mocked.search.mockRejectedValue(new Error("500"));
    render(<Search onPlay={() => {}} />);

    await searchFor(user, "boom");

    // The catch resets results to null, so no section — and notably not the
    // "No results" line, which is reserved for a successful empty response.
    await waitFor(() => expect(mocked.search).toHaveBeenCalled());
    expect(screen.queryByText(/No results for/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Songs" }),
    ).not.toBeInTheDocument();
  });

  it("when the response is completely empty, then it says so and names the query", async () => {
    const user = userEvent.setup();
    mocked.search.mockResolvedValue(results());
    render(<Search onPlay={() => {}} />);

    await searchFor(user, "zzzz");

    expect(await screen.findByText(/No results for/)).toHaveTextContent("zzzz");
  });
});

describe("Search sections", () => {
  it("when the response has songs, then each song renders with its artist", async () => {
    const user = userEvent.setup();
    mocked.search.mockResolvedValue(
      results({
        songs: [
          song({ id: "s1", title: "Nightcall", artistName: "Kavinsky" }),
          song({ id: "s2", title: "Odd Look", artistName: "Kavinsky" }),
        ],
      }),
    );
    render(<Search onPlay={() => {}} />);

    await searchFor(user, "kav");

    expect(
      await screen.findByRole("heading", { name: "Songs" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Nightcall")).toBeInTheDocument();
    expect(screen.getByText("Odd Look")).toBeInTheDocument();
    // Sections with no hits are omitted entirely rather than rendered empty.
    expect(
      screen.queryByRole("heading", { name: "Artists" }),
    ).not.toBeInTheDocument();
  });

  it("when an artist has exactly one song, then the count is singular", async () => {
    const user = userEvent.setup();
    mocked.search.mockResolvedValue({
      ...results(),
      artists: [artist({ id: "a1", name: "Kavinsky", songCount: 1 })],
    });
    render(<Search onPlay={() => {}} />);

    await searchFor(user, "kav");

    expect(await screen.findByText("1 song")).toBeInTheDocument();
  });

  it("when an artist has several songs, then the count is pluralised", async () => {
    const user = userEvent.setup();
    mocked.search.mockResolvedValue({
      ...results(),
      artists: [artist({ songCount: 4 })],
    });
    render(<Search onPlay={() => {}} />);

    await searchFor(user, "kav");

    expect(await screen.findByText("4 songs")).toBeInTheDocument();
  });

  it("when the response has genres and playlists, then both sections render their labels", async () => {
    const user = userEvent.setup();
    mocked.search.mockResolvedValue(
      results({
        genres: [genre({ id: "g1", name: "synthwave" })],
        playlists: [playlist({ id: "p1", name: "Road Trip" })],
      }),
    );
    render(<Search onPlay={() => {}} />);

    await searchFor(user, "s");

    expect(
      await screen.findByRole("heading", { name: "Genres" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Playlists" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Road Trip")).toBeInTheDocument();
    // Genre names are stored lowercase and title-cased for display.
    expect(screen.getByText("Synthwave")).toBeInTheDocument();
  });

  it("when a playlist has a cover, then it renders the artwork instead of the initial fallback", async () => {
    const user = userEvent.setup();
    mocked.search.mockResolvedValue(
      results({
        playlists: [playlist({ name: "Road Trip", coverArtId: "cov1" })],
      }),
    );
    const { container } = render(<Search onPlay={() => {}} />);

    await searchFor(user, "road");

    await screen.findByText("Road Trip");
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("cov1"),
    );
    // The "R" initial placeholder is only for playlists that have no cover.
    expect(screen.queryByText("R")).not.toBeInTheDocument();
  });

  it("when a playlist has no cover, then it falls back to the name initial", async () => {
    const user = userEvent.setup();
    mocked.search.mockResolvedValue(
      results({ playlists: [playlist({ name: "Road Trip", coverArtId: "" })] }),
    );
    render(<Search onPlay={() => {}} />);

    await searchFor(user, "road");

    expect(await screen.findByText("R")).toBeInTheDocument();
  });
});

describe("Search row interaction", () => {
  it("when a song row is clicked, then it plays that song with the rest of the list as the tail", async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    const first = song({ id: "s1", title: "Nightcall" });
    const second = song({ id: "s2", title: "Odd Look" });
    const third = song({ id: "s3", title: "Protovision" });
    mocked.search.mockResolvedValue(results({ songs: [first, second, third] }));
    render(<Search onPlay={onPlay} />);

    await searchFor(user, "kav");
    await user.click(await screen.findByText("Odd Look"));

    // Clicking mid-list queues everything *after* it, so the section reads as a
    // playable running order rather than a set of isolated tracks.
    expect(onPlay).toHaveBeenCalledWith(second, [third]);
  });

  it("when an artist row is clicked, then it navigates to that artist", async () => {
    const user = userEvent.setup();
    mocked.search.mockResolvedValue(
      results({ artists: [artist({ id: "a7" })] }),
    );
    render(<Search onPlay={() => {}} />);

    await searchFor(user, "kav");
    await user.click(await screen.findByText("Kavinsky"));

    expect(mockNavigate).toHaveBeenCalledWith("/artist/a7");
  });

  it("when a genre row is clicked, then it navigates to that genre", async () => {
    const user = userEvent.setup();
    mocked.search.mockResolvedValue(results({ genres: [genre({ id: "g7" })] }));
    render(<Search onPlay={() => {}} />);

    await searchFor(user, "syn");
    await user.click(await screen.findByText("Synthwave"));

    expect(mockNavigate).toHaveBeenCalledWith("/genre/g7");
  });

  it("when a playlist row is clicked, then it navigates to that playlist", async () => {
    const user = userEvent.setup();
    mocked.search.mockResolvedValue(
      results({ playlists: [playlist({ id: "p7" })] }),
    );
    render(<Search onPlay={() => {}} />);

    await searchFor(user, "road");
    await user.click(await screen.findByText("Road Trip"));

    expect(mockNavigate).toHaveBeenCalledWith("/playlist/p7");
  });
});

describe("Search top result", () => {
  it("when the top hit is a song, then it is labelled and clicking it plays with no tail", async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    const hit = song({ id: "s1", title: "Nightcall" });
    mocked.search.mockResolvedValue(
      results({
        top: { type: "song", id: "s1" },
        songs: [hit, song({ id: "s2", title: "Odd Look" })],
      }),
    );
    render(<Search onPlay={onPlay} />);

    await searchFor(user, "night");
    const top = await screen.findByRole("heading", { name: "Top result" });
    await user.click(top.parentElement!.querySelector("button")!);

    // The Top result is a single deliberate pick, not a list position, so it
    // deliberately starts an empty queue rather than trailing the Songs section.
    expect(onPlay).toHaveBeenCalledWith(hit, []);
    expect(screen.getByText("song")).toBeInTheDocument();
  });

  it("when the top hit is an artist, then clicking it navigates to the artist page", async () => {
    const user = userEvent.setup();
    mocked.search.mockResolvedValue(
      results({
        top: { type: "artist", id: "a1" },
        artists: [artist({ id: "a1", name: "Kavinsky" })],
      }),
    );
    render(<Search onPlay={() => {}} />);

    await searchFor(user, "kav");
    const top = await screen.findByRole("heading", { name: "Top result" });
    await user.click(top.parentElement!.querySelector("button")!);

    expect(mockNavigate).toHaveBeenCalledWith("/artist/a1");
  });

  it("when the top hit is a genre, then the label is title-cased and it navigates to the genre", async () => {
    const user = userEvent.setup();
    mocked.search.mockResolvedValue(
      results({
        top: { type: "genre", id: "g1" },
        genres: [genre({ id: "g1", name: "synthwave" })],
      }),
    );
    render(<Search onPlay={() => {}} />);

    await searchFor(user, "syn");
    const top = await screen.findByRole("heading", { name: "Top result" });
    await user.click(top.parentElement!.querySelector("button")!);

    expect(mockNavigate).toHaveBeenCalledWith("/genre/g1");
  });

  it("when the top hit is a playlist, then it shows its cover and navigates to the playlist", async () => {
    const user = userEvent.setup();
    mocked.search.mockResolvedValue(
      results({
        top: { type: "playlist", id: "p1" },
        playlists: [
          playlist({ id: "p1", name: "Road Trip", coverArtId: "pcov" }),
        ],
      }),
    );
    const { container } = render(<Search onPlay={() => {}} />);

    await searchFor(user, "road");
    const top = await screen.findByRole("heading", { name: "Top result" });

    // Top carries only {type,id}, so the cover has to be resolved by looking the
    // playlist back up in its own section — a regression there shows as no image.
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("pcov"),
    );

    await user.click(top.parentElement!.querySelector("button")!);
    expect(mockNavigate).toHaveBeenCalledWith("/playlist/p1");
  });

  it("when the top hit references an id missing from its section, then it renders a blank label and does nothing on click", async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    mocked.search.mockResolvedValue(
      results({
        top: { type: "song", id: "gone" },
        songs: [song({ id: "s1", title: "Nightcall" })],
      }),
    );
    render(<Search onPlay={onPlay} />);

    await searchFor(user, "night");
    const top = await screen.findByRole("heading", { name: "Top result" });
    await user.click(top.parentElement!.querySelector("button")!);

    // A dangling top id must not crash the section or fire a play with undefined.
    expect(onPlay).not.toHaveBeenCalled();
    expect(screen.getByText("song")).toBeInTheDocument();
  });

  it("when the top song is the one currently playing, then it is marked with the now-playing bars", async () => {
    const user = userEvent.setup();
    const hit = song({ id: "s1", title: "Nightcall" });
    playerApi.play(hit, []);
    // test-setup stubs HTMLMediaElement.play() to a no-op promise, so the "play"
    // event that flips the store's `playing` flag never fires on its own.
    act(() => {
      playerApi.getAudioElement()?.dispatchEvent(new Event("play"));
    });
    mocked.search.mockResolvedValue(
      results({ top: { type: "song", id: "s1" }, songs: [hit] }),
    );
    const { container } = render(<Search onPlay={() => {}} />);

    await searchFor(user, "night");
    await screen.findByRole("heading", { name: "Top result" });

    // The equalizer overlay only mounts when the top hit is the live track, so
    // its presence is the assertion that the current-song comparison still works.
    await waitFor(() =>
      expect(container.querySelector(".eq-bars")).toBeTruthy(),
    );
  });
});
