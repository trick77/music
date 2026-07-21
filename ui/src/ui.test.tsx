import { describe, it, expect } from "vitest";
import { visualViewportBox, sameViewportBox } from "./ui";

describe("visualViewportBox", () => {
  it("pins the overlay to the visible band, overriding the CSS inset", () => {
    // iPad landscape with the keyboard up: 834px tall viewport, ~484px actually visible.
    expect(
      visualViewportBox({
        offsetTop: 0,
        offsetLeft: 0,
        width: 1194,
        height: 484,
      }),
    ).toEqual({
      top: 0,
      left: 0,
      width: 1194,
      height: 484,
      right: "auto",
      bottom: "auto",
    });
  });

  it("follows the visual viewport when iOS pans it", () => {
    expect(
      visualViewportBox({
        offsetTop: 120,
        offsetLeft: 8,
        width: 1194,
        height: 484,
      }),
    ).toEqual({
      top: 120,
      left: 8,
      width: 1194,
      height: 484,
      right: "auto",
      bottom: "auto",
    });
  });

  it("returns no overrides when visualViewport is unsupported, leaving inset: 0 to stand", () => {
    expect(visualViewportBox(undefined)).toEqual({});
    expect(visualViewportBox(null)).toEqual({});
  });
});

describe("sameViewportBox", () => {
  it("treats identical readings as equal so keyboard-animation events do not re-render", () => {
    const a = { top: 0, left: 0, width: 1194, height: 484 };
    const b = { top: 0, left: 0, width: 1194, height: 484 };
    expect(sameViewportBox(a, b)).toBe(true);
  });

  it("spots a height change (the keyboard opening or closing)", () => {
    expect(sameViewportBox({ height: 834 }, { height: 484 })).toBe(false);
  });

  it("spots a pan (offsetTop change)", () => {
    expect(sameViewportBox({ top: 0 }, { top: 120 })).toBe(false);
  });

  it("treats two empty boxes as equal (the unsupported case)", () => {
    expect(sameViewportBox({}, {})).toBe(true);
  });
});
