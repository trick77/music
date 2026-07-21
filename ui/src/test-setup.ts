// test-setup.ts — vitest setupFiles entry (see vite.config.ts `test.setupFiles`).
// Wires jest-dom's extra matchers (toBeInTheDocument, etc.) into vitest's
// `expect`, and cleans up the DOM between tests so components mounted by
// one test don't leak into the next.
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Node ships an experimental global `localStorage` that shadows jsdom's. Without
// a --localstorage-file it initialises to a bare object with no Storage methods
// at all, so any call to getItem/setItem/removeItem throws a TypeError — which
// would take down every test that touches the player's reload-restore snapshot
// or the anonymous favourites list. Install a real in-memory Storage over it.
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.has(key) ? (this.data.get(key) as string) : null;
  }
  key(index: number) {
    return Array.from(this.data.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value));
  }
}

const storage = new MemoryStorage();
for (const target of [globalThis, globalThis.window]) {
  if (!target) continue;
  Object.defineProperty(target, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
}

// jsdom implements no media playback: HTMLMediaElement.play/pause/load are
// stubs that throw "not implemented", and play() returns undefined rather than
// the Promise the spec requires — which the player awaits. Give them the right
// shapes so mounting anything that cues a track does not explode.
Object.defineProperty(HTMLMediaElement.prototype, "play", {
  configurable: true,
  writable: true,
  value: function play() {
    return Promise.resolve();
  },
});
for (const name of ["pause", "load"]) {
  Object.defineProperty(HTMLMediaElement.prototype, name, {
    configurable: true,
    writable: true,
    value: () => {},
  });
}

// jsdom does no layout, so it does not implement elementFromPoint at all —
// calling it throws. The background-dismiss gesture resolves what sits under the
// release point with it, so give it the answer a layout-less document honestly
// has: nothing. Callers already fall back to the event target when it returns
// null, which is the same path this code took before the suite ran in jsdom.
// Individual tests can override this to assert the release-point branch.
Object.defineProperty(document, "elementFromPoint", {
  configurable: true,
  writable: true,
  value: () => null,
});

afterEach(() => {
  // A singleton store leaks between tests otherwise: a snapshot persisted by one
  // test would be restored by the next one's player.
  storage.clear();
  cleanup();
});
