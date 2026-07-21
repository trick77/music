import { describe, it, expect, vi, afterEach } from "vitest";
import {
  studioGenerate,
  studioRefine,
  imageModelOptions,
  generateStudioCoverArt,
  studioCoverArtUrl,
} from "./studio";

// sseFetch stands in for fetch() returning a Server-Sent Events stream. Each
// element of `chunks` is delivered as one reader.read() — splitting a frame
// across two chunks is how we exercise the client's buffering.
function sseFetch(chunks: string[], ok = true, status = 200) {
  const enc = new TextEncoder();
  let i = 0;
  const reader = {
    read: async () =>
      i < chunks.length
        ? { done: false, value: enc.encode(chunks[i++]) }
        : { done: true, value: undefined },
  };
  const spy = vi.fn().mockResolvedValue({
    ok,
    status,
    body: ok ? { getReader: () => reader } : null,
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

function frame(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const RESULT = {
  stylePrompt: "dusty synthwave",
  lyrics: "line one",
  coverArtPrompt: "neon coastline",
  genres: ["Synthwave"],
  bands: ["Kito"],
  titles: ["Drift"],
  albums: ["Undertow"],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("studioGenerate", () => {
  it("POSTs the reference, reports progress, and returns the result", async () => {
    const f = sseFetch([
      frame("progress", { phase: "research", detail: "reading" }),
      frame("progress", { phase: "write", detail: "drafting" }),
      frame("result", RESULT),
    ]);
    const seen: { phase: string; detail: string }[] = [];
    const out = await studioGenerate("Kito – Drift", (p) => seen.push(p));

    expect(f).toHaveBeenCalledWith(
      "/api/studio/generate",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(JSON.parse(f.mock.calls[0][1].body as string)).toEqual({
      reference: "Kito – Drift",
    });
    expect(seen.map((p) => p.phase)).toEqual(["research", "write"]);
    expect(out.lyrics).toBe("line one");
    expect(out.genres).toEqual(["Synthwave"]);
  });

  // Network chunks fall wherever they fall; a frame arriving in two pieces must
  // still be parsed once, not dropped or double-dispatched.
  it("reassembles a frame split across two chunks", async () => {
    const whole =
      frame("progress", { phase: "research", detail: "reading" }) +
      frame("result", RESULT);
    const cut = Math.floor(whole.length / 3);
    sseFetch([whole.slice(0, cut), whole.slice(cut)]);
    const seen: string[] = [];
    const out = await studioGenerate("ref", (p) => seen.push(p.phase));
    expect(seen).toEqual(["research"]);
    expect(out.stylePrompt).toBe("dusty synthwave");
  });

  it("delivers several frames arriving in a single chunk", async () => {
    sseFetch([
      frame("progress", { phase: "a", detail: "" }) +
        frame("progress", { phase: "b", detail: "" }) +
        frame("result", RESULT),
    ]);
    const seen: string[] = [];
    await studioGenerate("ref", (p) => seen.push(p.phase));
    expect(seen).toEqual(["a", "b"]);
  });

  it("throws the server's message on an error event", async () => {
    sseFetch([
      frame("progress", { phase: "research", detail: "" }),
      frame("error", { error: "model unavailable" }),
    ]);
    await expect(studioGenerate("ref", () => {})).rejects.toThrow(
      "model unavailable",
    );
  });

  it("falls back to a generic message when the error event carries none", async () => {
    sseFetch([frame("error", {})]);
    await expect(studioGenerate("ref", () => {})).rejects.toThrow(
      "generation failed",
    );
  });

  // A stream that ends after progress only means the generation never landed.
  it("throws when the stream ends without a result", async () => {
    sseFetch([frame("progress", { phase: "research", detail: "" })]);
    await expect(studioGenerate("ref", () => {})).rejects.toThrow(
      "studio returned no result",
    );
  });

  it("throws when the request itself fails", async () => {
    sseFetch([], false, 502);
    await expect(studioGenerate("ref", () => {})).rejects.toThrow(
      "studio request failed (502)",
    );
  });

  it("ignores comment/heartbeat frames that carry no data line", async () => {
    sseFetch([": keep-alive\n\n", frame("result", RESULT)]);
    const out = await studioGenerate("ref", () => {});
    expect(out.lyrics).toBe("line one");
  });

  // A truncated or malformed data line must not abort a stream whose result is
  // still to come.
  it("skips a frame whose data is not valid JSON", async () => {
    sseFetch(["event: progress\ndata: {not json\n\n", frame("result", RESULT)]);
    const seen: string[] = [];
    const out = await studioGenerate("ref", (p) => seen.push(p.phase));
    expect(seen).toEqual([]);
    expect(out.coverArtPrompt).toBe("neon coastline");
  });

  // No event: line means the default "message" type, which is neither progress
  // nor result and is therefore ignored.
  it("ignores an unnamed (default message) frame", async () => {
    sseFetch([
      `data: ${JSON.stringify({ phase: "x", detail: "" })}\n\n`,
      frame("result", RESULT),
    ]);
    const seen: string[] = [];
    await studioGenerate("ref", (p) => seen.push(p.phase));
    expect(seen).toEqual([]);
  });
});

describe("studioRefine", () => {
  it("POSTs reference, lyrics and instruction and returns only the lyrics", async () => {
    const f = sseFetch([
      frame("progress", { phase: "refine", detail: "" }),
      frame("result", { lyrics: "tighter line one" }),
    ]);
    const seen: string[] = [];
    const lyrics = await studioRefine(
      "Kito – Drift",
      "line one",
      "make it tighter",
      (p) => seen.push(p.phase),
    );
    expect(f.mock.calls[0][0]).toBe("/api/studio/refine");
    expect(JSON.parse(f.mock.calls[0][1].body as string)).toEqual({
      reference: "Kito – Drift",
      lyrics: "line one",
      instruction: "make it tighter",
    });
    expect(seen).toEqual(["refine"]);
    expect(lyrics).toBe("tighter line one");
  });

  it("returns an empty string when the result carries no lyrics", async () => {
    sseFetch([frame("result", {})]);
    expect(await studioRefine("r", "l", "i", () => {})).toBe("");
  });

  it("propagates a stream error", async () => {
    sseFetch([frame("error", { error: "refine failed upstream" })]);
    await expect(studioRefine("r", "l", "i", () => {})).rejects.toThrow(
      "refine failed upstream",
    );
  });
});

describe("imageModelOptions", () => {
  it("labels known models and passes unknown ids through raw", () => {
    expect(imageModelOptions(["flux-2-pro", "operator-custom"])).toEqual([
      { id: "flux-2-pro", label: "Best quality · flux-2-pro" },
      { id: "operator-custom", label: "operator-custom" },
    ]);
  });

  it("labels the fast and balanced models", () => {
    expect(
      imageModelOptions(["flux-2-klein-4b", "flux-2-flex"]).map((o) => o.label),
    ).toEqual([
      "Fast · flux-2-klein-4b",
      "Balanced (typography) · flux-2-flex",
    ]);
  });

  // The session may omit imageModels entirely when image generation is off.
  it("tolerates a missing model list", () => {
    expect(imageModelOptions(undefined as unknown as string[])).toEqual([]);
    expect(imageModelOptions([])).toEqual([]);
  });
});

describe("studio cover art", () => {
  it("generateStudioCoverArt POSTs prompt and model", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "ca1",
        status: "ready",
        width: 1024,
        height: 1024,
      }),
    });
    vi.stubGlobal("fetch", spy);
    const res = await generateStudioCoverArt("neon coastline", "flux-2-pro");
    expect(spy).toHaveBeenCalledWith(
      "/api/studio/coverart",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(JSON.parse(spy.mock.calls[0][1].body as string)).toEqual({
      prompt: "neon coastline",
      model: "flux-2-pro",
    });
    expect(res.id).toBe("ca1");
  });

  it("generateStudioCoverArt throws with the status", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }),
    );
    await expect(generateStudioCoverArt("p", "m")).rejects.toThrow(
      "cover art failed (429)",
    );
  });

  it("studioCoverArtUrl points at the stored image", () => {
    expect(studioCoverArtUrl("ca1")).toBe("/api/studio/coverart/ca1");
  });
});
