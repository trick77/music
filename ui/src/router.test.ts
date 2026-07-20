import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { reactStub, renderHook } from "./testHooks";

vi.mock("react", () => reactStub);

const { parsePath, parsePlayerParam, pushPlayer, replacePlayer, closeToOrigin, leaveLyricsForArtwork, navigate, useRoute } =
  await import("./router");

describe("parsePath", () => {
  it("maps root to home", () => {
    expect(parsePath("/")).toEqual({ name: "home" });
  });
  it("maps /library, /favorites, /unpublished and /playlists", () => {
    expect(parsePath("/library")).toEqual({ name: "library" });
    expect(parsePath("/favorites")).toEqual({ name: "favorites" });
    expect(parsePath("/unpublished")).toEqual({ name: "unpublished" });
    expect(parsePath("/playlists")).toEqual({ name: "playlists" });
  });
  it("extracts song id", () => {
    expect(parsePath("/song/abc123")).toEqual({ name: "song", id: "abc123" });
  });
  it("extracts playlist id", () => {
    expect(parsePath("/playlist/xyz")).toEqual({ name: "playlist", id: "xyz" });
  });
  it("parses the genres list route", () => {
    expect(parsePath("/genres")).toEqual({ name: "genres" });
  });
  it("parses the visualizer route", () => {
    expect(parsePath("/visualizer")).toEqual({ name: "visualizer" });
  });
  it("parses a genre detail route", () => {
    expect(parsePath("/genre/g1")).toEqual({ name: "genre", id: "g1" });
  });
  it("parses the studio route with and without a target genre", () => {
    expect(parsePath("/studio")).toEqual({ name: "studio" });
    expect(parsePath("/studio/genre/g1")).toEqual({ name: "studio", genreId: "g1" });
  });
  it("parses the search and artist routes", () => {
    expect(parsePath("/search")).toEqual({ name: "search" });
    expect(parsePath("/artist/a1")).toEqual({ name: "artist", id: "a1" });
  });
  it("tolerates trailing and doubled slashes", () => {
    // Empty segments are filtered, so /library/ and //library are the same route.
    expect(parsePath("/library/")).toEqual({ name: "library" });
    expect(parsePath("//library//")).toEqual({ name: "library" });
    expect(parsePath("")).toEqual({ name: "home" });
  });
  it("falls back to home for unknown paths", () => {
    expect(parsePath("/nope/deep/path")).toEqual({ name: "home" });
  });
  it("falls back to home rather than inventing a route from a bad shape", () => {
    // A known prefix with the wrong arity is not that route — /song with no id
    // must not become a song page with an undefined id.
    expect(parsePath("/song")).toEqual({ name: "home" });
    expect(parsePath("/song/a/b")).toEqual({ name: "home" });
    expect(parsePath("/playlist")).toEqual({ name: "home" });
    expect(parsePath("/studio/genre")).toEqual({ name: "home" });
    expect(parsePath("/genres/g1")).toEqual({ name: "home" });
  });
  it("keeps ids opaque, including url-encoded ones", () => {
    expect(parsePath("/song/a%20b")).toEqual({ name: "song", id: "a%20b" });
  });
});

describe("parsePlayerParam", () => {
  it("reads player=lyrics", () => {
    expect(parsePlayerParam("?player=lyrics")).toBe("lyrics");
  });
  it("reads player=full", () => {
    expect(parsePlayerParam("?player=full")).toBe("full");
  });
  it("tolerates a missing leading question mark", () => {
    expect(parsePlayerParam("player=lyrics")).toBe("lyrics");
  });
  it("returns null when the param is absent", () => {
    expect(parsePlayerParam("?foo=bar")).toBeNull();
    expect(parsePlayerParam("")).toBeNull();
  });
  it("returns null for an unknown player value", () => {
    expect(parsePlayerParam("?player=wat")).toBeNull();
  });
});

describe("player URL helpers", () => {
  let pushState: ReturnType<typeof vi.fn>;
  let replaceState: ReturnType<typeof vi.fn>;
  let back: ReturnType<typeof vi.fn>;
  let dispatchEvent: ReturnType<typeof vi.fn>;

  // state is what history.state would hold on the current entry: our marker when
  // we pushed the entry ourselves, null on a cold deep link.
  const stubWindow = (state: unknown) => {
    vi.stubGlobal("window", {
      location: { pathname: "/song/abc", search: "?player=lyrics" },
      history: { pushState, replaceState, back, state },
      dispatchEvent,
    });
  };

  beforeEach(() => {
    pushState = vi.fn();
    replaceState = vi.fn();
    back = vi.fn();
    dispatchEvent = vi.fn();
    stubWindow({ appPushed: true });
    vi.stubGlobal("PopStateEvent", class {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pushPlayer pushes the song deep link, marked as ours, and notifies listeners", () => {
    pushPlayer("abc", "lyrics");
    // The marker is what lets the close tell an in-app open from a deep link.
    expect(pushState).toHaveBeenCalledWith({ appPushed: true }, "", "/song/abc?player=lyrics");
    expect(replaceState).not.toHaveBeenCalled();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it("replacePlayer replaces in place (no new history entry)", () => {
    replacePlayer("abc", "full");
    expect(replaceState).toHaveBeenCalledWith({ appPushed: true }, "", "/song/abc?player=full");
    expect(pushState).not.toHaveBeenCalled();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it("replacePlayer carries the entry's marker across, rather than inventing one", () => {
    // A deep-link entry replaced in place must stay a deep-link entry, or its
    // close would try to go back to a page the visitor never came from.
    stubWindow(null);
    replacePlayer("abc", "full");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/song/abc?player=full");
  });

  it("closeToOrigin returns to the trigger point when we pushed the entry", () => {
    closeToOrigin();
    expect(back).toHaveBeenCalledTimes(1);
    expect(replaceState).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("closeToOrigin navigates Home when arrived via a fresh deep link", () => {
    // Nothing behind the entry to return to — going back would leave the app.
    stubWindow(null);
    closeToOrigin();
    expect(back).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(pushState).toHaveBeenCalledWith({ appPushed: true }, "", "/");
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it("closeToOrigin treats a foreign history entry as a deep link", () => {
    // Another app's pushState (or a browser-restored entry) is not ours to pop.
    stubWindow({ someoneElse: true });
    closeToOrigin();
    expect(back).not.toHaveBeenCalled();
    expect(pushState).toHaveBeenCalledWith({ appPushed: true }, "", "/");
  });

  it("pushPlayer records the state it was opened out of", () => {
    pushPlayer("abc", "lyrics", "full");
    expect(pushState).toHaveBeenCalledWith({ appPushed: true, from: "full" }, "", "/song/abc?player=lyrics");
  });

  it("leaveLyricsForArtwork pops back to the big player it was opened from", () => {
    // Rewriting in place would leave a second ?player=full entry stacked on the
    // real one, and the next X would land on the twin and look dead.
    stubWindow({ appPushed: true, from: "full" });
    leaveLyricsForArtwork("abc");
    expect(back).toHaveBeenCalledTimes(1);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("leaveLyricsForArtwork rewrites in place when opened straight from the mini bar", () => {
    // Nothing to fall back to — going back would close the player the viewer is
    // still using, rather than dropping them onto the artwork.
    stubWindow({ appPushed: true });
    leaveLyricsForArtwork("abc");
    expect(back).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledWith({ appPushed: true }, "", "/song/abc?player=full");
  });

  it("leaveLyricsForArtwork rewrites in place on a dishonest deep link", () => {
    stubWindow(null);
    leaveLyricsForArtwork("abc");
    expect(back).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/song/abc?player=full");
  });
});

// navigate() and useRoute() are the SPA plumbing: pushState alone fires no
// popstate, so navigate dispatches a synthetic one and useRoute listens for it.
describe("navigate and useRoute", () => {
  let pathname: string;
  let pushState: ReturnType<typeof vi.fn>;
  let handlers: Record<string, Array<() => void>>;
  let removed: string[];

  beforeEach(() => {
    pathname = "/library";
    pushState = vi.fn((_s: unknown, _t: string, path: string) => {
      pathname = path; // the browser would; useRoute re-reads location on popstate
    });
    handlers = {};
    removed = [];
    vi.stubGlobal("window", {
      get location() {
        return { pathname, search: "" };
      },
      history: { pushState, replaceState: vi.fn(), back: vi.fn(), state: null },
      dispatchEvent: () => {
        for (const fn of handlers["popstate"] ?? []) fn();
      },
      addEventListener: (t: string, fn: () => void) => (handlers[t] ??= []).push(fn),
      removeEventListener: (t: string, fn: () => void) => {
        removed.push(t);
        handlers[t] = (handlers[t] ?? []).filter((h) => h !== fn);
      },
    });
    vi.stubGlobal("PopStateEvent", class {});
  });

  afterEach(() => vi.unstubAllGlobals());

  it("when navigating somewhere new, then the entry is marked ours and listeners re-render", () => {
    const view = renderHook(() => useRoute());
    expect(view.result()).toEqual({ name: "library" });

    navigate("/genre/rock");

    expect(pushState).toHaveBeenCalledWith({ appPushed: true }, "", "/genre/rock");
    expect(view.result()).toEqual({ name: "genre", id: "rock" });

    view.unmount();
  });

  it("when navigating to the page already shown, then no history entry is added", () => {
    // Re-tapping the active tab must not stack a duplicate entry the back button
    // then has to step through.
    const view = renderHook(() => useRoute());

    navigate("/library");

    expect(pushState).not.toHaveBeenCalled();
    expect(view.result()).toEqual({ name: "library" });

    view.unmount();
  });

  it("when the user presses back, then the route follows the browser", () => {
    const view = renderHook(() => useRoute());
    navigate("/song/abc");
    expect(view.result()).toEqual({ name: "song", id: "abc" });

    pathname = "/library"; // as popping the entry would leave it
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(view.result()).toEqual({ name: "library" });

    view.unmount();
  });

  it("when the component unmounts, then it stops listening", () => {
    const view = renderHook(() => useRoute());
    view.unmount();

    expect(removed).toEqual(["popstate"]);
    expect(handlers["popstate"]).toEqual([]);
  });
});
