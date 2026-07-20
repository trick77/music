import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listPlaylists,
  getPlaylist,
  createPlaylist,
  updatePlaylist,
  deletePlaylist,
  addSongToPlaylist,
  removeSongFromPlaylist,
  reorderPlaylist,
  uploadPlaylistCover,
  suggestPlaylistPrompt,
  refinePlaylistPrompt,
  applyPlaylistCover,
  suggestPlaylistDescriptions,
  updatePlaylistDescription,
  setPlaylistPublished,
} from "./playlists";

function mockFetch(body: unknown, ok = true, status = ok ? 200 : 500) {
  const spy = vi.fn().mockResolvedValue({ ok, status, json: async () => body });
  vi.stubGlobal("fetch", spy);
  return spy;
}

// The JSON body is stringified by the client, so assertions parse it back rather
// than string-matching key order.
function sentJson(spy: ReturnType<typeof mockFetch>) {
  return JSON.parse(spy.mock.calls[0][1].body as string);
}

const JSON_HEADERS = { "Content-Type": "application/json" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("playlist reads", () => {
  it("listPlaylists unwraps data.playlists", async () => {
    const f = mockFetch({ playlists: [{ id: "p1", name: "Night Drive" }] });
    const list = await listPlaylists();
    expect(f).toHaveBeenCalledWith("/api/playlists");
    expect(list[0].id).toBe("p1");
  });

  // A library with no playlists yet returns an envelope without the key.
  it("listPlaylists returns [] when the envelope has no playlists key", async () => {
    mockFetch({});
    expect(await listPlaylists()).toEqual([]);
  });

  it("listPlaylists throws on a non-ok response", async () => {
    mockFetch({}, false);
    await expect(listPlaylists()).rejects.toThrow("failed to load playlists");
  });

  it("getPlaylist fetches the detail by id", async () => {
    const f = mockFetch({ id: "p1", songs: [{ id: "s1" }] });
    const detail = await getPlaylist("p1");
    expect(f).toHaveBeenCalledWith("/api/playlists/p1");
    expect(detail.songs[0].id).toBe("s1");
  });

  it("getPlaylist surfaces the status in the error", async () => {
    mockFetch({}, false, 404);
    await expect(getPlaylist("nope")).rejects.toThrow("failed to load playlist (404)");
  });
});

describe("playlist writes", () => {
  it("createPlaylist POSTs name and description as JSON", async () => {
    const f = mockFetch({ id: "p1" });
    await createPlaylist("Night Drive", "for the tunnel");
    expect(f).toHaveBeenCalledWith("/api/playlists", expect.objectContaining({ method: "POST", headers: JSON_HEADERS }));
    expect(sentJson(f)).toEqual({ name: "Night Drive", description: "for the tunnel" });
  });

  it("createPlaylist throws with the status", async () => {
    mockFetch({}, false, 400);
    await expect(createPlaylist("x", "")).rejects.toThrow("create failed (400)");
  });

  it("updatePlaylist PATCHes the playlist", async () => {
    const f = mockFetch({ id: "p1", name: "New" });
    const d = await updatePlaylist("p1", "New", "desc");
    expect(f).toHaveBeenCalledWith("/api/playlists/p1", expect.objectContaining({ method: "PATCH", headers: JSON_HEADERS }));
    expect(sentJson(f)).toEqual({ name: "New", description: "desc" });
    expect(d.name).toBe("New");
  });

  it("updatePlaylist throws with the status", async () => {
    mockFetch({}, false, 409);
    await expect(updatePlaylist("p1", "a", "b")).rejects.toThrow("save failed (409)");
  });

  it("deletePlaylist DELETEs and resolves with nothing", async () => {
    const f = mockFetch({});
    await expect(deletePlaylist("p1")).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledWith("/api/playlists/p1", { method: "DELETE" });
  });

  it("deletePlaylist throws with the status", async () => {
    mockFetch({}, false, 403);
    await expect(deletePlaylist("p1")).rejects.toThrow("delete failed (403)");
  });

  it("updatePlaylistDescription PATCHes only the description", async () => {
    const f = mockFetch({ id: "p1" });
    await updatePlaylistDescription("p1", "moodier");
    expect(f).toHaveBeenCalledWith("/api/playlists/p1", expect.objectContaining({ method: "PATCH" }));
    // The name must not be sent, or an empty one would blank the playlist's title.
    expect(sentJson(f)).toEqual({ description: "moodier" });
  });

  it("updatePlaylistDescription throws with the status", async () => {
    mockFetch({}, false, 500);
    await expect(updatePlaylistDescription("p1", "x")).rejects.toThrow("save failed (500)");
  });
});

describe("playlist membership", () => {
  it("addSongToPlaylist POSTs the song id", async () => {
    const f = mockFetch({ id: "p1", songs: [{ id: "s1" }] });
    const d = await addSongToPlaylist("p1", "s1");
    expect(f).toHaveBeenCalledWith("/api/playlists/p1/songs", expect.objectContaining({ method: "POST", headers: JSON_HEADERS }));
    expect(sentJson(f)).toEqual({ songId: "s1" });
    expect(d.songs).toHaveLength(1);
  });

  it("addSongToPlaylist throws with the status", async () => {
    mockFetch({}, false, 404);
    await expect(addSongToPlaylist("p1", "s1")).rejects.toThrow("add failed (404)");
  });

  it("removeSongFromPlaylist DELETEs the nested song path", async () => {
    const f = mockFetch({ id: "p1", songs: [] });
    const d = await removeSongFromPlaylist("p1", "s1");
    expect(f).toHaveBeenCalledWith("/api/playlists/p1/songs/s1", { method: "DELETE" });
    expect(d.songs).toEqual([]);
  });

  it("removeSongFromPlaylist throws with the status", async () => {
    mockFetch({}, false, 404);
    await expect(removeSongFromPlaylist("p1", "s1")).rejects.toThrow("remove failed (404)");
  });

  it("reorderPlaylist PUTs the full id order", async () => {
    const f = mockFetch({ id: "p1" });
    await reorderPlaylist("p1", ["s3", "s1", "s2"]);
    expect(f).toHaveBeenCalledWith("/api/playlists/p1/reorder", expect.objectContaining({ method: "PUT", headers: JSON_HEADERS }));
    expect(sentJson(f)).toEqual({ songIds: ["s3", "s1", "s2"] });
  });

  it("reorderPlaylist throws with the status", async () => {
    mockFetch({}, false, 400);
    await expect(reorderPlaylist("p1", [])).rejects.toThrow("reorder failed (400)");
  });
});

describe("playlist publishing", () => {
  it("publishes via the publish path", async () => {
    const f = mockFetch({ id: "p1", published: true });
    const d = await setPlaylistPublished("p1", true);
    expect(f).toHaveBeenCalledWith("/api/playlists/p1/publish", { method: "POST" });
    expect(d.published).toBe(true);
  });

  it("unpublishes via the unpublish path", async () => {
    const f = mockFetch({ id: "p1", published: false });
    await setPlaylistPublished("p1", false);
    expect(f).toHaveBeenCalledWith("/api/playlists/p1/unpublish", { method: "POST" });
  });

  it("throws with the status", async () => {
    mockFetch({}, false, 401);
    await expect(setPlaylistPublished("p1", true)).rejects.toThrow("playlist publish toggle failed (401)");
  });
});

describe("playlist cover art", () => {
  it("uploadPlaylistCover PUTs a multipart form", async () => {
    const f = mockFetch({ id: "p1", coverArtId: "c1" });
    const file = new File(["png"], "cover.png", { type: "image/png" });
    const d = await uploadPlaylistCover("p1", file);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/playlists/p1/cover");
    expect(init.method).toBe("PUT");
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("file")).toBe(file);
    expect(d.coverArtId).toBe("c1");
  });

  it("uploadPlaylistCover throws with the status", async () => {
    mockFetch({}, false, 413);
    await expect(uploadPlaylistCover("p1", new File(["x"], "a.png"))).rejects.toThrow("cover upload failed (413)");
  });

  // Same URL as the upload but POST, not PUT — the studio flow maps an already
  // generated image instead of sending bytes.
  it("applyPlaylistCover POSTs the studio cover id as JSON", async () => {
    const f = mockFetch({ coverArtId: "c9" });
    const res = await applyPlaylistCover("p1", "studio-7");
    expect(f).toHaveBeenCalledWith("/api/playlists/p1/cover", expect.objectContaining({ method: "POST", headers: JSON_HEADERS }));
    expect(sentJson(f)).toEqual({ studioCoverArtId: "studio-7" });
    expect(res.coverArtId).toBe("c9");
  });

  it("applyPlaylistCover throws with the status", async () => {
    mockFetch({}, false, 404);
    await expect(applyPlaylistCover("p1", "studio-7")).rejects.toThrow("apply cover failed (404)");
  });
});

describe("playlist AI helpers", () => {
  it("suggestPlaylistPrompt POSTs with no body", async () => {
    const f = mockFetch({ prompt: "neon skyline" });
    const res = await suggestPlaylistPrompt("p1");
    expect(f).toHaveBeenCalledWith("/api/playlists/p1/suggest-prompt", { method: "POST" });
    expect(res.prompt).toBe("neon skyline");
  });

  it("suggestPlaylistPrompt throws with the status", async () => {
    mockFetch({}, false, 503);
    await expect(suggestPlaylistPrompt("p1")).rejects.toThrow("suggest failed (503)");
  });

  it("refinePlaylistPrompt sends the current prompt and the instruction", async () => {
    const f = mockFetch({ prompt: "neon skyline at dusk" });
    const res = await refinePlaylistPrompt("p1", "neon skyline", "make it dusk");
    expect(f).toHaveBeenCalledWith("/api/playlists/p1/refine-prompt", expect.objectContaining({ method: "POST", headers: JSON_HEADERS }));
    expect(sentJson(f)).toEqual({ current: "neon skyline", instruction: "make it dusk" });
    expect(res.prompt).toBe("neon skyline at dusk");
  });

  it("refinePlaylistPrompt throws with the status", async () => {
    mockFetch({}, false, 500);
    await expect(refinePlaylistPrompt("p1", "a", "b")).rejects.toThrow("refine failed (500)");
  });

  it("suggestPlaylistDescriptions returns the three variants", async () => {
    const f = mockFetch({ punchy: "Loud.", evocative: "Rain on glass.", factual: "12 tracks." });
    const res = await suggestPlaylistDescriptions("p1");
    expect(f).toHaveBeenCalledWith("/api/playlists/p1/suggest-description", { method: "POST" });
    expect(res).toEqual({ punchy: "Loud.", evocative: "Rain on glass.", factual: "12 tracks." });
  });

  it("suggestPlaylistDescriptions throws with the status", async () => {
    mockFetch({}, false, 503);
    await expect(suggestPlaylistDescriptions("p1")).rejects.toThrow("suggest failed (503)");
  });
});
