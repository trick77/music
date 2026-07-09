import { describe, it, expect } from "vitest";
import { formatDuration } from "./format";

describe("formatDuration", () => {
  it("formats minutes and seconds", () => {
    expect(formatDuration(185000)).toBe("3:05");
  });
  it("pads seconds", () => {
    expect(formatDuration(5000)).toBe("0:05");
  });
  it("handles zero and invalid", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(NaN)).toBe("0:00");
  });
});
