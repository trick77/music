import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listGenres,
  getGenre,
  uploadFanart,
  generateFanart,
  suggestGenrePrompt,
  getFanartMeta,
  patchGenre,
  refineGenrePrompt,
} from "./genres";

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

describe("genre browse", () => {
  it("listGenres unwraps data.genres", async () => {
    const f = mockFetch({
      genres: [{ id: "g1", name: "Synthwave", songCount: 4 }],
    });
    const list = await listGenres();
    expect(f).toHaveBeenCalledWith("/api/genres");
    expect(list[0].name).toBe("Synthwave");
  });

  it("listGenres returns [] when the key is missing", async () => {
    mockFetch({});
    expect(await listGenres()).toEqual([]);
  });

  it("listGenres throws on a non-ok response", async () => {
    mockFetch({}, false);
    await expect(listGenres()).rejects.toThrow("failed to load genres");
  });

  it("getGenre fetches the detail by id", async () => {
    const f = mockFetch({
      genre: { id: "g1" },
      songs: [],
      fanart: [],
      backgroundId: "",
      heroId: "",
    });
    const d = await getGenre("g1");
    expect(f).toHaveBeenCalledWith("/api/genres/g1");
    expect(d.genre.id).toBe("g1");
  });

  it("getGenre surfaces the status", async () => {
    mockFetch({}, false, 404);
    await expect(getGenre("nope")).rejects.toThrow(
      "failed to load genre (404)",
    );
  });
});

describe("patchGenre", () => {
  it("PATCHes only the supplied fields", async () => {
    const f = mockFetch({ genre: { id: "g1", name: "Synth" } });
    await patchGenre("g1", { name: "Synth" });
    expect(f).toHaveBeenCalledWith(
      "/api/genres/g1",
      expect.objectContaining({ method: "PATCH", headers: JSON_HEADERS }),
    );
    expect(sentJson(f)).toEqual({ name: "Synth" });
  });

  // clearHero is a separate flag from heroFanartId: sending an empty id would be
  // ambiguous with "unchanged", so the caller passes the explicit clear marker.
  it("passes the background/hero/clear markers through untouched", async () => {
    const f = mockFetch({});
    await patchGenre("g1", {
      backgroundFanartId: "f1",
      heroFanartId: "f2",
      clearHero: "1",
    });
    expect(sentJson(f)).toEqual({
      backgroundFanartId: "f1",
      heroFanartId: "f2",
      clearHero: "1",
    });
  });

  it("throws with the status", async () => {
    mockFetch({}, false, 400);
    await expect(patchGenre("g1", { name: "x" })).rejects.toThrow(
      "save failed (400)",
    );
  });
});

describe("fanart upload and generation", () => {
  it("uploadFanart posts a multipart form with kind and genreId", async () => {
    const f = mockFetch({ id: "f1", status: "ready" });
    const file = new File(["png"], "bg.png", { type: "image/png" });
    const art = await uploadFanart("hero", "g1", file);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/fanart");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form.get("file")).toBe(file);
    expect(form.get("kind")).toBe("hero");
    expect(form.get("genreId")).toBe("g1");
    expect(art.id).toBe("f1");
  });

  it("uploadFanart throws with the status", async () => {
    mockFetch({}, false, 413);
    await expect(
      uploadFanart("genre", "g1", new File(["x"], "a.png")),
    ).rejects.toThrow("fanart upload failed (413)");
  });

  it("generateFanart sends the prompt, kind, genre and model", async () => {
    const f = mockFetch({ id: "f2", status: "generating" });
    const res = await generateFanart(
      "rain-slick street",
      "genre",
      "g1",
      "flux-2-pro",
    );
    expect(f).toHaveBeenCalledWith(
      "/api/fanart/generate",
      expect.objectContaining({ method: "POST", headers: JSON_HEADERS }),
    );
    expect(sentJson(f)).toEqual({
      prompt: "rain-slick street",
      kind: "genre",
      genreId: "g1",
      model: "flux-2-pro",
    });
    expect(res.status).toBe("generating");
  });

  // Model is optional; JSON.stringify drops the undefined key so the server picks
  // its default rather than receiving a null.
  it("generateFanart omits the model when not given", async () => {
    const f = mockFetch({ id: "f2", status: "generating" });
    await generateFanart("p", "hero", "g1");
    expect(sentJson(f)).toEqual({ prompt: "p", kind: "hero", genreId: "g1" });
  });

  it("generateFanart throws with the status", async () => {
    mockFetch({}, false, 429);
    await expect(generateFanart("p", "hero", "g1")).rejects.toThrow(
      "generate failed (429)",
    );
  });

  it("getFanartMeta asks for the metadata variant, not the image", async () => {
    const f = mockFetch({
      id: "f1",
      status: "ready",
      width: 1024,
      height: 1024,
    });
    const meta = await getFanartMeta("f1");
    expect(f).toHaveBeenCalledWith("/api/fanart/f1?meta=1");
    expect(meta.width).toBe(1024);
  });

  it("getFanartMeta throws with the status", async () => {
    mockFetch({}, false, 404);
    await expect(getFanartMeta("f1")).rejects.toThrow(
      "fanart meta failed (404)",
    );
  });
});

describe("genre prompt helpers", () => {
  it("suggestGenrePrompt POSTs and unwraps the prompt", async () => {
    const f = mockFetch({ prompt: "chrome and neon" });
    const p = await suggestGenrePrompt("g1");
    expect(f).toHaveBeenCalledWith("/api/genres/g1/suggest-prompt", {
      method: "POST",
    });
    expect(p).toBe("chrome and neon");
  });

  it("suggestGenrePrompt falls back to an empty string", async () => {
    mockFetch({});
    expect(await suggestGenrePrompt("g1")).toBe("");
  });

  it("suggestGenrePrompt throws with the status", async () => {
    mockFetch({}, false, 503);
    await expect(suggestGenrePrompt("g1")).rejects.toThrow(
      "suggest failed (503)",
    );
  });

  it("refineGenrePrompt sends the prompt and instruction", async () => {
    const f = mockFetch({ prompt: "chrome and neon, at night" });
    const p = await refineGenrePrompt("g1", "chrome and neon", "at night");
    expect(f).toHaveBeenCalledWith(
      "/api/genres/g1/refine-prompt",
      expect.objectContaining({ method: "POST", headers: JSON_HEADERS }),
    );
    expect(sentJson(f)).toEqual({
      prompt: "chrome and neon",
      instruction: "at night",
    });
    expect(p).toBe("chrome and neon, at night");
  });

  it("refineGenrePrompt falls back to an empty string", async () => {
    mockFetch({});
    expect(await refineGenrePrompt("g1", "a", "b")).toBe("");
  });

  it("refineGenrePrompt throws with the status", async () => {
    mockFetch({}, false, 500);
    await expect(refineGenrePrompt("g1", "a", "b")).rejects.toThrow(
      "refine failed (500)",
    );
  });
});
