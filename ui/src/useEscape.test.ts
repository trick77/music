import { describe, it, expect } from "vitest";
import { pushEscape, removeEscape, dispatchEscape, escapeDepth } from "./useEscape";

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
