import { describe, expect, it } from "vitest";
import { parsePath, parsePlayerParam } from "./router";

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
