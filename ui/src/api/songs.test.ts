// Covers the songs CRUD surface plus the error branches api.test.ts's happy-path
// tests skip. Upload progress (XHR) is already exercised in api.test.ts.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listSongs,
  streamUrl,
  setPublished,
  updateSong,
  suggest,
  uploadCover,
  removeCover,
  deleteSong,
  getSongStats,
  type SongEdit,
} from "./songs";
import { getHome, getTopTen, search } from "./home";
import { getFavorites, addFavorite, removeFavorite } from "./favorites";
import { getAlign } from "./alignment";

function mockFetch(body: unknown, ok = true, status = ok ? 200 : 500) {
  const spy = vi.fn().mockResolvedValue({ ok, status, json: async () => body });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function sentJson(spy: ReturnType<typeof mockFetch>) {
  return JSON.parse(spy.mock.calls[0][1].body as string);
}

const JSON_HEADERS = { "Content-Type": "application/json" };

const edit: SongEdit = {
  title: "Neon Undertow",
  artistName: "Kito",
  album: "Drift",
  year: 2031,
  trackNo: 3,
  genres: ["Synthwave", "Ambient"],
  lyrics: "line one\nline two",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("song reads", () => {
  it("listSongs unwraps data.songs", async () => {
    const f = mockFetch({ songs: [{ id: "s1", title: "Neon" }] });
    const list = await listSongs();
    expect(f).toHaveBeenCalledWith("/api/songs");
    expect(list[0].title).toBe("Neon");
  });

  it("listSongs returns [] for an empty library envelope", async () => {
    mockFetch({});
    expect(await listSongs()).toEqual([]);
  });

  it("listSongs throws on a non-ok response", async () => {
    mockFetch({}, false);
    await expect(listSongs()).rejects.toThrow("failed to load songs");
  });

  it("streamUrl points at the song's stream endpoint", () => {
    expect(streamUrl("s1")).toBe("/api/songs/s1/stream");
  });

  it("getSongStats reads the lifetime play figures", async () => {
    const f = mockFetch({ plays: 12, lastPlayedAt: "2026-07-01 10:00:00" });
    const stats = await getSongStats("s1");
    expect(f).toHaveBeenCalledWith("/api/songs/s1/stats");
    expect(stats.plays).toBe(12);
  });

  // Anonymous visitors get a 403 here — the Info tab must surface that, not
  // render a zero play count.
  it("getSongStats throws when the caller may not read stats", async () => {
    mockFetch({}, false, 403);
    await expect(getSongStats("s1")).rejects.toThrow("stats failed (403)");
  });
});

describe("song writes", () => {
  it("publishes via the publish path", async () => {
    const f = mockFetch({ id: "s1", published: true });
    const s = await setPublished("s1", true);
    expect(f).toHaveBeenCalledWith("/api/songs/s1/publish", { method: "POST" });
    expect(s.published).toBe(true);
  });

  it("unpublishes via the unpublish path", async () => {
    const f = mockFetch({ id: "s1", published: false });
    await setPublished("s1", false);
    expect(f).toHaveBeenCalledWith("/api/songs/s1/unpublish", {
      method: "POST",
    });
  });

  it("setPublished throws with the status", async () => {
    mockFetch({}, false, 401);
    await expect(setPublished("s1", true)).rejects.toThrow(
      "publish toggle failed (401)",
    );
  });

  it("updateSong PATCHes the whole edit as JSON", async () => {
    const f = mockFetch({ id: "s1", ...edit });
    const s = await updateSong("s1", edit);
    expect(f).toHaveBeenCalledWith(
      "/api/songs/s1",
      expect.objectContaining({ method: "PATCH", headers: JSON_HEADERS }),
    );
    expect(sentJson(f)).toEqual(edit);
    expect(s.title).toBe("Neon Undertow");
  });

  it("updateSong throws with the status", async () => {
    mockFetch({}, false, 400);
    await expect(updateSong("s1", edit)).rejects.toThrow("save failed (400)");
  });

  it("deleteSong DELETEs and resolves with nothing", async () => {
    const f = mockFetch({});
    await expect(deleteSong("s1")).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledWith("/api/songs/s1", { method: "DELETE" });
  });

  it("deleteSong throws with the status", async () => {
    mockFetch({}, false, 403);
    await expect(deleteSong("s1")).rejects.toThrow("delete failed (403)");
  });
});

describe("song cover art", () => {
  it("uploadCover PUTs a multipart form", async () => {
    const f = mockFetch({ id: "s1", coverArtId: "c1" });
    const file = new File(["png"], "cover.png", { type: "image/png" });
    const s = await uploadCover("s1", file);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/songs/s1/cover");
    expect(init.method).toBe("PUT");
    expect((init.body as FormData).get("file")).toBe(file);
    expect(s.coverArtId).toBe("c1");
  });

  it("uploadCover throws with the status", async () => {
    mockFetch({}, false, 413);
    await expect(uploadCover("s1", new File(["x"], "a.png"))).rejects.toThrow(
      "cover upload failed (413)",
    );
  });

  it("removeCover DELETEs the cover and returns the updated song", async () => {
    const f = mockFetch({ id: "s1", coverArtId: "" });
    const s = await removeCover("s1");
    expect(f).toHaveBeenCalledWith("/api/songs/s1/cover", { method: "DELETE" });
    expect(s.coverArtId).toBe("");
  });

  it("removeCover throws with the status", async () => {
    mockFetch({}, false, 404);
    await expect(removeCover("s1")).rejects.toThrow(
      "cover removal failed (404)",
    );
  });
});

describe("suggest", () => {
  it("sends the field and a URL-encoded query", async () => {
    const f = mockFetch({ suggestions: [{ value: "Kito & Co", count: 3 }] });
    const out = await suggest("artist", "kito &");
    expect(f).toHaveBeenCalledWith("/api/suggest?field=artist&q=kito%20%26");
    expect(out[0].count).toBe(3);
  });

  it("returns [] when the envelope has no suggestions", async () => {
    mockFetch({});
    expect(await suggest("album", "x")).toEqual([]);
  });

  // Typeahead must never break the editor: a failing lookup degrades to no
  // suggestions rather than throwing at the keystroke.
  it("returns [] instead of throwing on a non-ok response", async () => {
    mockFetch({}, false, 500);
    await expect(suggest("genre", "syn")).resolves.toEqual([]);
  });
});

describe("aggregate read error branches", () => {
  it("getHome throws with the status", async () => {
    mockFetch({}, false, 500);
    await expect(getHome()).rejects.toThrow("failed to load home (500)");
  });

  it("getTopTen returns [] when the envelope has no songs", async () => {
    mockFetch({});
    expect(await getTopTen()).toEqual([]);
  });

  it("getTopTen throws with the status", async () => {
    mockFetch({}, false, 503);
    await expect(getTopTen()).rejects.toThrow("failed to load top-ten (503)");
  });

  it("search throws with the status", async () => {
    mockFetch({}, false, 500);
    await expect(search("neon")).rejects.toThrow("search failed (500)");
  });

  it("getFavorites returns [] when the envelope has no ids", async () => {
    mockFetch({});
    expect(await getFavorites()).toEqual([]);
  });

  it("getFavorites throws with the status", async () => {
    mockFetch({}, false, 401);
    await expect(getFavorites()).rejects.toThrow(
      "failed to load favorites (401)",
    );
  });

  it("addFavorite and removeFavorite name themselves in their errors", async () => {
    mockFetch({}, false, 401);
    await expect(addFavorite("s1")).rejects.toThrow(
      "add favorite failed (401)",
    );
    await expect(removeFavorite("s1")).rejects.toThrow(
      "remove favorite failed (401)",
    );
  });

  // 404 means "never synced" and is handled; anything else is a real failure.
  it("getAlign throws on a non-404 error status", async () => {
    mockFetch({}, false, 500);
    await expect(getAlign("s-align-err")).rejects.toThrow(
      "align status failed (500)",
    );
  });
});
