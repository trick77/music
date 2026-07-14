import { describe, it, expect, beforeEach, vi } from "vitest";

// A minimal, controllable AudioContext mock. createMediaElementSource is the tap
// we care about; resume() records that the context was un-suspended.
let lastCtx: MockAudioContext;

class MockAudioContext {
  state: "suspended" | "running" = "suspended";
  destination = {};
  createMediaElementSource = vi.fn(() => ({ connect: vi.fn() }));
  resume = vi.fn(() => {
    this.state = "running";
  });

  constructor() {
    lastCtx = this; // capture the instance the module under test creates
  }

  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      minDecibels: 0,
      maxDecibels: 0,
      frequencyBinCount: 128,
      connect: vi.fn(),
      getByteFrequencyData: vi.fn(),
    };
  }
}

// Fresh module state per test (analyser.ts holds module-level singletons). The
// module creates the context itself; MockAudioContext's constructor captures the
// instance into lastCtx so the test can inspect its calls.
async function freshAnalyser() {
  vi.resetModules();
  lastCtx = undefined as unknown as MockAudioContext; // no context until attach() needs one
  vi.stubGlobal("window", { AudioContext: MockAudioContext });
  return import("./analyser");
}

const el = {} as HTMLMediaElement;

describe("attach", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("taps the element immediately when a context is available", async () => {
    const { attach, isAttached } = await freshAnalyser();

    attach(el);

    expect(lastCtx.createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(lastCtx.createMediaElementSource).toHaveBeenCalledWith(el);
    expect(isAttached()).toBe(true);
  });

  it("is idempotent across repeated calls (taps exactly once)", async () => {
    const { attach } = await freshAnalyser();

    attach(el);
    attach(el);
    attach(el);

    expect(lastCtx.createMediaElementSource).toHaveBeenCalledTimes(1);
  });

  it("is a no-op once tapped (a different element is ignored)", async () => {
    const { attach } = await freshAnalyser();

    attach(el);
    attach({} as HTMLMediaElement);

    expect(lastCtx.createMediaElementSource).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when passed a null element (no context even created)", async () => {
    const { attach, isAttached } = await freshAnalyser();

    attach(null);

    expect(lastCtx).toBeUndefined();
    expect(isAttached()).toBe(false);
  });
});

describe("prime", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("taps the element and un-suspends the context so audio flows on play", async () => {
    const { prime, isAttached } = await freshAnalyser();

    prime(el);

    expect(lastCtx.createMediaElementSource).toHaveBeenCalledTimes(1);
    expect(lastCtx.resume).toHaveBeenCalled();
    expect(lastCtx.state).toBe("running");
    expect(isAttached()).toBe(true);
  });

  it("is a no-op on a null element", async () => {
    const { prime, isAttached } = await freshAnalyser();

    prime(null);

    expect(lastCtx).toBeUndefined();
    expect(isAttached()).toBe(false);
  });
});
