// Test-only React hook harness.
//
// The suite runs in the plain node environment — no jsdom, no @testing-library —
// so the hooks in this codebase (useImageDrop, useBackgroundDismiss, useEscape,
// useRoute, usePlayer) cannot be exercised by rendering. renderToStaticMarkup,
// which the .tsx tests use, runs a render pass but never flushes effects, so the
// effect-driven behaviour (the escape stack claiming its slot, popstate
// subscriptions, player subscriptions) stays unreachable through it.
//
// This module supplies just enough of React's hook contract to drive those hooks
// directly: per-instance slots, a setState that re-renders synchronously, and
// effects that run after the render pass with proper dep-comparison and cleanup.
// Tests wire it in with `vi.mock("react", () => reactStub)`.

type Slot = unknown;
type EffectSlot = { deps?: unknown[]; cleanup?: () => void };
type Pending = { i: number; fn: () => (() => void) | void; deps?: unknown[] };

type Instance = {
  render: () => unknown;
  slots: Slot[];
  effects: EffectSlot[];
  pending: Pending[];
  slotIndex: number;
  effectIndex: number;
  result: unknown;
};

let current: Instance | null = null;

function instance(): Instance {
  if (!current) throw new Error("hook called outside of renderHook()");
  return current;
}

function depsChanged(
  prev: EffectSlot | undefined,
  deps: unknown[] | undefined,
): boolean {
  if (!prev) return true;
  if (!deps || !prev.deps) return true; // no dep array — every render re-runs
  if (deps.length !== prev.deps.length) return true;
  return deps.some((d, i) => !Object.is(d, prev.deps![i]));
}

export const reactStub = {
  useState<T>(init: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
    const c = instance();
    const i = c.slotIndex++;
    if (!(i in c.slots)) {
      const set = (next: T | ((prev: T) => T)) => {
        const slot = c.slots[i] as [T, unknown];
        slot[0] =
          typeof next === "function" ? (next as (prev: T) => T)(slot[0]) : next;
        render(c);
      };
      c.slots[i] = [
        typeof init === "function" ? (init as () => T)() : init,
        set,
      ];
    }
    return c.slots[i] as [T, (next: T | ((prev: T) => T)) => void];
  },

  useRef<T>(init: T): { current: T } {
    const c = instance();
    const i = c.slotIndex++;
    if (!(i in c.slots)) c.slots[i] = { current: init };
    return c.slots[i] as { current: T };
  },

  // Identity-stable memoisation is a performance detail, not behaviour, so the
  // harness deliberately does not reproduce it — tests assert what the handlers
  // DO, never that two renders returned the same function object.
  useCallback<T>(fn: T): T {
    instance().slotIndex++;
    return fn;
  },

  useEffect(fn: () => (() => void) | void, deps?: unknown[]): void {
    const c = instance();
    const i = c.effectIndex++;
    if (depsChanged(c.effects[i], deps)) c.pending.push({ i, fn, deps });
  },
};

function render(c: Instance) {
  c.slotIndex = 0;
  c.effectIndex = 0;
  c.pending = [];
  const outer = current;
  current = c;
  try {
    c.result = c.render();
  } finally {
    current = outer;
  }
  // Effects flush after the render pass, cleaning up the previous run first —
  // the ordering useEscape depends on to keep its stack slot stable.
  const pending = c.pending;
  c.pending = [];
  for (const p of pending) {
    c.effects[p.i]?.cleanup?.();
    // Commit the deps BEFORE running the effect. An effect that sets state
    // synchronously (usePlayer seeding its snapshot) re-enters render from here;
    // with the slot still empty that render would see the effect as new and run
    // it again, forever.
    const slot: EffectSlot = { deps: p.deps };
    c.effects[p.i] = slot;
    const cleanup = p.fn();
    if (typeof cleanup === "function") slot.cleanup = cleanup;
  }
}

export type Rendered<T> = {
  /** Latest value the hook returned. */
  result: () => T;
  /** Re-run the hook (pick up changed closed-over props). */
  rerender: () => void;
  /** Run every effect cleanup, as unmounting the component would. */
  unmount: () => void;
};

export function renderHook<T>(hook: () => T): Rendered<T> {
  const c: Instance = {
    render: hook,
    slots: [],
    effects: [],
    pending: [],
    slotIndex: 0,
    effectIndex: 0,
    result: undefined,
  };
  render(c);
  return {
    result: () => c.result as T,
    rerender: () => render(c),
    unmount: () => {
      for (const e of c.effects) e?.cleanup?.();
      c.effects.length = 0;
    },
  };
}
