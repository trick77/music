import { describe, expect, it, vi, beforeAll } from "vitest";
import { songShareUrl, playlistShareUrl } from "./share";

// Vitest runs in a node environment (no DOM); stub location for the URL helpers.
beforeAll(() => {
  vi.stubGlobal("location", { origin: "https://music.example.com" });
});

describe("share urls", () => {
  it("builds an absolute song url from the current origin", () => {
    expect(songShareUrl("abc")).toBe("https://music.example.com/song/abc");
  });
  it("builds an absolute playlist url", () => {
    expect(playlistShareUrl("xyz")).toBe("https://music.example.com/playlist/xyz");
  });
});
