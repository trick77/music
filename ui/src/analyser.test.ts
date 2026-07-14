import { describe, it, expect, beforeEach, vi } from "vitest";

// A minimal, controllable AudioContext mock. state is flipped manually so tests
// can reproduce the suspended -> running transition that resume() triggers
// asynchronously in a real browser.
let lastCtx: MockAudioContext;

class MockAudioContext {
  state: "suspended" | "running" = "suspended";
  destination = {};
  createMediaElementSource = vi.fn(() => ({ connect: vi.fn() }));
  resume = vi.fn();
  private listeners: Array<() => void> = [];

  constructor() {
    lastCtx = this; // capture the instance the module under test creates
    lastCtx.state = initialState;
  }

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 128,
      connect: vi.fn(),
      getByteFrequencyData: vi.fn(),
    };
  }
  addEventListener(_type: "statechange", cb: () => void) {
    this.listeners.push(cb);
  }
  removeEventListener(_type: "statechange", cb: () => void) {
    this.listeners = this.listeners.filter((l) => l !== cb);
  }
  // Test helper: move to running and fire statechange, like a resolved resume().
  goRunning() {
    this.state = "running";
    for (const l of [...this.listeners]) l();
  }
}

let initialState: "suspended" | "running" = "suspended";

// Fresh module state per test (analyser.ts holds module-level singletons). The
// module creates the context itself; MockAudioContext's constructor captures the
// instance into lastCtx so the test can drive its state.
async function freshAnalyser(state: "suspended" | "running") {
  vi.resetModules();
  initialState = state;
  lastCtx = undefined as unknown as MockAudioContext; // no context created until attach() needs one
  vi.stubGlobal("window", { AudioContext: MockAudioContext });
  return import("./analyser");
}

const el = {} as HTMLMediaElement;

describe("attach", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("defers the tap while the context is suspended, then taps once it runs", async () => {
    const { attach, isAttached } = await freshAnalyser("suspended");

    attach(el);

    // The element must NOT be rerouted into a still-suspended (silent) graph.
    expect(lastCtx.createMediaElementSource).not.toHaveBeenCalled();
    expect(isAttached()).toBe(false);
    expect(lastCtx.resume).toHaveBeenCalled();

    // Once the context reaches running, the deferred tap fires exactly once.
    lastCtx.goRunning();
    expect(lastCtx.createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(lastCtx.createMediaElementSource).toHaveBeenCalledWith(el);
    expect(isAttached()).toBe(true);
  });

  it("taps immediately when the context is already running", async () => {
    const { attach, isAttached } = await freshAnalyser("running");

    attach(el);

    expect(lastCtx.createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(isAttached()).toBe(true);
  });

  it("does not stack statechange listeners across repeated frame-loop calls", async () => {
    const { attach } = await freshAnalyser("suspended");

    attach(el);
    attach(el);
    attach(el);

    // Three attach() calls while suspended must still tap exactly once when the
    // context starts (one pending element, one listener).
    lastCtx.goRunning();
    expect(lastCtx.createMediaElementSource).toHaveBeenCalledTimes(1);
  });

  it("is a no-op once tapped (element already routed)", async () => {
    const { attach } = await freshAnalyser("running");

    attach(el);
    attach({} as HTMLMediaElement); // a different element must be ignored
    expect(lastCtx.createMediaElementSource).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when passed a null element", async () => {
    const { attach, isAttached } = await freshAnalyser("running");

    attach(null);
    expect(lastCtx).toBeUndefined(); // no AudioContext even created for a null element
    expect(isAttached()).toBe(false);
  });
});
