import { describe, it, expect, vi, afterEach } from "vitest";
import { reactStub, renderHook } from "./testHooks";

vi.mock("react", () => reactStub);

const {
  NO_DISMISS_SELECTOR,
  TAP_SLOP_PX,
  isBackgroundTarget,
  shouldDismiss,
  useBackgroundDismiss,
} = await import("./backgroundDismiss");
type Press = import("./backgroundDismiss").Press;

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
  const at = (x: number, y: number, background = true): Press => ({
    x,
    y,
    background,
  });

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

// The hook wires the pure rules above to a real press→release gesture. What it
// adds on top of them — which presses arm the gesture, and resolving what sits
// under the release point rather than trusting the click target — is only
// visible here.
describe("useBackgroundDismiss", () => {
  // stubs standing in for DOM elements; `closest` is all the rule ever calls.
  const control = { closest: () => ({}) };
  const background = { closest: () => null };

  type PointerStub = {
    isPrimary: boolean;
    button: number;
    clientX: number;
    clientY: number;
    target: unknown;
  };
  type ClickStub = {
    detail: number;
    clientX: number;
    clientY: number;
    target: unknown;
  };

  function mount(under: unknown = background) {
    const onDismiss = vi.fn();
    // The view resolves what is under the release point itself, because a click's
    // target is the common ancestor of press and release — the root, when you press
    // beside a button and release on it.
    vi.stubGlobal("document", { elementFromPoint: () => under });
    const view = renderHook(() => useBackgroundDismiss(onDismiss));
    const props = () =>
      view.result() as unknown as {
        onPointerDown: (e: PointerStub) => void;
        onPointerCancel: () => void;
        onClick: (e: ClickStub) => void;
      };
    return { onDismiss, props };
  }

  const down = (
    over: PointerStub["target"] = background,
    o: Partial<PointerStub> = {},
  ): PointerStub => ({
    isPrimary: true,
    button: 0,
    clientX: 100,
    clientY: 100,
    target: over,
    ...o,
  });
  const click = (o: Partial<ClickStub> = {}): ClickStub => ({
    detail: 1,
    clientX: 100,
    clientY: 100,
    target: background,
    ...o,
  });

  afterEach(() => vi.unstubAllGlobals());

  it("when the background is tapped, then the view closes", () => {
    const v = mount();

    v.props().onPointerDown(down());
    v.props().onClick(click());

    expect(v.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("when the press lands on a control, then the view stays open", () => {
    const v = mount();

    v.props().onPointerDown(down(control));
    v.props().onClick(click());

    expect(v.onDismiss).not.toHaveBeenCalled();
  });

  it("when the release point sits on a control, then the view stays open even though the click target is the root", () => {
    // Pressing a few pixels beside pause and releasing on it: the click reports the
    // full-screen root as its target, which would read as background and dismiss.
    const v = mount(control);

    v.props().onPointerDown(down());
    v.props().onClick(click({ target: background }));

    expect(v.onDismiss).not.toHaveBeenCalled();
  });

  it("when the pointer is dragged past the slop radius, then the view stays open", () => {
    const v = mount();

    v.props().onPointerDown(down(background, { clientX: 100, clientY: 100 }));
    v.props().onClick(click({ clientX: 100 + TAP_SLOP_PX + 1, clientY: 100 }));

    expect(v.onDismiss).not.toHaveBeenCalled();
  });

  it("when a secondary or middle button is pressed, then no gesture is armed", () => {
    const v = mount();

    v.props().onPointerDown(down(background, { button: 2 }));
    v.props().onClick(click());
    v.props().onPointerDown(down(background, { isPrimary: false }));
    v.props().onClick(click());

    expect(v.onDismiss).not.toHaveBeenCalled();
  });

  it("when the press is cancelled, then no stale gesture is left armed", () => {
    // A touch pan or a drag off-window: the record must not survive to be consumed
    // by some later click.
    const v = mount();

    v.props().onPointerDown(down());
    v.props().onPointerCancel();
    v.props().onClick(click());

    expect(v.onDismiss).not.toHaveBeenCalled();
  });

  it("when the click is keyboard-synthesized, then it never dismisses", () => {
    // Enter/Space on a focused control reports detail 0 at 0,0 — which would land
    // on the full-screen root and read as a background tap. Esc is the way out.
    const v = mount();

    v.props().onPointerDown(down());
    v.props().onClick(click({ detail: 0, clientX: 0, clientY: 0 }));

    expect(v.onDismiss).not.toHaveBeenCalled();
  });

  it("when a gesture has been consumed, then a second click alone does not dismiss", () => {
    const v = mount();

    v.props().onPointerDown(down());
    v.props().onClick(click());
    v.props().onClick(click());

    expect(v.onDismiss).toHaveBeenCalledTimes(1);
  });

  it("when there is no document to probe, then the click target decides", () => {
    // Server render / non-DOM host: falls back to the event target rather than
    // throwing on a missing elementFromPoint.
    const onDismiss = vi.fn();
    const view = renderHook(() => useBackgroundDismiss(onDismiss));
    const props = view.result() as unknown as {
      onPointerDown: (e: PointerStub) => void;
      onClick: (e: ClickStub) => void;
    };

    props.onPointerDown(down());
    props.onClick(click({ target: control }));
    expect(onDismiss).not.toHaveBeenCalled();

    props.onPointerDown(down());
    props.onClick(click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
