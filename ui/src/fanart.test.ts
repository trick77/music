import { describe, it, expect } from "vitest";
import { fanartUrl, genreInitial } from "./fanart";

describe("fanartUrl", () => {
  it("builds a plain URL with no size", () => {
    expect(fanartUrl("abc")).toBe("/api/fanart/abc");
  });
  it("appends the size param", () => {
    expect(fanartUrl("abc", "hero")).toBe("/api/fanart/abc?size=hero");
  });
  it("returns empty string for a missing id", () => {
    expect(fanartUrl("")).toBe("");
  });
});

describe("genreInitial", () => {
  it("uppercases the first letter", () => {
    expect(genreInitial("jazz")).toBe("J");
  });
  it("falls back to ? when empty", () => {
    expect(genreInitial("  ")).toBe("?");
  });
});
