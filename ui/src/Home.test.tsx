import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GenreChapter, GenreSummary, HomeFeed, Playlist, Song, TopTenEntry } from "./api";

// Home is a feed composer: it fetches the home payload plus the genre-name→id map
// and decides what to render from them. Mocking at the api module boundary (rather
// than stubbing fetch) keeps these tests about Home's own branching — the empty
// state, the rank rows, the genre-chip linking, the hero ranked/fallback choice.
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, getHome: vi.fn(), listGenres: vi.fn() };
});

// Hero owns a timed carousel and Chapter owns fanart backgrounds; both are covered
// by their own concerns. Stubbing them keeps a Home failure attributable to Home,
// while still surfacing the props Home computes (which items, and whether they are
// ranked) so those decisions stay assertable.
vi.mock("./Hero", () => ({
  Hero: ({ items, onPlay }: { items: { song: Song; ranked: boolean }[]; onPlay: (s: Song) => void }) => (
    <div data-testid="hero" data-ranked={String(items[0]?.ranked ?? false)} data-count={items.length}>
      {items.map((it) => (
        <button key={it.song.id} onClick={() => onPlay(it.song)}>
          hero:{it.song.title}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("./Chapter", () => ({
  Chapter: ({ chapter }: { chapter: GenreChapter }) => <div data-testid="chapter">{chapter.name}</div>,
}));
// HScrollRail measures itself with a ResizeObserver, which jsdom does not provide.
// It is pure layout, so passing the children straight through loses no behaviour
// that Home is responsible for.
vi.mock("./HScrollRail", () => ({
  HScrollRail: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { Home } from "./Home";
import * as api from "./api";

const mocked = vi.mocked(api);

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
    ...overrides,
  };
}

function top(overrides: Partial<TopTenEntry> = {}): TopTenEntry {
  return { ...song(), plays: 5, ...overrides };
}

function playlist(overrides: Partial<Playlist> = {}): Playlist {
  return { id: "p1", name: "Road Trip", description: "", coverArtId: "", songCount: 4, published: true, ...overrides };
}

function chapter(overrides: Partial<GenreChapter> = {}): GenreChapter {
  return {
    id: "g1",
    name: "dream pop",
    songCount: 2,
    accentColor: "#d97757",
    hasBackground: false,
    backgroundFanartId: "",
    songs: [],
    ...overrides,
  };
}

function genre(overrides: Partial<GenreSummary> = {}): GenreSummary {
  return { id: "g1", name: "dream pop", songCount: 2, accentColor: "", hasBackground: false, backgroundFanartId: "", ...overrides };
}

function feed(overrides: Partial<HomeFeed> = {}): HomeFeed {
  return { hero: null, topTen: [], recentlyAdded: [], genres: [], playlists: [], ...overrides };
}

// Home renders nothing but "Loading" until the feed lands, so every populated-state
// test has to wait for that first paint to be replaced.
async function renderHome(props: Partial<React.ComponentProps<typeof Home>> = {}) {
  const view = render(
    <Home
      authenticated
      onPlay={vi.fn()}
      onShare={vi.fn()}
      renderRowActions={() => null}
      {...props}
    />,
  );
  await act(async () => {});
  return view;
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  mocked.getHome.mockResolvedValue(feed());
  mocked.listGenres.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Home loading and failure", () => {
  it("when the feed has not arrived yet, then it shows the loading placeholder", async () => {
    // A promise that never settles holds Home in its pre-feed state.
    mocked.getHome.mockReturnValue(new Promise<HomeFeed>(() => {}));

    render(<Home authenticated onPlay={vi.fn()} onShare={vi.fn()} renderRowActions={() => null} />);

    expect(screen.getByText("Loading")).toBeInTheDocument();
  });

  it("when the feed request fails, then it stays on the placeholder rather than rendering a half-empty page", async () => {
    mocked.getHome.mockRejectedValue(new Error("500"));

    await renderHome();

    // A failed fetch must not be mistaken for "your library is empty" — that would
    // tell a user with a full library that their music is gone.
    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(screen.queryByText("Your library is empty")).not.toBeInTheDocument();
  });

  it("when reloadKey changes, then the feed is fetched again", async () => {
    const { rerender } = await renderHome();
    expect(mocked.getHome).toHaveBeenCalledTimes(1);

    rerender(<Home authenticated onPlay={vi.fn()} onShare={vi.fn()} renderRowActions={() => null} reloadKey={2} />);
    await act(async () => {});

    // The key exists so an upload or publish toggle is reflected without a reload.
    expect(mocked.getHome).toHaveBeenCalledTimes(2);
  });
});

describe("Home empty state", () => {
  it("when the library is empty and the viewer is signed in, then it invites an upload", async () => {
    const user = userEvent.setup();
    const onUpload = vi.fn();

    await renderHome({ onUpload });
    await user.click(screen.getByRole("button", { name: /upload music/i }));

    expect(screen.getByText("Your library is empty")).toBeInTheDocument();
    expect(onUpload).toHaveBeenCalledTimes(1);
  });

  it("when the library is empty and no upload handler is wired, then no upload button is offered", async () => {
    await renderHome({ onUpload: undefined });

    // Rendering a dead button would be worse than none at all.
    expect(screen.getByText("Your library is empty")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /upload music/i })).not.toBeInTheDocument();
  });

  it("when the library is empty and the viewer is signed out, then it says nothing is here without offering an upload", async () => {
    await renderHome({ authenticated: false, onUpload: vi.fn() });

    // An anonymous visitor cannot upload, so the copy must not promise they can.
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /upload music/i })).not.toBeInTheDocument();
  });

  it("when only playlists exist, then the feed is not treated as empty", async () => {
    mocked.getHome.mockResolvedValue(feed({ playlists: [playlist()] }));

    await renderHome();

    expect(screen.queryByText("Your library is empty")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Playlists" })).toBeInTheDocument();
  });
});

describe("Home top ten", () => {
  const two = [top({ id: "a", title: "Nightcall" }), top({ id: "b", title: "Odd Look" })];

  it("when a top-ten row is played, then the rows below it become the queue tail", async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    mocked.getHome.mockResolvedValue(feed({ topTen: two }));

    await renderHome({ onPlay });
    await user.click(screen.getByRole("button", { name: "Play Nightcall" }));

    // Playing #1 must enqueue the rest of the chart, not just the one track.
    expect(onPlay).toHaveBeenCalledWith(two[0], [two[1]]);
  });

  it("when the last top-ten row is played, then the tail is empty", async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    mocked.getHome.mockResolvedValue(feed({ topTen: two }));

    await renderHome({ onPlay });
    await user.click(screen.getByRole("button", { name: "Play Odd Look" }));

    expect(onPlay).toHaveBeenCalledWith(two[1], []);
  });

  it("when the artist name of a row is clicked, then it plays that row too", async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    mocked.getHome.mockResolvedValue(feed({ topTen: [top({ id: "a", title: "Nightcall", artistName: "Kavinsky" })] }));

    await renderHome({ onPlay });
    await user.click(screen.getByRole("button", { name: "Kavinsky" }));

    // The whole row is a play target; the meta line must not be a dead zone.
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), []);
  });

  it("when the chart is rendered, then every row is numbered in order", async () => {
    mocked.getHome.mockResolvedValue(feed({ topTen: two }));

    await renderHome();

    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("when a signed-in viewer sees an unpublished chart entry, then it is badged", async () => {
    mocked.getHome.mockResolvedValue(feed({ topTen: [top({ published: false })] }));

    await renderHome();

    expect(screen.getByText(/unpublished/i)).toBeInTheDocument();
  });

  it("when a signed-out viewer sees the chart, then no publish state leaks into it", async () => {
    mocked.getHome.mockResolvedValue(feed({ topTen: [top({ published: false })] }));

    await renderHome({ authenticated: false });

    // Publish state is an owner-only concept; an anonymous visitor has no use for it.
    expect(screen.queryByText(/unpublished/i)).not.toBeInTheDocument();
  });

  it("when row actions are supplied, then they are rendered next to each row", async () => {
    mocked.getHome.mockResolvedValue(feed({ topTen: two }));

    await renderHome({ renderRowActions: (s: Song) => <span>actions:{s.id}</span> });

    expect(screen.getByText("actions:a")).toBeInTheDocument();
    expect(screen.getByText("actions:b")).toBeInTheDocument();
  });
});

describe("Home genre chips", () => {
  it("when a song's genre resolves to an id, then the chip links to that genre page", async () => {
    const user = userEvent.setup();
    mocked.getHome.mockResolvedValue(feed({ topTen: [top({ genres: ["Dream Pop"] })] }));
    // The feed carries genre NAMES; the id map is what turns them into links, and
    // the lookup is case-insensitive because the two sources disagree on casing.
    mocked.listGenres.mockResolvedValue([genre({ id: "g7", name: "dream pop" })]);

    await renderHome();
    const link = screen.getByRole("link", { name: /dream pop/i });
    await user.click(link);

    expect(link).toHaveAttribute("href", "/genre/g7");
    // The click is intercepted for SPA routing rather than doing a full page load.
    expect(window.location.pathname).toBe("/genre/g7");
  });

  it("when a song's genre has no matching id, then the chip renders as plain text", async () => {
    mocked.getHome.mockResolvedValue(feed({ topTen: [top({ genres: ["Vaporwave"] })] }));
    mocked.listGenres.mockResolvedValue([]);

    await renderHome();

    // Linking to an id we never resolved would 404; showing the label still helps.
    expect(screen.queryByRole("link", { name: /vaporwave/i })).not.toBeInTheDocument();
    expect(screen.getByText(/vaporwave/i)).toBeInTheDocument();
  });

  it("when the genre list fails to load, then chips degrade to plain text instead of breaking the feed", async () => {
    mocked.getHome.mockResolvedValue(feed({ topTen: [top({ title: "Nightcall", genres: ["Dream Pop"] })] }));
    mocked.listGenres.mockRejectedValue(new Error("500"));

    await renderHome();

    expect(screen.getByText("Nightcall")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /dream pop/i })).not.toBeInTheDocument();
  });

  it("when a song has more genres than the cap, then the extras collapse into a count", async () => {
    mocked.getHome.mockResolvedValue(feed({ topTen: [top({ genres: ["Dream Pop", "Shoegaze", "Ambient", "Trip Hop"] })] }));

    await renderHome();

    // Two shown, the remaining two summarised — the meta line must not crowd out
    // the artist name.
    expect(screen.getByText(/dream pop/i)).toBeInTheDocument();
    expect(screen.getByText(/shoegaze/i)).toBeInTheDocument();
    expect(screen.queryByText(/ambient/i)).not.toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("when a song has no genres, then no chip separator is rendered", async () => {
    mocked.getHome.mockResolvedValue(feed({ topTen: [top({ genres: [] })] }));

    const { container } = await renderHome();

    expect(container.querySelector(".genre-chip")).toBeNull();
    expect(container.querySelector(".top-genres")).toBeNull();
  });
});

describe("Home hero", () => {
  it("when there are plays, then the hero cycles the top three as ranked slides", async () => {
    mocked.getHome.mockResolvedValue(feed({
      topTen: [top({ id: "a" }), top({ id: "b" }), top({ id: "c" }), top({ id: "d" })],
      recentlyAdded: [song({ id: "z" })],
    }));

    await renderHome();

    const hero = screen.getByTestId("hero");
    expect(hero).toHaveAttribute("data-count", "3");
    expect(hero).toHaveAttribute("data-ranked", "true");
  });

  it("when nothing has been played yet, then the hero falls back to one unranked recent upload", async () => {
    mocked.getHome.mockResolvedValue(feed({ recentlyAdded: [song({ id: "z", title: "Newest" }), song({ id: "y" })] }));

    await renderHome();

    const hero = screen.getByTestId("hero");
    expect(hero).toHaveAttribute("data-count", "1");
    // Unranked: with no plays the slide has not earned a "#1" eyebrow.
    expect(hero).toHaveAttribute("data-ranked", "false");
    expect(screen.getByRole("button", { name: "hero:Newest" })).toBeInTheDocument();
  });

  it("when a hero slide is played, then it starts with an empty tail", async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    const s = top({ id: "a", title: "Nightcall" });
    mocked.getHome.mockResolvedValue(feed({ topTen: [s] }));

    await renderHome({ onPlay });
    await user.click(screen.getByRole("button", { name: "hero:Nightcall" }));

    // The hero is a spotlight, not a chart position — it does not enqueue the rest.
    expect(onPlay).toHaveBeenCalledWith(s, []);
  });
});

describe("Home recently added", () => {
  it("when a recent tile is played, then the later tiles become the tail", async () => {
    const user = userEvent.setup();
    const onPlay = vi.fn();
    const recent = [song({ id: "r1", title: "First" }), song({ id: "r2", title: "Second" })];
    mocked.getHome.mockResolvedValue(feed({ topTen: [top({ id: "a" })], recentlyAdded: recent }));

    await renderHome({ onPlay });
    await user.click(screen.getByRole("button", { name: /First/ }));

    expect(onPlay).toHaveBeenCalledWith(recent[0], [recent[1]]);
  });

  it("when the viewer is signed in, then the section links through to their library", async () => {
    const user = userEvent.setup();
    mocked.getHome.mockResolvedValue(feed({ recentlyAdded: [song()] }));

    await renderHome();
    await user.click(screen.getByText("Your library →"));

    expect(window.location.pathname).toBe("/library");
  });

  it("when the viewer is signed out, then no library link is offered", async () => {
    mocked.getHome.mockResolvedValue(feed({ recentlyAdded: [song()] }));

    await renderHome({ authenticated: false });

    // /library is an owner surface; offering it anonymously leads to a dead end.
    expect(screen.queryByText("Your library →")).not.toBeInTheDocument();
  });

  it("when there are no recent uploads, then the section is omitted entirely", async () => {
    mocked.getHome.mockResolvedValue(feed({ topTen: [top()] }));

    await renderHome();

    expect(screen.queryByRole("heading", { name: "Recently added" })).not.toBeInTheDocument();
  });
});

describe("Home genre chapters", () => {
  it("when the feed carries genre chapters, then one chapter is rendered per genre", async () => {
    mocked.getHome.mockResolvedValue(feed({
      genres: [chapter({ id: "g1", name: "dream pop" }), chapter({ id: "g2", name: "shoegaze" })],
    }));

    await renderHome();

    expect(screen.getAllByTestId("chapter")).toHaveLength(2);
    expect(screen.getByText("shoegaze")).toBeInTheDocument();
  });
});

describe("Home playlists", () => {
  it("when a playlist is clicked, then it navigates to that playlist", async () => {
    const user = userEvent.setup();
    mocked.getHome.mockResolvedValue(feed({ playlists: [playlist({ id: "p9", name: "Road Trip" })] }));

    await renderHome();
    await user.click(screen.getByRole("button", { name: /Road Trip/ }));

    expect(window.location.pathname).toBe("/playlist/p9");
  });

  it("when a playlist holds one song, then the count is singular", async () => {
    mocked.getHome.mockResolvedValue(feed({ playlists: [playlist({ songCount: 1 })] }));

    await renderHome();

    expect(screen.getByText("1 song")).toBeInTheDocument();
  });

  it("when a playlist holds several songs, then the count is plural", async () => {
    mocked.getHome.mockResolvedValue(feed({ playlists: [playlist({ songCount: 12 })] }));

    await renderHome();

    expect(screen.getByText("12 songs")).toBeInTheDocument();
  });

  it("when a playlist has cover art, then the art is shown instead of its initial", async () => {
    mocked.getHome.mockResolvedValue(feed({ playlists: [playlist({ name: "Road Trip", coverArtId: "c1" })] }));

    const { container } = await renderHome();

    expect(container.querySelector("img")).toHaveAttribute("src", expect.stringContaining("c1"));
    expect(screen.queryByText("R")).not.toBeInTheDocument();
  });

  it("when a playlist has no cover art, then it falls back to its initial", async () => {
    mocked.getHome.mockResolvedValue(feed({ playlists: [playlist({ name: "Road Trip", coverArtId: "" })] }));

    const { container } = await renderHome();

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("R")).toBeInTheDocument();
  });

  it("when the viewer is signed out, then the playlists section drops its library link", async () => {
    mocked.getHome.mockResolvedValue(feed({ playlists: [playlist()] }));

    await renderHome({ authenticated: false });

    expect(screen.getByRole("heading", { name: "Playlists" })).toBeInTheDocument();
    expect(screen.queryByText("Your library →")).not.toBeInTheDocument();
  });

  it("when the viewer is signed in, then the playlists section links to their library", async () => {
    const user = userEvent.setup();
    mocked.getHome.mockResolvedValue(feed({ playlists: [playlist()] }));

    await renderHome();
    await user.click(screen.getByText("Your library →"));

    expect(window.location.pathname).toBe("/playlists");
  });
});
