// useFavorites drives the heart button everywhere in the app, and its whole job
// is choosing between two backends (localStorage vs. the server) from the auth
// state. Rendering it needs React's hook contract, not a DOM, so it runs on the
// shared node-environment harness like the other hooks in this suite.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

import { reactStub, renderHook } from "./testHooks";

vi.mock("react", () => reactStub);

const { useFavorites } = await import("./favorites");
const api = await import("./api");

const KEY = "music.favorites";

// fakeWindow gives the hook the two globals it touches: localStorage and the
// storage-event subscription used for cross-tab sync.
function fakeWindow(initial?: string[]) {
  const store = new Map<string, string>();
  if (initial) store.set(KEY, JSON.stringify(initial));
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  return {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((f) => f !== fn),
      );
    },
    // Test helpers (not part of the Window surface the hook uses).
    raw: store,
    listenerCount: (type: string) => (listeners.get(type) ?? []).length,
    emitStorage: (key: string) => {
      for (const fn of listeners.get("storage") ?? []) fn({ key });
    },
  };
}

let win: ReturnType<typeof fakeWindow>;

function install(initial?: string[]) {
  win = fakeWindow(initial);
  vi.stubGlobal("window", win);
  return win;
}

// Lets a resolved promise chain (getFavorites().then, persist.catch) settle.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => install());

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useFavorites while auth is still loading", () => {
  it("holds an empty list and never reads storage", () => {
    install(["a", "b"]);
    const h = renderHook(() => useFavorites(null));
    // Reading localStorage here would flash an anonymous list at a user who is
    // about to resolve as logged in.
    expect(h.result().ids).toEqual([]);
    expect(h.result().has("a")).toBe(false);
  });

  it("ignores a toggle rather than writing to a backend it hasn't picked yet", () => {
    const w = install();
    const h = renderHook(() => useFavorites(null));
    h.result().toggle("a");
    expect(h.result().ids).toEqual([]);
    expect(w.raw.get(KEY)).toBeUndefined();
  });

  it("subscribes to nothing", () => {
    const w = install();
    renderHook(() => useFavorites(null));
    expect(w.listenerCount("storage")).toBe(0);
  });
});

describe("useFavorites when anonymous", () => {
  it("seeds from localStorage", () => {
    install(["a", "b"]);
    const h = renderHook(() => useFavorites(false));
    expect(h.result().ids).toEqual(["a", "b"]);
    expect(h.result().has("b")).toBe(true);
    expect(h.result().has("z")).toBe(false);
  });

  it("toggles an id on and persists it", () => {
    const w = install();
    const h = renderHook(() => useFavorites(false));
    h.result().toggle("a");
    expect(h.result().ids).toEqual(["a"]);
    expect(JSON.parse(w.raw.get(KEY)!)).toEqual(["a"]);
  });

  it("toggles an id back off", () => {
    const w = install(["a", "b"]);
    const h = renderHook(() => useFavorites(false));
    h.result().toggle("a");
    expect(h.result().ids).toEqual(["b"]);
    expect(JSON.parse(w.raw.get(KEY)!)).toEqual(["b"]);
  });

  it("picks up a change made in another tab", () => {
    const w = install(["a"]);
    const h = renderHook(() => useFavorites(false));
    w.raw.set(KEY, JSON.stringify(["a", "c"]));
    w.emitStorage(KEY);
    expect(h.result().ids).toEqual(["a", "c"]);
  });

  it("ignores storage events for other keys", () => {
    const w = install(["a"]);
    const h = renderHook(() => useFavorites(false));
    w.raw.set(KEY, JSON.stringify(["a", "c"]));
    w.emitStorage("some.other.key");
    expect(h.result().ids).toEqual(["a"]);
  });

  it("unsubscribes on unmount", () => {
    const w = install();
    const h = renderHook(() => useFavorites(false));
    expect(w.listenerCount("storage")).toBe(1);
    h.unmount();
    expect(w.listenerCount("storage")).toBe(0);
  });

  it("never calls the favorites API", async () => {
    const get = vi.spyOn(api, "getFavorites");
    const add = vi.spyOn(api, "addFavorite");
    const h = renderHook(() => useFavorites(false));
    h.result().toggle("a");
    await flush();
    expect(get).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });
});

describe("useFavorites when logged in", () => {
  it("loads the server list", async () => {
    vi.spyOn(api, "getFavorites").mockResolvedValue(["s1", "s2"]);
    const h = renderHook(() => useFavorites(true));
    expect(h.result().ids).toEqual([]); // nothing before the round-trip lands
    await flush();
    expect(h.result().ids).toEqual(["s1", "s2"]);
    expect(h.result().has("s2")).toBe(true);
  });

  it("keeps an empty list when the load fails", async () => {
    vi.spyOn(api, "getFavorites").mockRejectedValue(new Error("401"));
    const h = renderHook(() => useFavorites(true));
    await flush();
    expect(h.result().ids).toEqual([]);
  });

  it("never reads localStorage", async () => {
    const w = install(["local-only"]);
    vi.spyOn(api, "getFavorites").mockResolvedValue([]);
    const h = renderHook(() => useFavorites(true));
    await flush();
    // A logged-in view showing the anonymous list would be showing someone
    // else's favorites.
    expect(h.result().ids).toEqual([]);
    expect(w.raw.get(KEY)).toBe(JSON.stringify(["local-only"]));
  });

  it("adds optimistically and PUTs to the server", async () => {
    vi.spyOn(api, "getFavorites").mockResolvedValue([]);
    const add = vi.spyOn(api, "addFavorite").mockResolvedValue(undefined);
    const h = renderHook(() => useFavorites(true));
    await flush();
    h.result().toggle("s1");
    expect(h.result().ids).toEqual(["s1"]); // painted before the request resolves
    expect(add).toHaveBeenCalledWith("s1");
    await flush();
    expect(h.result().ids).toEqual(["s1"]);
  });

  it("removes optimistically and DELETEs on the server", async () => {
    vi.spyOn(api, "getFavorites").mockResolvedValue(["s1", "s2"]);
    const remove = vi.spyOn(api, "removeFavorite").mockResolvedValue(undefined);
    const h = renderHook(() => useFavorites(true));
    await flush();
    h.result().toggle("s1");
    expect(h.result().ids).toEqual(["s2"]);
    expect(remove).toHaveBeenCalledWith("s1");
  });

  it("reverts the add when the server rejects it", async () => {
    vi.spyOn(api, "getFavorites").mockResolvedValue(["s2"]);
    vi.spyOn(api, "addFavorite").mockRejectedValue(new Error("offline"));
    const h = renderHook(() => useFavorites(true));
    await flush();
    h.result().toggle("s1");
    expect(h.result().ids).toEqual(["s2", "s1"]);
    await flush();
    expect(h.result().ids).toEqual(["s2"]); // heart un-fills again
  });

  it("reverts the removal when the server rejects it", async () => {
    vi.spyOn(api, "getFavorites").mockResolvedValue(["s1", "s2"]);
    vi.spyOn(api, "removeFavorite").mockRejectedValue(new Error("offline"));
    const h = renderHook(() => useFavorites(true));
    await flush();
    h.result().toggle("s1");
    expect(h.result().ids).toEqual(["s2"]);
    await flush();
    expect(h.result().ids).toContain("s1");
  });

  // The revert must not resurrect an id the user re-added in the meantime, or a
  // failed removal would leave a duplicate in the list.
  it("does not duplicate an id that came back before the failed removal reverted", async () => {
    vi.spyOn(api, "getFavorites").mockResolvedValue(["s1"]);
    vi.spyOn(api, "removeFavorite").mockRejectedValue(new Error("offline"));
    vi.spyOn(api, "addFavorite").mockResolvedValue(undefined);
    const h = renderHook(() => useFavorites(true));
    await flush();
    h.result().toggle("s1"); // optimistic removal, will fail
    h.result().toggle("s1"); // user re-adds before the failure lands
    expect(h.result().ids).toEqual(["s1"]);
    await flush();
    expect(h.result().ids).toEqual(["s1"]);
  });

  it("does not subscribe to storage events", async () => {
    const w = install();
    vi.spyOn(api, "getFavorites").mockResolvedValue([]);
    renderHook(() => useFavorites(true));
    await flush();
    expect(w.listenerCount("storage")).toBe(0);
  });
});

describe("useFavorites when auth resolves after mount", () => {
  it("switches from the loading list to the server list", async () => {
    const get = vi.spyOn(api, "getFavorites").mockResolvedValue(["s1"]);
    let authed: boolean | null = null;
    const h = renderHook(() => useFavorites(authed));
    expect(h.result().ids).toEqual([]);
    expect(get).not.toHaveBeenCalled();

    authed = true;
    h.rerender();
    await flush();
    expect(get).toHaveBeenCalledTimes(1);
    expect(h.result().ids).toEqual(["s1"]);
  });

  it("switches from the loading list to localStorage when anonymous", () => {
    install(["a"]);
    let authed: boolean | null = null;
    const h = renderHook(() => useFavorites(authed));
    expect(h.result().ids).toEqual([]);

    authed = false;
    h.rerender();
    expect(h.result().ids).toEqual(["a"]);
  });

  // A logout drops the server list rather than leaving the previous user's
  // hearts filled in.
  it("drops the server list when auth flips to anonymous", async () => {
    vi.spyOn(api, "getFavorites").mockResolvedValue(["s1"]);
    let authed: boolean | null = true;
    const h = renderHook(() => useFavorites(authed));
    await flush();
    expect(h.result().ids).toEqual(["s1"]);

    authed = false;
    h.rerender();
    expect(h.result().ids).toEqual([]); // localStorage is empty here
  });

  it("ignores a server list that lands after the hook unmounts", async () => {
    let settle: (v: string[]) => void = () => {};
    vi.spyOn(api, "getFavorites").mockReturnValue(
      new Promise<string[]>((r) => {
        settle = r;
      }),
    );
    const h = renderHook(() => useFavorites(true));
    h.unmount();
    settle(["s1"]);
    await flush();
    expect(h.result().ids).toEqual([]);
  });
});
