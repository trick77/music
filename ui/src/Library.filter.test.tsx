import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { GenreSummary, Song } from "./api";
import { Library } from "./Library";

// The Genres tab fetches its own tiles; mocking at the api boundary keeps these
// tests about Library's filtering rather than about the network.
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, listGenres: vi.fn() };
});
// HScrollRail measures itself with a ResizeObserver, which jsdom does not
// provide. It is pure layout — passing the pills straight through loses nothing
// this file is responsible for.
vi.mock("./HScrollRail", () => ({
  HScrollRail: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { listGenres } from "./api";

// "now" for the tests is fixed by the createdAt values below rather than by a
// clock stub: Library takes its own `new Date()`, so "recent" rows are stamped
// relative to the real today and the 30-day window stays true whenever this runs.
const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 86_400_000);
  return d.toISOString().slice(0, 19).replace("T", " ");
};

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
    createdAt: daysAgo(200),
    sampleRate: 0,
    channels: 0,
    bitrateKbps: 0,
    genres: [],
    coverArtId: "",
    published: true,
    ...over,
  };
}

const SONGS = [
  song({ id: "a", title: "Neon Rain", artistName: "Aurora Fields" }),
  song({ id: "b", title: "Blue Hour", artistName: "Nova Sink" }),
  song({ id: "c", title: "Supernova Waltz", artistName: "The Slow Hours" }),
];

function renderLibrary(over: Partial<Parameters<typeof Library>[0]> = {}) {
  return render(
    <Library
      songs={SONGS}
      favoriteIds={["b"]}
      authenticated
      initialTab="all"
      onPlay={() => {}}
      renderRowActions={() => null}
      {...over}
    />,
  );
}

const titles = () =>
  screen
    .getAllByRole("listitem")
    .map((li) => li.textContent?.replace(/\d+:\d+$/, "") ?? "");

beforeEach(() => {
  vi.mocked(listGenres).mockResolvedValue([]);
  // Library scrolls the active pill into view on mount; jsdom has no layout and
  // so no scrollIntoView. It is a no-op here, not behaviour under test.
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

describe("Library filter field", () => {
  it("when a query matches a title, then only those songs remain", async () => {
    // Given a library of three songs
    renderLibrary();
    // When filtering on a word from one title
    await userEvent.type(screen.getByLabelText("Filter songs"), "blue");
    // Then only that song is listed
    expect(titles()).toHaveLength(1);
    expect(titles()[0]).toContain("Blue Hour");
  });

  it("when a query matches an artist, then that song remains too", async () => {
    // Given the artist "Nova Sink" and the title "Supernova Waltz"
    renderLibrary();
    // When filtering on "nova", which appears in one of each
    await userEvent.type(screen.getByLabelText("Filter songs"), "nova");
    // Then both are listed — the field matches title AND artist
    expect(titles()).toHaveLength(2);
  });

  it("when the query differs in case, then it still matches", async () => {
    // Given a mixed-case title
    renderLibrary();
    // When filtering in a different case
    await userEvent.type(screen.getByLabelText("Filter songs"), "NEON");
    // Then the match still holds
    expect(titles()).toHaveLength(1);
  });

  it("when the query matches nothing, then the miss is named rather than the tab's own empty state", async () => {
    // Given a library that is not itself empty
    renderLibrary();
    // When the query matches no song
    await userEvent.type(screen.getByLabelText("Filter songs"), "zzz");
    // Then the copy names the query and offers a way out
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
    expect(screen.queryByText("Nothing here yet.")).toBeNull();
    // The empty state carries its own way out, next to the field's ✕.
    expect(
      within(screen.getByText(/Nothing matches/)).getByRole("button"),
    ).toBeTruthy();
  });

  it("when the filter is cleared from the empty state, then the whole list returns", async () => {
    // Given a query that matches nothing
    renderLibrary();
    await userEvent.type(screen.getByLabelText("Filter songs"), "zzz");
    // When the empty state's clear action is used
    await userEvent.click(
      within(screen.getByText(/Nothing matches/)).getByRole("button"),
    );
    // Then every song is back
    expect(titles()).toHaveLength(3);
  });

  it("when the tab changes, then the query survives", async () => {
    // Given a query typed on All songs
    renderLibrary();
    await userEvent.type(screen.getByLabelText("Filter songs"), "nova");
    // When switching to Favorites
    await userEvent.click(screen.getByRole("button", { name: /Favorites/ }));
    // Then the query is still applied — carrying a search across categories is
    // the point of putting counts on the pills
    expect(screen.getByLabelText("Filter songs")).toHaveValue("nova");
    expect(titles()).toHaveLength(1); // "b" is the only favorite, and it matches
  });

  it("when the library is empty and nothing is typed, then the row is not rendered", () => {
    // Given no songs at all
    renderLibrary({ songs: [] });
    // Then there is no count row or field to look at
    expect(screen.queryByLabelText("Filter songs")).toBeNull();
    expect(screen.getByText("Nothing here yet.")).toBeTruthy();
  });
});

describe("Library counts", () => {
  it("when nothing is typed, then the row counts the whole category", () => {
    // Given three songs on All songs
    renderLibrary();
    // Then the row states the plain total
    expect(screen.getByText("3 songs")).toBeTruthy();
  });

  it("when a query is active, then the row shows matches of the category total", async () => {
    // Given a query matching two of three
    renderLibrary();
    await userEvent.type(screen.getByLabelText("Filter songs"), "nova");
    // Then the denominator is the category total, NOT the match count
    expect(screen.getByText("2 of 3")).toBeTruthy();
    expect(screen.getByText(/songs match/)).toBeTruthy();
  });

  it("when a query is active, then every pill counts its own matches", async () => {
    // Given "nova" matches 2 of all songs but only 1 favorite
    renderLibrary();
    await userEvent.type(screen.getByLabelText("Filter songs"), "nova");
    // Then each pill answers "is it hiding under there?" without being opened
    expect(screen.getByRole("button", { name: "All songs 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Favorites 1" })).toBeTruthy();
  });

  it("when the category is smaller than the library, then the denominator is the category, not the library", async () => {
    // Given Favorites, which holds 1 of the library's 3 songs
    renderLibrary({ initialTab: "favorites" });
    // When a query matches that one favorite
    await userEvent.type(screen.getByLabelText("Filter songs"), "blue");
    // Then the denominator is the category total (1), not the library total (3)
    // and not the match count — the pool the numbers describe must be one pool
    expect(screen.getByText("1 of 1")).toBeTruthy();
    expect(screen.queryByText("1 of 3")).toBeNull();
  });

  it("when the field's own clear button is used, then the whole list returns", async () => {
    // Given a query typed into the field
    renderLibrary();
    const field = screen.getByLabelText("Filter songs");
    await userEvent.type(field, "blue");
    // When the ✕ inside the field is clicked
    await userEvent.click(
      screen.getByRole("button", { name: "Clear the filter" }),
    );
    // Then the field is empty and every song is back
    expect(field).toHaveValue("");
    expect(titles()).toHaveLength(3);
  });

  it("when the category is named, then the count uses that noun", async () => {
    // Given the Favorites tab
    renderLibrary({ initialTab: "favorites" });
    // When a query matches nothing there
    await userEvent.type(screen.getByLabelText("Filter songs"), "zzz");
    // Then the row says "favorites", not "songs"
    expect(screen.getByText(/No favorites match/)).toBeTruthy();
  });
});

describe("Library Recently added", () => {
  const RECENT = [
    song({ id: "r1", title: "Velvet Antenna", createdAt: daysAgo(0) }),
    song({ id: "r2", title: "Driftwood Telephone", createdAt: daysAgo(1) }),
    song({ id: "r3", title: "Cinder Lantern", createdAt: daysAgo(3) }),
    song({ id: "old", title: "Amber Static", createdAt: daysAgo(200) }),
  ];

  it("when the tab is opened, then only the last 30 days are listed", () => {
    // Given three recent songs and one from long ago
    renderLibrary({ songs: RECENT, initialTab: "recent" });
    // Then the old one is out of the window
    expect(titles()).toHaveLength(3);
    expect(screen.queryByText("Amber Static")).toBeNull();
  });

  it("when songs span days, then they are grouped newest first under day headings", () => {
    // Given songs added today, yesterday and three days ago
    renderLibrary({ songs: RECENT, initialTab: "recent" });
    // Then the headings name the calendar days, newest group first
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(headings.slice(0, 2)).toEqual(["Today", "Yesterday"]);
    expect(headings).toHaveLength(3);
    expect(titles()[0]).toContain("Velvet Antenna");
  });

  it("when a song has no usable timestamp, then it is not counted as recent", () => {
    // Given a row the backfill never stamped
    renderLibrary({
      songs: [song({ id: "x", title: "No Date", createdAt: "" })],
      initialTab: "recent",
    });
    // Then "we don't know when" is not treated as "just now"
    expect(screen.getByText("Nothing added in the last 30 days.")).toBeTruthy();
  });

  it("when nothing is recent, then the field is not offered", () => {
    // Given an old-only library on the Recently added tab
    renderLibrary({
      songs: [song({ createdAt: daysAgo(200) })],
      initialTab: "recent",
    });
    // Then there is nothing to filter, so no field
    expect(screen.queryByLabelText("Filter songs")).toBeNull();
  });
});

describe("Library Genres tab", () => {
  const GENRES: GenreSummary[] = [
    {
      id: "g1",
      name: "synthwave",
      songCount: 4,
      hasBackground: true,
      backgroundFanartId: "f1",
      accentColor: "",
    },
    {
      id: "g2",
      name: "shoegaze",
      songCount: 2,
      hasBackground: true,
      backgroundFanartId: "f2",
      accentColor: "",
    },
  ];

  it("when a query is typed, then the tiles are filtered by name", async () => {
    // Given two genres
    vi.mocked(listGenres).mockResolvedValue(GENRES);
    renderLibrary({ initialTab: "genres" });
    const field = await screen.findByLabelText("Filter genres");
    // When filtering on one of their names
    await userEvent.type(field, "shoe");
    // Then only that tile remains — the page's one search box stays live here
    expect(await screen.findByText("Shoegaze")).toBeTruthy();
    expect(screen.queryByText("Synthwave")).toBeNull();
  });

  it("when the query matches no genre, then the miss is named", async () => {
    // Given two genres and a query matching neither
    vi.mocked(listGenres).mockResolvedValue(GENRES);
    renderLibrary({ initialTab: "genres" });
    await userEvent.type(await screen.findByLabelText("Filter genres"), "zzz");
    // Then the copy names the query rather than claiming every genre has artwork
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
    expect(screen.queryByText("Every genre has artwork.")).toBeNull();
  });

  it("when the artwork toggle and a query are both on, then the count describes the tiles actually shown", async () => {
    // Given four genres, of which only one lacks artwork
    vi.mocked(listGenres).mockResolvedValue([
      ...GENRES,
      {
        id: "g3",
        name: "shoal ambient",
        songCount: 1,
        hasBackground: false,
        backgroundFanartId: "",
        accentColor: "",
      },
      {
        id: "g4",
        name: "dream pop",
        songCount: 3,
        hasBackground: true,
        backgroundFanartId: "f4",
        accentColor: "",
      },
    ]);
    renderLibrary({ initialTab: "genres" });
    // When the artwork filter is on and a query matches two genres, only one of
    // which lacks artwork
    await userEvent.click(
      await screen.findByRole("button", { name: /Needs artwork only/ }),
    );
    await userEvent.type(await screen.findByLabelText("Filter genres"), "sho");
    // Then the row counts the same pool the grid renders — one tile, one match
    expect(screen.getByText("Shoal Ambient")).toBeTruthy();
    expect(screen.getByText("1 of 1")).toBeTruthy();
    expect(screen.queryByText("Shoegaze")).toBeNull(); // matches, but has artwork
  });

  it("when the Genres tab is open, then its pill carries no count", async () => {
    // Given the Genres tab, which lists tiles rather than songs
    vi.mocked(listGenres).mockResolvedValue(GENRES);
    renderLibrary({ initialTab: "genres" });
    // Then the pill is a bare label — there is no comparable song count
    const pill = await screen.findByRole("button", { name: "Genres" });
    expect(within(pill).queryByText(/^\d+$/)).toBeNull();
  });
});
