import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import { songShareUrl, playlistShareUrl, copyText } from "./share";

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

// copyText must never throw: the Clipboard API is unavailable in an insecure
// context and can be refused by permission policy, and every caller falls back to
// a prompt on false.
describe("copyText", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("when the clipboard accepts the text, then it reports success", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyText("https://music.example.com/song/abc")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://music.example.com/song/abc");
  });

  it("when the clipboard write is refused, then it reports failure instead of throwing", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.reject(new Error("NotAllowedError")) } });

    await expect(copyText("x")).resolves.toBe(false);
  });

  it("when there is no clipboard API at all, then it reports failure", async () => {
    // http:// or an old engine — the caller shows a prompt to copy by hand.
    vi.stubGlobal("navigator", {});

    await expect(copyText("x")).resolves.toBe(false);
  });
});
