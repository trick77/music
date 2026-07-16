import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { parsePath, parsePlayerParam, pushPlayer, replacePlayer, closeToOrigin } from "./router";

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
  it("falls back to home for unknown paths", () => {
    expect(parsePath("/nope/deep/path")).toEqual({ name: "home" });
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
});
