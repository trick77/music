import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listStudioHistory,
  getStudioRun,
  patchStudioRun,
  deleteStudioRun,
} from "./studioHistory";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

describe("studio history client", () => {
  it("requests the first page without a cursor", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ runs: [], total: 0, nextBefore: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    const page = await listStudioHistory();
    expect(fetchMock).toHaveBeenCalledWith("/api/studio/history");
    expect(page.total).toBe(0);
  });

  it("passes the keyset cursor when paging", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ runs: [], total: 30, nextBefore: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await listStudioHistory(41);
    expect(fetchMock).toHaveBeenCalledWith("/api/studio/history?before=41");
  });

  // nextBefore is 0 on the last page, and 0 must not be sent as a cursor — that
  // would ask the server for "everything before row 0", i.e. nothing.
  it("treats a zero cursor as no cursor", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ runs: [], total: 0, nextBefore: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    await listStudioHistory(0);
    expect(fetchMock).toHaveBeenCalledWith("/api/studio/history");
  });

  it("throws on a failed list rather than returning an empty page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(null, false, 500)),
    );
    await expect(listStudioHistory()).rejects.toThrow(/history/i);
  });

  it("fetches one run", async () => {
    const run = { id: "r1", reference: "x", bands: ["a", "b", "c"] };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(run));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getStudioRun("r1")).resolves.toMatchObject({ id: "r1" });
    expect(fetchMock).toHaveBeenCalledWith("/api/studio/history/r1");
  });

  it("throws when a run cannot be fetched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(null, false, 404)),
    );
    await expect(getStudioRun("r1")).rejects.toThrow(/run/i);
  });

  it("patches only the fields it is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    await patchStudioRun("r1", { lyrics: "edited" });
    expect(fetchMock).toHaveBeenCalledWith("/api/studio/history/r1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lyrics: "edited" }),
    });
  });

  it("throws on a failed patch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(null, false, 500)),
    );
    await expect(patchStudioRun("r1", { lyrics: "x" })).rejects.toThrow(
      /update/i,
    );
  });

  it("treats a 204 delete as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 204 } as Response),
    );
    await expect(deleteStudioRun("r1")).resolves.toBeUndefined();
  });

  it("throws on a failed delete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response),
    );
    await expect(deleteStudioRun("r1")).rejects.toThrow(/delete/i);
  });
});
