import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { reactStub, renderHook } from "./testHooks";

vi.mock("react", () => reactStub);

const { pushEscape, removeEscape, dispatchEscape, escapeDepth, useEscape } = await import("./useEscape");

// The hook's value is the ordering rule — Escape reaches the topmost surface and
// nothing else — so that's what's tested here, directly and without a DOM. The
// stack is module state, so every test unregisters what it registers.
describe("escape stack", () => {
  it("when nothing is registered, then a press is not handled", () => {
    expect(escapeDepth()).toBe(0);
    expect(dispatchEscape()).toBe(false);
  });

  it("when one surface is open, then it handles the press", () => {
    const fired: string[] = [];
    const a = pushEscape(() => fired.push("a"));

    expect(dispatchEscape()).toBe(true);
    expect(fired).toEqual(["a"]);

    removeEscape(a);
  });

  it("when surfaces stack, then only the topmost handles the press", () => {
    // The exact regression this module exists to prevent: a dialog over a drawer
    // must not close both on one press.
    const fired: string[] = [];
    const under = pushEscape(() => fired.push("under"));
    const over = pushEscape(() => fired.push("over"));

    dispatchEscape();
    expect(fired).toEqual(["over"]);

    // Once the top one leaves, the press reaches the one beneath — and only then.
    removeEscape(over);
    dispatchEscape();
    expect(fired).toEqual(["over", "under"]);

    removeEscape(under);
  });

  it("when a surface closes out of order, then the remaining stack keeps its order", () => {
    const fired: string[] = [];
    const a = pushEscape(() => fired.push("a"));
    const b = pushEscape(() => fired.push("b"));
    const c = pushEscape(() => fired.push("c"));

    removeEscape(b); // middle leaves — c is still on top
    dispatchEscape();
    expect(fired).toEqual(["c"]);

    removeEscape(c);
    dispatchEscape();
    expect(fired).toEqual(["c", "a"]);

    removeEscape(a);
    expect(escapeDepth()).toBe(0);
  });

  it("when a surface is removed twice, then it does not disturb the stack", () => {
    const fired: string[] = [];
    const a = pushEscape(() => fired.push("a"));
    const b = pushEscape(() => fired.push("b"));

    removeEscape(b);
    removeEscape(b); // idempotent — must not pop a as collateral
    expect(escapeDepth()).toBe(1);

    dispatchEscape();
    expect(fired).toEqual(["a"]);

    removeEscape(a);
  });
});

// The hook itself: it owns *when* a surface holds a slot, and it owns the single
// window keydown listener the whole app shares. Both are behaviours the pure
// stack functions above cannot show.
describe("useEscape", () => {
  let handlers: Record<string, Array<(e: KeyboardEvent) => void>>;
  let added: string[];
  let removed: string[];

  const press = (key: string) => {
    for (const fn of handlers["keydown"] ?? []) fn({ key } as KeyboardEvent);
  };

  beforeEach(() => {
    handlers = {};
    added = [];
    removed = [];
    vi.stubGlobal("window", {
      addEventListener: (t: string, fn: (e: KeyboardEvent) => void) => {
        added.push(t);
        (handlers[t] ??= []).push(fn);
      },
      removeEventListener: (t: string, fn: (e: KeyboardEvent) => void) => {
        removed.push(t);
        handlers[t] = (handlers[t] ?? []).filter((h) => h !== fn);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    expect(escapeDepth()).toBe(0); // every test must leave the shared stack empty
  });

  it("when a surface is open, then Escape reaches it", () => {
    const fired: string[] = [];
    const view = renderHook(() => useEscape(true, () => fired.push("close")));

    press("Escape");
    expect(fired).toEqual(["close"]);

    view.unmount();
  });

  it("when another key is pressed, then nothing is dismissed", () => {
    const fired: string[] = [];
    const view = renderHook(() => useEscape(true, () => fired.push("close")));

    press("Enter");
    press("a");
    expect(fired).toEqual([]);

    view.unmount();
  });

  it("when several surfaces are open, then one shared listener serves them all", () => {
    const first = renderHook(() => useEscape(true, () => {}));
    const second = renderHook(() => useEscape(true, () => {}));

    // One listener for the whole app: independent listeners are exactly what
    // would close the entire stack on a single press.
    expect(added.filter((t) => t === "keydown")).toHaveLength(1);
    expect(escapeDepth()).toBe(2);

    second.unmount();
    expect(removed).toEqual([]); // still one surface up — the listener stays
    first.unmount();
    expect(removed).toEqual(["keydown"]);
  });

  it("when a surface is disabled, then it holds no slot and Escape falls through", () => {
    const fired: string[] = [];
    const hidden = renderHook(() => useEscape(false, () => fired.push("hidden")));

    expect(escapeDepth()).toBe(0);
    press("Escape");
    expect(fired).toEqual([]);

    hidden.unmount();
  });

  it("when a surface opens, then it takes the top slot from the one beneath", () => {
    const fired: string[] = [];
    let dialogOpen = false;
    const drawer = renderHook(() => useEscape(true, () => fired.push("drawer")));
    const dialog = renderHook(() => useEscape(dialogOpen, () => fired.push("dialog")));

    press("Escape");
    expect(fired).toEqual(["drawer"]); // dialog not up yet

    dialogOpen = true;
    dialog.rerender();
    press("Escape");
    expect(fired).toEqual(["drawer", "dialog"]);

    // Closing the dialog hands the press back to the drawer, and only then.
    dialogOpen = false;
    dialog.rerender();
    press("Escape");
    expect(fired).toEqual(["drawer", "dialog", "drawer"]);

    dialog.unmount();
    drawer.unmount();
  });

  it("when the handler is an inline arrow, then re-rendering runs the latest one without reshuffling the stack", () => {
    // The regression the ref guards: a background surface re-rendering (new arrow
    // prop each time) must not re-push itself above the surface covering it.
    const fired: string[] = [];
    let label = "v1";
    const under = renderHook(() => useEscape(true, () => fired.push(label)));
    const over = renderHook(() => useEscape(true, () => fired.push("over")));

    label = "v2";
    under.rerender();

    expect(escapeDepth()).toBe(2);
    press("Escape");
    expect(fired).toEqual(["over"]); // still the topmost, not the re-rendered one

    over.unmount();
    press("Escape");
    expect(fired).toEqual(["over", "v2"]); // and it runs the newest closure

    under.unmount();
  });

  it("when the last surface closes, then a later press is unhandled", () => {
    const view = renderHook(() => useEscape(true, () => {}));
    view.unmount();

    expect(escapeDepth()).toBe(0);
    expect(dispatchEscape()).toBe(false);
  });
});

// Guards the harness the hook tests depend on: if effects stopped flushing (or
// cleanups stopped running) the tests above would pass vacuously.
describe("test hook harness", () => {
  it("flushes effects, re-runs on dep change and cleans up on unmount", () => {
    const log: string[] = [];
    let dep = 1;
    const view = renderHook(() => {
      const entry = pushEscapeProbe(log, dep);
      return entry;
    });

    expect(log).toEqual(["effect:1"]);
    view.rerender();
    expect(log).toEqual(["effect:1"]); // same dep — not re-run
    dep = 2;
    view.rerender();
    expect(log).toEqual(["effect:1", "cleanup:1", "effect:2"]);
    view.unmount();
    expect(log).toEqual(["effect:1", "cleanup:1", "effect:2", "cleanup:2"]);
  });

  function pushEscapeProbe(log: string[], dep: number) {
    const entry = reactStub.useRef(0);
    reactStub.useEffect(() => {
      log.push(`effect:${dep}`);
      return () => log.push(`cleanup:${dep}`);
    }, [dep]);
    return entry;
  }
});
