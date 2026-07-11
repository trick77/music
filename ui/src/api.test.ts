import { describe, it, expect, vi, afterEach } from "vitest";
import { coverUrl } from "./cover";
import { getHome, getTopTen, search, reportPlay, getFavorites, addFavorite, removeFavorite } from "./api";

function mockFetch(body: unknown, ok = true) {
  const spy = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

afterEach(() => vi.restoreAllMocks());

describe("coverUrl", () => {
  it("builds a plain URL without a size", () => {
    expect(coverUrl("abc")).toBe("/api/cover/abc");
  });
  it("appends the size variant", () => {
    expect(coverUrl("abc", "card")).toBe("/api/cover/abc?size=card");
  });
  it("returns empty string for no id", () => {
    expect(coverUrl("")).toBe("");
  });
});

describe("api clients", () => {
  it("getHome hits /api/home", async () => {
    const f = mockFetch({ hero: null, topTen: [], recentlyAdded: [], genres: [], playlists: [] });
    const feed = await getHome();
    expect(f).toHaveBeenCalledWith("/api/home");
    expect(feed.topTen).toEqual([]);
  });

  it("getTopTen unwraps data.songs", async () => {
    const f = mockFetch({ songs: [{ id: "s1", plays: 3 }] });
    const top = await getTopTen();
    expect(f).toHaveBeenCalledWith("/api/top-ten");
    expect(top[0].id).toBe("s1");
  });

  it("search encodes the query", async () => {
    const f = mockFetch({ top: null, songs: [], artists: [], genres: [], playlists: [] });
    await search("neon rain");
    expect(f).toHaveBeenCalledWith("/api/search?q=neon%20rain");
  });

  it("reportPlay POSTs to the play endpoint and never throws", async () => {
    const f = mockFetch({});
    await expect(reportPlay("s1")).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledWith("/api/songs/s1/play", { method: "POST" });
  });

  it("reportPlay swallows network errors", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    await expect(reportPlay("s1")).resolves.toBeUndefined();
  });

  it("getFavorites unwraps data.ids", async () => {
    const f = mockFetch({ ids: ["a", "b"] });
    const ids = await getFavorites();
    expect(f).toHaveBeenCalledWith("/api/favorites");
    expect(ids).toEqual(["a", "b"]);
  });

  it("addFavorite PUTs the song id", async () => {
    const f = mockFetch({}, true);
    await addFavorite("s1");
    expect(f).toHaveBeenCalledWith("/api/favorites/s1", { method: "PUT" });
  });

  it("removeFavorite DELETEs the song id", async () => {
    const f = mockFetch({}, true);
    await removeFavorite("s1");
    expect(f).toHaveBeenCalledWith("/api/favorites/s1", { method: "DELETE" });
  });

  it("addFavorite throws on a non-ok response", async () => {
    mockFetch({}, false);
    await expect(addFavorite("s1")).rejects.toThrow();
  });
});
