import { describe, it, expect } from "vitest";
import { saveResume, loadResume, clearResume, type ResumeState } from "./resume";

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

  it("returns null when nothing is stored", () => {
    expect(loadResume(memStore())).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    expect(loadResume(memStore({ "music.resume": "{not json" }))).toBeNull();
  });

  it("returns null when the shape is wrong", () => {
    expect(loadResume(memStore({ "music.resume": JSON.stringify({ songId: 5 }) }))).toBeNull();
  });

  it("clears stored state", () => {
    const store = memStore();
    saveResume(store, { songId: "x", positionMs: 1 });
    clearResume(store);
    expect(loadResume(store)).toBeNull();
  });
});
