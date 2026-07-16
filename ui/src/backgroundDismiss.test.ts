import { describe, it, expect } from "vitest";
import { NO_DISMISS_SELECTOR, TAP_SLOP_PX, isBackgroundTarget, shouldDismiss, type Press } from "./backgroundDismiss";

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

describe("shouldDismiss", () => {
  const at = (x: number, y: number, background = true): Press => ({ x, y, background });

  it("when a tap presses and releases on the background, then it dismisses", () => {
    expect(shouldDismiss(at(100, 100), at(100, 100))).toBe(true);
  });

  it("when the finger wobbles within the slop radius, then it is still a tap", () => {
    expect(shouldDismiss(at(100, 100), at(100 + TAP_SLOP_PX, 100))).toBe(true);
  });

  it("when the pointer is dragged past the slop radius, then it does not dismiss", () => {
    // Selecting a line of lyrics: press and release both land on background text,
    // but the gesture is a drag and must not throw the view away.
    expect(shouldDismiss(at(90, 190), at(300, 190))).toBe(false);
  });

  it("when a seek drag is released over the background, then it does not dismiss", () => {
    expect(shouldDismiss(at(195, 604, false), at(195, 480))).toBe(false);
  });

  it("when the press starts on the background but the release lands on a control, then it does not dismiss", () => {
    // Reaching for pause and pressing a few pixels short of it: the release is
    // what counts, so the view stays open.
    expect(shouldDismiss(at(95, 655), at(95, 659, false))).toBe(false);
  });

  it("when there is no recorded press, then a stray click does not dismiss", () => {
    expect(shouldDismiss(null, at(100, 100))).toBe(false);
  });
});
