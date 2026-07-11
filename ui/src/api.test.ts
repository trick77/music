import { describe, it, expect, vi, afterEach } from "vitest";
import { coverUrl } from "./cover";
import { getHome, getTopTen, search, reportPlay, getFavorites, addFavorite, removeFavorite, uploadSong, getAlign, postAlign } from "./api";

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

// FakeXHR stands in for XMLHttpRequest so we can drive upload progress and the
// load/error lifecycle synchronously from the test.
class FakeXHR {
  static last: FakeXHR;
  status = 0;
  responseText = "";
  upload: { onprogress?: (e: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  method = "";
  url = "";
  sent?: unknown;
  constructor() { FakeXHR.last = this; }
  open(method: string, url: string) { this.method = method; this.url = url; }
  send(body: unknown) { this.sent = body; }
}

function mockXHR() {
  globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest;
  return FakeXHR;
}

describe("uploadSong", () => {
  it("POSTs the file to /api/songs and resolves the Song on 201", async () => {
    mockXHR();
    const file = new File(["id3"], "neon.mp3", { type: "audio/mpeg" });
    const p = uploadSong(file);
    const xhr = FakeXHR.last;
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe("/api/songs");
    expect(xhr.sent).toBeInstanceOf(FormData);
    xhr.status = 201;
    xhr.responseText = JSON.stringify({ id: "s1", title: "Neon" });
    xhr.onload!();
    const song = await p;
    expect(song.id).toBe("s1");
  });

  it("reports byte progress as a 0–100 percentage", async () => {
    mockXHR();
    const pcts: number[] = [];
    const p = uploadSong(new File(["x"], "a.mp3"), (n) => pcts.push(n));
    const xhr = FakeXHR.last;
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 25, total: 100 });
    xhr.upload.onprogress!({ lengthComputable: true, loaded: 100, total: 100 });
    xhr.upload.onprogress!({ lengthComputable: false, loaded: 0, total: 0 });
    expect(pcts).toEqual([25, 100]);
    xhr.status = 200;
    xhr.responseText = "{}";
    xhr.onload!();
    await p;
  });

  it("rejects on a non-2xx status", async () => {
    mockXHR();
    const p = uploadSong(new File(["x"], "a.mp3"));
    const xhr = FakeXHR.last;
    xhr.status = 413;
    xhr.onload!();
    await expect(p).rejects.toThrow("upload failed (413)");
  });

  it("rejects on a network error", async () => {
    mockXHR();
    const p = uploadSong(new File(["x"], "a.mp3"));
    FakeXHR.last.onerror!();
    await expect(p).rejects.toThrow();
  });
});

describe("karaoke alignment", () => {
  function fetchStatus(status: number, body: unknown = {}) {
    const spy = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    });
    globalThis.fetch = spy as unknown as typeof fetch;
    return spy;
  }

  it("getAlign returns null on 404", async () => {
    fetchStatus(404);
    expect(await getAlign("s1")).toBeNull();
  });

  it("getAlign parses a ready payload", async () => {
    fetchStatus(200, { status: "ready", engine: "e", lines: [{ text: "hi", start: 1, end: 2, words: [] }] });
    const a = await getAlign("s1");
    expect(a?.status).toBe("ready");
    expect(a?.lines?.[0].text).toBe("hi");
  });

  it("postAlign resolves on 202 and swallows 409/400/404", async () => {
    for (const code of [202, 409, 400, 404]) {
      fetchStatus(code);
      await expect(postAlign("s1")).resolves.toBeUndefined();
    }
  });

  it("postAlign throws on a real error", async () => {
    fetchStatus(500);
    await expect(postAlign("s1")).rejects.toThrow("align request failed (500)");
  });
});
