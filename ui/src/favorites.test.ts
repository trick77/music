import { describe, expect, it } from "vitest";
import { loadFavorites, toggleFavorite, isFavorite, type Store } from "./favorites";

function fakeStore(initial?: string): Store {
  let value = initial;
  return {
    getItem: (_k: string) => value ?? null,
    setItem: (_k: string, v: string) => {
      value = v;
    },
  };
}

describe("favorites", () => {
  it("starts empty", () => {
    expect(loadFavorites(fakeStore())).toEqual([]);
  });
  it("toggles an id on and off", () => {
    const store = fakeStore();
    let list = toggleFavorite(store, "a");
    expect(list).toEqual(["a"]);
    expect(loadFavorites(store)).toEqual(["a"]);
    list = toggleFavorite(store, "a");
    expect(list).toEqual([]);
  });
  it("isFavorite reflects membership", () => {
    expect(isFavorite(["a", "b"], "b")).toBe(true);
    expect(isFavorite(["a"], "z")).toBe(false);
  });
  it("survives corrupt storage", () => {
    expect(loadFavorites(fakeStore("not json"))).toEqual([]);
  });
});
