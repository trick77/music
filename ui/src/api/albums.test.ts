import { describe, it, expect, vi, afterEach } from "vitest";
import { listAlbums, suggestAlbumPrompt, refineAlbumPrompt, setAlbumCover } from "./albums";
import { getArtist } from "./artists";
import { getSession } from "./session";

function mockFetch(body: unknown, ok = true, status = ok ? 200 : 500) {
  const spy = vi.fn().mockResolvedValue({ ok, status, json: async () => body });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function sentJson(spy: ReturnType<typeof mockFetch>) {
  return JSON.parse(spy.mock.calls[0][1].body as string);
}

const JSON_HEADERS = { "Content-Type": "application/json" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("albums", () => {
  it("listAlbums unwraps data.albums", async () => {
    const f = mockFetch({ albums: [{ artistId: "a1", artistName: "Kito", album: "Drift", songCount: 9, hasCover: true }] });
    const list = await listAlbums();
    expect(f).toHaveBeenCalledWith("/api/albums");
    expect(list[0].album).toBe("Drift");
  });

  it("listAlbums returns [] when the key is missing", async () => {
    mockFetch({});
    expect(await listAlbums()).toEqual([]);
  });

  it("listAlbums throws on a non-ok response", async () => {
    mockFetch({}, false);
    await expect(listAlbums()).rejects.toThrow("failed to load albums");
  });

  // Albums have no id of their own — they are keyed by artist + album title, so
  // both must ride in the body.
  it("suggestAlbumPrompt POSTs the artist/album key", async () => {
    const f = mockFetch({ prompt: "sun-bleached tape" });
    const p = await suggestAlbumPrompt("a1", "Drift");
    expect(f).toHaveBeenCalledWith("/api/albums/suggest-prompt", expect.objectContaining({ method: "POST", headers: JSON_HEADERS }));
    expect(sentJson(f)).toEqual({ artistId: "a1", album: "Drift" });
    expect(p).toBe("sun-bleached tape");
  });

  it("suggestAlbumPrompt falls back to an empty string", async () => {
    mockFetch({});
    expect(await suggestAlbumPrompt("a1", "Drift")).toBe("");
  });

  it("suggestAlbumPrompt throws with the status", async () => {
    mockFetch({}, false, 503);
    await expect(suggestAlbumPrompt("a1", "Drift")).rejects.toThrow("suggest failed (503)");
  });

  it("refineAlbumPrompt sends the key plus prompt and instruction", async () => {
    const f = mockFetch({ prompt: "sun-bleached tape, grainier" });
    const p = await refineAlbumPrompt("a1", "Drift", "sun-bleached tape", "grainier");
    expect(f).toHaveBeenCalledWith("/api/albums/refine-prompt", expect.objectContaining({ method: "POST", headers: JSON_HEADERS }));
    expect(sentJson(f)).toEqual({ artistId: "a1", album: "Drift", prompt: "sun-bleached tape", instruction: "grainier" });
    expect(p).toBe("sun-bleached tape, grainier");
  });

  it("refineAlbumPrompt falls back to an empty string", async () => {
    mockFetch({});
    expect(await refineAlbumPrompt("a1", "Drift", "p", "i")).toBe("");
  });

  it("refineAlbumPrompt throws with the status", async () => {
    mockFetch({}, false, 500);
    await expect(refineAlbumPrompt("a1", "Drift", "p", "i")).rejects.toThrow("refine failed (500)");
  });

  it("setAlbumCover maps a studio image onto the album", async () => {
    const f = mockFetch({ coverArtId: "c1" });
    const res = await setAlbumCover("a1", "Drift", "studio-3");
    expect(f).toHaveBeenCalledWith("/api/albums/cover", expect.objectContaining({ method: "POST", headers: JSON_HEADERS }));
    expect(sentJson(f)).toEqual({ artistId: "a1", album: "Drift", studioCoverArtId: "studio-3" });
    expect(res.coverArtId).toBe("c1");
  });

  it("setAlbumCover throws with the status", async () => {
    mockFetch({}, false, 404);
    await expect(setAlbumCover("a1", "Drift", "studio-3")).rejects.toThrow("apply cover failed (404)");
  });
});

describe("artists", () => {
  it("getArtist fetches the detail by id", async () => {
    const f = mockFetch({ artist: { id: "a1", name: "Kito", songCount: 9 }, songs: [{ id: "s1" }] });
    const d = await getArtist("a1");
    expect(f).toHaveBeenCalledWith("/api/artists/a1");
    expect(d.artist.name).toBe("Kito");
    expect(d.songs).toHaveLength(1);
  });

  it("getArtist surfaces the status", async () => {
    mockFetch({}, false, 404);
    await expect(getArtist("nope")).rejects.toThrow("failed to load artist (404)");
  });
});

describe("session", () => {
  // The session endpoint always answers 200 (anonymous is a valid session), so
  // the client parses unconditionally rather than throwing on non-ok.
  it("getSession parses the auth + feature-flag envelope", async () => {
    const f = mockFetch({ authenticated: true, username: "jan", studioEnabled: true, imageModels: ["flux-2-pro"] });
    const s = await getSession();
    expect(f).toHaveBeenCalledWith("/api/auth/session");
    expect(s.authenticated).toBe(true);
    expect(s.imageModels).toEqual(["flux-2-pro"]);
  });

  it("getSession returns the anonymous envelope as-is", async () => {
    mockFetch({ authenticated: false, username: "", authMode: "none" });
    expect((await getSession()).authenticated).toBe(false);
  });
});
