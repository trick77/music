import { describe, it, expect } from "vitest";
import { saveResume, loadResume, clearResume, isResumeFresh, RESUME_WINDOW_MS, type ResumeState } from "./resume";

function memStore(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("resume", () => {
  it("round-trips a saved state", () => {
    const store = memStore();
    const state: ResumeState = { songId: "abc", positionMs: 42000 };
    saveResume(store, state);
    expect(loadResume(store)).toEqual(state);
  });

  it("round-trips the reported flag", () => {
    const store = memStore();
    saveResume(store, { songId: "abc", positionMs: 42000, reported: true });
    expect(loadResume(store)).toEqual({ songId: "abc", positionMs: 42000, reported: true });
  });

  it("omits reported when absent (backward compatible)", () => {
    expect(loadResume(memStore({ "music.resume": JSON.stringify({ songId: "a", positionMs: 1 }) }))).toEqual({ songId: "a", positionMs: 1 });
  });

  it("returns null when nothing is stored", () => {
    expect(loadResume(memStore())).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    expect(loadResume(memStore({ "music.resume": "{not json" }))).toBeNull();
  });

  it("returns null when the shape is wrong", () => {
    expect(loadResume(memStore({ "music.resume": JSON.stringify({ songId: 5 }) }))).toBeNull();
  });

  it("round-trips savedAt", () => {
    const store = memStore();
    saveResume(store, { songId: "abc", positionMs: 42000, savedAt: 1700000000000 });
    expect(loadResume(store)).toEqual({ songId: "abc", positionMs: 42000, savedAt: 1700000000000 });
  });

  it("omits savedAt when absent (backward compatible)", () => {
    expect(loadResume(memStore({ "music.resume": JSON.stringify({ songId: "a", positionMs: 1 }) }))).toEqual({ songId: "a", positionMs: 1 });
  });

  it("clears stored state", () => {
    const store = memStore();
    saveResume(store, { songId: "x", positionMs: 1 });
    clearResume(store);
    expect(loadResume(store)).toBeNull();
  });
});

describe("isResumeFresh", () => {
  const now = 1700000000000;

  it("is fresh just inside the window", () => {
    expect(isResumeFresh({ songId: "a", positionMs: 1, savedAt: now - RESUME_WINDOW_MS + 1 }, now)).toBe(true);
  });

  it("is fresh right at the window boundary", () => {
    expect(isResumeFresh({ songId: "a", positionMs: 1, savedAt: now - RESUME_WINDOW_MS }, now)).toBe(true);
  });

  it("is stale just outside the window", () => {
    expect(isResumeFresh({ songId: "a", positionMs: 1, savedAt: now - RESUME_WINDOW_MS - 1 }, now)).toBe(false);
  });

  it("is stale when savedAt is missing (older saved state)", () => {
    expect(isResumeFresh({ songId: "a", positionMs: 1 }, now)).toBe(false);
  });
});
