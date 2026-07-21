import { describe, expect, it } from "vitest";
import { addToQueue, playNext, removeAt, reorder } from "./queue";
import type { Song } from "./api";

const s = (id: string): Song => ({
  id,
  title: id,
  artistName: "",
  album: "",
  year: 0,
  trackNo: 0,
  trackTotal: 0,
  durationMs: 0,
  fileSize: 0,
  createdAt: "",
  sampleRate: 0,
  channels: 0,
  bitrateKbps: 0,
  genres: [],
  coverArtId: "",
  published: true,
});

describe("queue ops", () => {
  it("appends to the end", () => {
    expect(addToQueue([s("a")], s("b")).map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("play next inserts at the front", () => {
    expect(playNext([s("a")], s("b")).map((x) => x.id)).toEqual(["b", "a"]);
  });
  it("removes by index", () => {
    expect(removeAt([s("a"), s("b"), s("c")], 1).map((x) => x.id)).toEqual([
      "a",
      "c",
    ]);
  });
  it("reorders by moving an item", () => {
    expect(reorder([s("a"), s("b"), s("c")], 2, 0).map((x) => x.id)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
  it("does not mutate the input", () => {
    const input = [s("a"), s("b")];
    addToQueue(input, s("c"));
    expect(input.map((x) => x.id)).toEqual(["a", "b"]);
  });
});

// reorder is driven by drag-and-drop, where the browser happily reports a drop on
// the row being dragged or past the end of the list. Those must be no-ops rather
// than silently shuffling or dropping an item.
describe("reorder edge cases", () => {
  const list = [s("a"), s("b"), s("c")];

  it("returns the list untouched when the item is dropped on itself", () => {
    expect(reorder(list, 1, 1)).toBe(list);
  });

  it("returns the list untouched for out-of-range indices", () => {
    expect(reorder(list, -1, 0)).toBe(list);
    expect(reorder(list, 0, -1)).toBe(list);
    expect(reorder(list, 3, 0)).toBe(list);
    expect(reorder(list, 0, 3)).toBe(list);
  });

  it("moves an item forward, closing the gap behind it", () => {
    expect(reorder(list, 0, 2).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("moves an item one slot without disturbing the rest", () => {
    expect(reorder(list, 1, 0).map((x) => x.id)).toEqual(["b", "a", "c"]);
  });

  it("does not mutate the input", () => {
    reorder(list, 0, 2);
    expect(list.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("is a no-op on an empty list", () => {
    const empty: Song[] = [];
    expect(reorder(empty, 0, 0)).toBe(empty);
  });
});

describe("removeAt", () => {
  it("leaves the list alone for an index that is not there", () => {
    expect(removeAt([s("a"), s("b")], 5).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("removes the only item", () => {
    expect(removeAt([s("a")], 0)).toEqual([]);
  });
});
