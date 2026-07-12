import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { parsePath, parsePlayerParam, clearPlayerParam } from "./router";

describe("parsePath", () => {
  it("maps root to home", () => {
    expect(parsePath("/")).toEqual({ name: "home" });
  });
  it("maps /library, /favorites and /playlists", () => {
    expect(parsePath("/library")).toEqual({ name: "library" });
    expect(parsePath("/favorites")).toEqual({ name: "favorites" });
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

describe("clearPlayerParam", () => {
  let mockReplaceState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Stub window for node environment with location and history
    mockReplaceState = vi.fn();
    vi.stubGlobal("window", {
      location: { href: "https://example.com/song/abc?player=lyrics&foo=bar#section" },
      history: { replaceState: mockReplaceState },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes the player key from the current URL", () => {
    clearPlayerParam();
    expect(mockReplaceState).toHaveBeenCalledWith({}, "", "/song/abc?foo=bar#section");
  });

  it("preserves other query keys", () => {
    (window.location as any).href = "https://example.com/song/abc?player=lyrics&foo=bar&baz=qux";
    clearPlayerParam();
    expect(mockReplaceState).toHaveBeenCalledWith({}, "", "/song/abc?foo=bar&baz=qux");
  });

  it("preserves the pathname", () => {
    (window.location as any).href = "https://example.com/playlist/xyz?player=full";
    clearPlayerParam();
    expect(mockReplaceState).toHaveBeenCalledWith({}, "", "/playlist/xyz");
  });

  it("preserves hash fragment", () => {
    (window.location as any).href = "https://example.com/song/abc?player=lyrics#top";
    clearPlayerParam();
    expect(mockReplaceState).toHaveBeenCalledWith({}, "", "/song/abc#top");
  });

  it("handles URL with only player param", () => {
    (window.location as any).href = "https://example.com/song/abc?player=lyrics";
    clearPlayerParam();
    expect(mockReplaceState).toHaveBeenCalledWith({}, "", "/song/abc");
  });

  it("calls replaceState (does not push history)", () => {
    clearPlayerParam();
    expect(mockReplaceState).toHaveBeenCalledTimes(1);
  });
});
