import { describe, it, expect } from "vitest";
import { NO_DISMISS_SELECTOR, isBackgroundTarget } from "./backgroundDismiss";

// The immersive views close when you tap their background. These tests pin the
// rule that decides background-vs-control; whether a real tap lands where we
// think it does is Playwright's job, as everywhere else in this suite.

// stub stands in for an Element: `hit` is what closest() finds walking up from it.
function stub(hit: "control" | "none") {
  return { closest: (_s: string) => (hit === "control" ? {} : null) };
}

describe("isBackgroundTarget", () => {
  it("when the tap lands on the bare background, then it is a dismissing tap", () => {
    expect(isBackgroundTarget(stub("none"))).toBe(true);
  });

  it("when the tap lands on a control (or inside one), then it does not dismiss", () => {
    expect(isBackgroundTarget(stub("control"))).toBe(false);
  });

  it("when the target is not an element, then it is treated as background", () => {
    // A tap that resolves to the document/root itself has nothing to exclude it.
    expect(isBackgroundTarget(null)).toBe(true);
    expect(isBackgroundTarget({})).toBe(true);
  });
});

describe("NO_DISMISS_SELECTOR", () => {
  it("when a tap lands on any interactive control, then the selector catches it", () => {
    // Every control the immersive views actually render must be covered: the
    // transport/close/share buttons, the seek slider, and links.
    for (const s of ["button", "input", "a", '[role="button"]']) {
      expect(NO_DISMISS_SELECTOR).toContain(s);
    }
  });

  it("when a tap lands in the dead space around the buttons, then the marked cluster catches it", () => {
    // The docked control band is marked as one zone, so near-misses beside or
    // between the buttons never close the view mid-reach.
    expect(NO_DISMISS_SELECTOR).toContain("[data-player-ui]");
  });
});
