import { describe, expect, it } from "vitest";
import { addToQueue, playNext, removeAt, reorder } from "./queue";
import type { Song } from "./api";

const s = (id: string): Song => ({
  id, title: id, artistName: "", album: "", year: 0, trackNo: 0,
  durationMs: 0, genres: [], coverArtId: "", published: true,
});

describe("queue ops", () => {
  it("appends to the end", () => {
    expect(addToQueue([s("a")], s("b")).map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("play next inserts at the front", () => {
    expect(playNext([s("a")], s("b")).map((x) => x.id)).toEqual(["b", "a"]);
  });
  it("removes by index", () => {
    expect(removeAt([s("a"), s("b"), s("c")], 1).map((x) => x.id)).toEqual(["a", "c"]);
  });
  it("reorders by moving an item", () => {
    expect(reorder([s("a"), s("b"), s("c")], 2, 0).map((x) => x.id)).toEqual(["c", "a", "b"]);
  });
  it("does not mutate the input", () => {
    const input = [s("a"), s("b")];
    addToQueue(input, s("c"));
    expect(input.map((x) => x.id)).toEqual(["a", "b"]);
  });
});
