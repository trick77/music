import { describe, it, expect } from "vitest";
import { coverUrl, coverInitial } from "./cover";

describe("cover helpers", () => {
  it("builds a cover url from an id", () => {
    expect(coverUrl("abc")).toBe("/api/cover/abc");
  });
  it("returns empty url for no cover", () => {
    expect(coverUrl("")).toBe("");
  });
  it("derives an uppercase initial", () => {
    expect(coverInitial("marisol")).toBe("M");
    expect(coverInitial("")).toBe("?");
  });
});
