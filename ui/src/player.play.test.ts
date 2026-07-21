import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Song } from "./api";
import { reactStub, renderHook } from "./testHooks";

// usePlayer is a hook and the suite has no DOM; the harness runs it (and flushes
// its subscribe effect) without one. player.ts imports nothing else from React.
vi.mock("react", () => reactStub);

// Records the calls the play path makes. The invariant under test: playing must
// NEVER tap the element into the Web Audio graph. createMediaElementSource()
// pulls the <audio> out of the browser's normal output and into our graph, and
// WebKit interrupts the AudioContext when an iPhone locks — so a tapped element
// goes silent on the lock screen (timer keeps advancing, no sound, returns on
// unlock). Only the visualizer may tap, and only when actually opened.
const { order } = vi.hoisted(() => ({ order: [] as string[] }));

vi.mock("./analyser", () => ({
  // Any of these firing from the play path would mean playback got routed through
  // the Web Audio graph — the exact regression this file guards against. They push
  // to `order` so an accidental tap shows up alongside the play/pause sequence.
  startAnalysis: vi.fn(() => order.push("startAnalysis")),
  stopAnalysis: vi.fn(() => order.push("stopAnalysis")),
  syncAnalysis: vi.fn(() => order.push("syncAnalysis")),
  resume: vi.fn(),
  bands: vi.fn(() => []),
  isAnalysing: vi.fn(() => false),
}));

// The timeupdate ticks the persistence tests drive make reportPlay reachable; it
// would otherwise hit the network. Everything else in ./api stays real.
const { reportPlayMock } = vi.hoisted(() => ({
  reportPlayMock: vi.fn(() => Promise.resolve()),
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  reportPlay: reportPlayMock,
}));

// The player creates its audio element internally, so tests reach it through here.
const audioInstances: MockAudio[] = [];

class MockAudio {
  constructor() {
    audioInstances.push(this);
  }
  paused = true;
  src = "";
  currentTime = 0;
  preload = "";
  duration = 0;
  // Keyed by type but holding every listener: dropping a second one would hide a
  // handler rather than fail loudly.
  handlers: Record<string, Array<() => void>> = {};
  addEventListener = vi.fn((type: string, fn: () => void) => {
    (this.handlers[type] ??= []).push(fn);
  });
  fire(type: string) {
    for (const fn of this.handlers[type] ?? []) fn();
  }
  pause = vi.fn(() => {
    this.paused = true;
  });
  play = vi.fn(() => {
    order.push("play");
    this.paused = false;
    return Promise.resolve();
  });
}

// A listen counts at >=30s OR >=50% of the track (qualifiesForPlay). Tests that
// mean to exercise the 30s rule need a track long enough that the 50% rule can't
// fire first — a 1s fixture would qualify on the very first tick.
const LONG_TRACK_MS = 5 * 60 * 1000;

function song(id: string, durationMs = 1000): Song {
  return {
    id,
    title: id,
    artist: "",
    album: "",
    durationMs,
  } as unknown as Song;
}

// Shared module-level state, reset for every test in the file so no block
// depends on running after another.
beforeEach(() => {
  order.length = 0;
  audioInstances.length = 0;
  reportPlayMock.mockClear();
});

describe("player play path", () => {
  beforeEach(() => {
    vi.resetModules(); // fresh audio-element singleton per test
    vi.stubGlobal("Audio", MockAudio);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("plays without tapping the element into the Web Audio graph", async () => {
    const { player } = await import("./player");

    player.play(song("a"));

    expect(order).toEqual(["play"]);
  });

  it("does not tap the element when resuming from pause via toggle", async () => {
    const { player } = await import("./player");

    player.play(song("a")); // start
    order.length = 0;
    player.toggle(); // pause — no play
    player.toggle(); // resume — plays, still untapped

    expect(order).toEqual(["play"]);
  });

  // The tap itself (startAnalysis → createMediaElementSource) is what breaks
  // lock-screen audio, so the play path must never reach it. Asserted separately
  // from the call order above: a future refactor could reintroduce the tap without
  // disturbing it. (The tap now lands on a dedicated analysis element, never the
  // audible one — but the play path must still never start it.)
  it("never taps the element from the play path, so lock-screen audio survives", async () => {
    const { player } = await import("./player");
    const { startAnalysis } = await import("./analyser");

    player.play(song("a"));
    player.toggle(); // pause
    player.toggle(); // resume

    expect(startAnalysis).not.toHaveBeenCalled();
  });
});

// Advancing past the last song closes the player rather than parking it at 0:00.
// The `ended` listener calls next() for a song that finishes on its own, so this
// is the end-of-queue behaviour users actually hit; the Next control is greyed out
// (Transport's canNext) before it can reach here.
describe("player end of queue", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("Audio", MockAudio);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("closes the player when next() runs with an empty queue", async () => {
    const { player } = await import("./player");

    player.play(song("a")); // nothing queued behind it
    player.next();

    expect(player.getState().current).toBeNull();
    expect(player.getState().playing).toBe(false);
  });

  it("advances normally while the queue still has songs, closing only past the last", async () => {
    const { player } = await import("./player");

    player.play(song("a"), [song("b")]);
    player.next(); // a → b, queue now empty

    expect(player.getState().current?.id).toBe("b");
    expect(player.getState().queue).toEqual([]);

    player.next(); // past the last song → close

    expect(player.getState().current).toBeNull();
  });
});

// A reload brings the docked mini-player back to its exact position — but ONLY
// if a track was actually playing when the page went away. The snapshot is
// written when the page is hidden/unloaded (pagehide / visibilitychange→hidden),
// never on the per-tick timeupdate, and restore() reseeds paused at the saved
// position. This is deliberately narrower than the old `music.resume` feature
// (#178), which reseeded the last track even when paused and only within a
// 30-minute window.
describe("player persistence", () => {
  const KEY = "music.player.v1";
  let store: {
    getItem: ReturnType<typeof vi.fn>;
    setItem: ReturnType<typeof vi.fn>;
    removeItem: ReturnType<typeof vi.fn>;
  };
  // The player registers pagehide (window) and visibilitychange (document) in
  // getAudio; capture their handlers so tests can fire "the page went away".
  let winHandlers: Record<string, Array<() => void>>;
  let docHandlers: Record<string, Array<() => void>>;
  let doc: {
    hidden: boolean;
    addEventListener: (t: string, fn: () => void) => void;
  };

  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("Audio", MockAudio);
    store = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    winHandlers = {};
    docHandlers = {};
    vi.stubGlobal("window", {
      localStorage: store,
      addEventListener: (t: string, fn: () => void) =>
        (winHandlers[t] ??= []).push(fn),
    });
    doc = {
      hidden: false,
      addEventListener: (t: string, fn: () => void) =>
        (docHandlers[t] ??= []).push(fn),
    };
    vi.stubGlobal("document", doc);
  });
  afterEach(() => vi.unstubAllGlobals());

  const firePageHide = () =>
    (winHandlers["pagehide"] ?? []).forEach((fn) => fn());
  const fireHidden = () => {
    doc.hidden = true;
    (docHandlers["visibilitychange"] ?? []).forEach((fn) => fn());
  };

  async function playTo(seconds: number) {
    const { player } = await import("./player");
    player.play(song("a", LONG_TRACK_MS));
    const el = audioInstances[0];
    for (let t = 1; t <= seconds; t++) {
      el.currentTime = t;
      el.fire("timeupdate");
    }
    return player;
  }

  it("does not write to storage on timeupdate ticks — only when the page hides", async () => {
    await playTo(35);
    expect(store.setItem).not.toHaveBeenCalled();
  });

  it("still counts the listen exactly once, and only once the threshold is crossed", async () => {
    // Guards the ticks the persistence path rides on: if the fixture ever let the
    // 50%-of-track rule fire early, this catches it at 29s.
    const player = await playTo(29);
    expect(reportPlayMock).not.toHaveBeenCalled();

    const el = audioInstances[0];
    for (let t = 30; t <= 40; t++) {
      el.currentTime = t;
      el.fire("timeupdate");
    }

    expect(reportPlayMock).toHaveBeenCalledTimes(1);
    expect(player.getState().current?.id).toBe("a");
  });

  it("saves {id, positionMs} when the page hides while playing", async () => {
    await playTo(35); // playing, currentTime = 35s

    firePageHide();

    expect(store.setItem).toHaveBeenCalledTimes(1);
    const [key, value] = store.setItem.mock.calls[0];
    expect(key).toBe(KEY);
    expect(JSON.parse(value)).toEqual({ id: "a", positionMs: 35_000 });
  });

  it("saves on visibilitychange→hidden too (the mobile signal)", async () => {
    await playTo(12);

    fireHidden();

    expect(store.setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.setItem.mock.calls[0][1])).toEqual({
      id: "a",
      positionMs: 12_000,
    });
  });

  it("clears the key when the page hides while paused (not playing → no restore)", async () => {
    const player = await playTo(20);
    player.toggle(); // pause

    firePageHide();

    expect(store.setItem).not.toHaveBeenCalled();
    expect(store.removeItem).toHaveBeenCalledWith(KEY);
  });

  it("clears the key when the page hides with the player closed", async () => {
    const player = await playTo(20);
    player.stop(); // current === null

    firePageHide();

    expect(store.setItem).not.toHaveBeenCalled();
    expect(store.removeItem).toHaveBeenCalledWith(KEY);
  });

  it("restore() reseeds paused at the saved position once metadata loads", async () => {
    const { player } = await import("./player");

    player.restore(song("a", LONG_TRACK_MS), 42_000);

    // Cued but paused, position reflected immediately for the scrubber.
    expect(player.getState().current?.id).toBe("a");
    expect(player.getState().playing).toBe(false);
    expect(player.getState().positionMs).toBe(42_000);

    // The seek lands only once the element can seek (loadedmetadata).
    const el = audioInstances[0];
    el.duration = LONG_TRACK_MS / 1000;
    el.fire("loadedmetadata");
    expect(el.currentTime).toBe(42);
  });

  it("does not re-count a listen when restoring past the counting threshold", async () => {
    const { player } = await import("./player");

    player.restore(song("a", LONG_TRACK_MS), 45_000); // already qualifies (>= 30s)
    const el = audioInstances[0];
    el.duration = LONG_TRACK_MS / 1000;
    el.fire("loadedmetadata");
    el.play(); // user resumes
    for (let t = 46; t <= 60; t++) {
      el.currentTime = t;
      el.fire("timeupdate");
    }

    expect(reportPlayMock).not.toHaveBeenCalled(); // counted before the reload
  });

  it("counts a fresh listen when restoring before the threshold", async () => {
    const { player } = await import("./player");

    player.restore(song("a", LONG_TRACK_MS), 5_000); // below 30s — not yet counted
    const el = audioInstances[0];
    el.duration = LONG_TRACK_MS / 1000;
    el.fire("loadedmetadata");
    for (let t = 6; t <= 40; t++) {
      el.currentTime = t;
      el.fire("timeupdate");
    }

    expect(reportPlayMock).toHaveBeenCalledTimes(1);
  });
});

// ── The side-effecting singleton ───────────────────────────────────────────
// Everything below drives the real player object against hand-stubbed audio, OS
// media-session and storage globals. The behaviours are the ones a user can feel:
// what the transport does, what the lock-screen widget shows, and what survives a
// reload.

// The audible element plus the bits only Safari has, so the AirPlay wiring is
// reachable. Nothing here ever produces sound — play() only flips a flag.
class SafariMockAudio extends MockAudio {
  playbackRate = 1;
  webkitCurrentPlaybackTargetIsWireless = false;
  webkitShowPlaybackTargetPicker = vi.fn();
  // The AirPlay listeners take an event argument, unlike the rest.
  fireWith(type: string, e: unknown) {
    for (const fn of this.handlers[type] ?? [])
      (fn as unknown as (ev: unknown) => void)(e);
  }
}

type MediaSessionStub = {
  metadata: unknown;
  playbackState: string;
  handlers: Record<string, (() => void) | null>;
  setActionHandler: (a: string, h: (() => void) | null) => void;
  setPositionState: ReturnType<typeof vi.fn>;
};

function stubEnvironment() {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  const winHandlers: Record<string, Array<() => void>> = {};
  vi.stubGlobal("window", {
    localStorage,
    addEventListener: (t: string, fn: () => void) =>
      (winHandlers[t] ??= []).push(fn),
  });
  const docHandlers: Record<string, Array<() => void>> = {};
  vi.stubGlobal("document", {
    hidden: false,
    addEventListener: (t: string, fn: () => void) =>
      (docHandlers[t] ??= []).push(fn),
  });
  const mediaSession: MediaSessionStub = {
    metadata: null,
    playbackState: "none",
    handlers: {},
    setActionHandler(a, h) {
      this.handlers[a] = h;
    },
    setPositionState: vi.fn(),
  };
  vi.stubGlobal("navigator", { mediaSession });
  vi.stubGlobal(
    "MediaMetadata",
    class {
      constructor(init: Record<string, unknown>) {
        Object.assign(this, init);
      }
    },
  );
  vi.stubGlobal("Audio", SafariMockAudio);
  return { store, mediaSession };
}

const el = () => audioInstances[0] as SafariMockAudio;

describe("player transport", () => {
  let env: ReturnType<typeof stubEnvironment>;

  beforeEach(() => {
    vi.resetModules();
    env = stubEnvironment();
  });
  afterEach(() => vi.unstubAllGlobals());

  const load = () => import("./player");

  it("cues the track, seeds duration from its metadata and starts it", async () => {
    const { player } = await load();

    player.play(song("a", 200_000));

    const s = player.getState();
    expect(s.current?.id).toBe("a");
    expect(s.durationMs).toBe(200_000);
    expect(s.positionMs).toBe(0);
    expect(el().src).toContain("a");
    expect(el().play).toHaveBeenCalled();
    expect(player.getAudioElement()).toBe(el());
  });

  it("pushes the outgoing track onto history when a different song is played", async () => {
    const { player } = await load();

    player.play(song("a"));
    player.play(song("b"));

    expect(player.getState().history.map((h) => h.id)).toEqual(["a"]);
  });

  it("does not stack the same song onto its own history when replayed", async () => {
    // Tapping the already-playing row restarts it; it must not become its own
    // "previous track".
    const { player } = await load();

    player.play(song("a"));
    player.play(song("a"));

    expect(player.getState().history).toEqual([]);
  });

  it("replaces the up-next queue wholesale", async () => {
    const { player } = await load();

    player.play(song("a"), [song("b")]);
    player.setQueue([song("c"), song("d")]);

    expect(player.getState().queue.map((q) => q.id)).toEqual(["c", "d"]);
  });

  it("notifies subscribers on every change, and stops once unsubscribed", async () => {
    const { player } = await load();
    const seen: Array<string | null> = [];
    const unsub = player.subscribe(() =>
      seen.push(player.getState().current?.id ?? null),
    );

    player.play(song("a"));
    expect(seen).toEqual(["a"]);

    unsub();
    player.play(song("b"));
    expect(seen).toEqual(["a"]);
  });

  it("toggles pause and resume against the element's own state", async () => {
    const { player } = await load();
    player.play(song("a"));
    el().fire("play");
    expect(player.getState().playing).toBe(true);

    player.toggle();
    el().fire("pause");
    expect(el().pause).toHaveBeenCalled();
    expect(player.getState().playing).toBe(false);

    player.toggle();
    el().fire("play");
    expect(player.getState().playing).toBe(true);
  });

  it("ignores toggle and stop when nothing is loaded", async () => {
    const { player } = await load();

    player.toggle();
    player.stop();

    expect(audioInstances).toHaveLength(0); // no element created for a no-op
    expect(player.getState().current).toBeNull();
  });

  it("closes the player on stop, clearing queue, history and position", async () => {
    const { player } = await load();
    player.play(song("a"), [song("b")]);

    player.stop();

    expect(player.getState()).toMatchObject({
      current: null,
      queue: [],
      history: [],
      playing: false,
      positionMs: 0,
      durationMs: 0,
    });
    expect(el().pause).toHaveBeenCalled();
  });

  it("plays the next track when the current one ends by itself", async () => {
    const { player } = await load();
    player.play(song("a"), [song("b")]);

    el().fire("ended");

    expect(player.getState().current?.id).toBe("b");
    expect(player.getState().history.map((h) => h.id)).toEqual(["a"]);
  });

  describe("previous", () => {
    it("restarts the track when well into it, rather than stepping back", async () => {
      const { player } = await load();
      player.play(song("a"), []);
      player.play(song("b"));
      el().currentTime = 12; // past the 3s threshold

      player.prev();

      expect(player.getState().current?.id).toBe("b");
      expect(el().currentTime).toBe(0);
      expect(player.getState().positionMs).toBe(0);
      expect(player.getState().history.map((h) => h.id)).toEqual(["a"]);
    });

    it("steps back to the previous track near the start, pushing the current one up next", async () => {
      const { player } = await load();
      player.play(song("a"));
      player.play(song("b"));
      el().currentTime = 1;

      player.prev();

      expect(player.getState().current?.id).toBe("a");
      expect(player.getState().queue.map((q) => q.id)).toEqual(["b"]);
      expect(player.getState().history).toEqual([]);
    });

    it("restarts the first track when there is nothing behind it", async () => {
      const { player } = await load();
      player.play(song("a"));
      el().currentTime = 1;
      el().src = "";

      player.prev();

      expect(player.getState().current?.id).toBe("a");
      expect(el().currentTime).toBe(0);
      expect(el().src).toBe(""); // not reloaded — same track, just rewound
    });
  });

  describe("seek", () => {
    it("moves to the requested position and reflects it immediately", async () => {
      const { player } = await load();
      player.play(song("a", 200_000));
      el().duration = 200;

      player.seek(90_000);

      expect(el().currentTime).toBe(90);
      expect(player.getState().positionMs).toBe(90_000);
    });

    it("clamps a seek past either end of the track", async () => {
      const { player } = await load();
      player.play(song("a", 200_000));
      el().duration = 200;

      player.seek(-5_000);
      expect(el().currentTime).toBe(0);

      player.seek(9_999_999);
      expect(el().currentTime).toBe(200);
      expect(player.getState().positionMs).toBe(200_000);
    });

    it("does nothing while the duration is still unknown", async () => {
      // Scrubbing a stream before metadata arrives would otherwise seek to NaN.
      const { player } = await load();
      player.play(song("a"));
      el().duration = 0;
      el().currentTime = 4;

      player.seek(60_000);

      expect(el().currentTime).toBe(4);
    });

    it("does nothing when the duration is not finite (a live stream)", async () => {
      const { player } = await load();
      player.play(song("a"));
      el().duration = Infinity;
      el().currentTime = 4;

      player.seek(60_000);

      expect(el().currentTime).toBe(4);
    });
  });

  describe("remove", () => {
    it("drops a queued song and leaves playback alone", async () => {
      const { player } = await load();
      player.play(song("a"), [song("b"), song("c")]);

      player.remove("b");

      expect(player.getState().current?.id).toBe("a");
      expect(player.getState().queue.map((q) => q.id)).toEqual(["c"]);
      expect(el().pause).not.toHaveBeenCalled();
    });

    it("stops and wipes the OS widget when the playing song is deleted", async () => {
      const { player } = await load();
      player.play(song("a"), [song("b")]);

      player.remove("a");

      expect(player.getState().current).toBeNull();
      expect(el().pause).toHaveBeenCalled();
      expect(env.mediaSession.metadata).toBeNull();
      expect(env.mediaSession.playbackState).toBe("none");
    });
  });

  it("reflects a tag edit live without touching playback", async () => {
    const { player } = await load();
    player.play(song("a", 200_000), [song("a", 200_000)]);
    el().play.mockClear();
    const edited = { ...song("a", 200_000), title: "Renamed" } as Song;

    player.patchSong(edited);

    expect(player.getState().current?.title).toBe("Renamed");
    expect(player.getState().queue[0].title).toBe("Renamed");
    expect(el().play).not.toHaveBeenCalled(); // audio keeps running
    expect((env.mediaSession.metadata as { title: string }).title).toBe(
      "Renamed",
    );
  });

  it("patching an unrelated song leaves the OS widget as it was", async () => {
    const { player } = await load();
    player.play(song("a"));
    const before = env.mediaSession.metadata;

    player.patchSong({ ...song("z"), title: "Z" } as Song);

    expect(env.mediaSession.metadata).toBe(before);
  });
});

// The lock screen / macOS Now Playing widget. Getting this wrong is user-visible
// in a way no on-screen test catches: a stale track lingering with dead controls,
// or a headphone tap acting on a button the UI has greyed out.
describe("player OS media session", () => {
  let env: ReturnType<typeof stubEnvironment>;

  beforeEach(() => {
    vi.resetModules();
    env = stubEnvironment();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("publishes title, artist, album and both artwork sizes", async () => {
    const { player } = await import("./player");

    player.play({
      ...song("a"),
      title: "Song",
      artistName: "Band",
      album: "LP",
      coverArtId: "cov",
    } as Song);

    const md = env.mediaSession.metadata as {
      title: string;
      artist: string;
      album: string;
      artwork: Array<{ src: string; sizes: string }>;
    };
    expect(md.title).toBe("Song");
    expect(md.artist).toBe("Band");
    expect(md.album).toBe("LP");
    expect(md.artwork.map((a) => a.sizes)).toEqual(["480x480", "160x160"]);
    expect(md.artwork[0].src).toContain("cov");
  });

  it("publishes no artwork for a song without a cover", async () => {
    const { player } = await import("./player");

    player.play({ ...song("a"), coverArtId: "", album: "" } as Song);

    expect(
      (env.mediaSession.metadata as { artwork: unknown[] }).artwork,
    ).toEqual([]);
  });

  it("mirrors playing and paused onto the widget", async () => {
    const { player } = await import("./player");
    player.play(song("a"));

    el().fire("play");
    expect(env.mediaSession.playbackState).toBe("playing");

    el().fire("pause");
    expect(env.mediaSession.playbackState).toBe("paused");
  });

  it("reports nothing playing when a pause lands after the player closed", async () => {
    // pause() queues its event asynchronously, so it arrives after stop() has torn
    // the player down — reporting "paused" then resurrects a finished track.
    const { player } = await import("./player");
    player.play(song("a"));
    player.stop();

    el().fire("pause");

    expect(env.mediaSession.playbackState).toBe("none");
  });

  it("acts on an OS play only when actually paused", async () => {
    const { player } = await import("./player");
    player.play(song("a"));
    el().paused = false;
    el().pause.mockClear();

    env.mediaSession.handlers["play"]?.(); // redundant — Continuity relaying from another device
    expect(el().pause).not.toHaveBeenCalled();

    el().paused = true;
    el().play.mockClear();
    env.mediaSession.handlers["play"]?.();
    expect(el().play).toHaveBeenCalled();
  });

  it("acts on an OS pause only when actually playing", async () => {
    const { player } = await import("./player");
    player.play(song("a"));
    el().paused = true;
    el().pause.mockClear();

    env.mediaSession.handlers["pause"]?.();
    expect(el().pause).not.toHaveBeenCalled();

    el().paused = false;
    env.mediaSession.handlers["pause"]?.();
    expect(el().pause).toHaveBeenCalled();
  });

  it("wires the OS previous button to the transport", async () => {
    const { player } = await import("./player");
    player.play(song("a"));
    player.play(song("b"));
    el().currentTime = 0.5;

    env.mediaSession.handlers["previoustrack"]?.();

    expect(player.getState().current?.id).toBe("a");
  });

  it("greys out the OS next button exactly when the queue is empty", async () => {
    // A null handler is how you tell the platform an action is unavailable —
    // without it an AirPods double-tap would close the player from behind a
    // disabled on-screen button.
    const { player } = await import("./player");

    player.play(song("a"), [song("b")]);
    expect(typeof env.mediaSession.handlers["nexttrack"]).toBe("function");

    player.next(); // queue drained
    expect(env.mediaSession.handlers["nexttrack"]).toBeNull();

    player.setQueue([song("c")]);
    expect(typeof env.mediaSession.handlers["nexttrack"]).toBe("function");
    env.mediaSession.handlers["nexttrack"]?.();
    expect(player.getState().current?.id).toBe("c");
  });

  it("publishes the position so the widget scrubber tracks playback", async () => {
    const { player } = await import("./player");
    player.play(song("a", 200_000));
    el().duration = 200;

    el().fire("loadedmetadata");
    el().currentTime = 30;
    el().fire("timeupdate");

    expect(env.mediaSession.setPositionState).toHaveBeenCalledWith({
      duration: 200,
      position: 30,
      playbackRate: 1,
    });
  });

  it("skips the position update while the duration is unknown", async () => {
    const { player } = await import("./player");
    player.play(song("a"));
    el().duration = 0;

    el().fire("timeupdate");

    expect(env.mediaSession.setPositionState).not.toHaveBeenCalled();
  });

  it("survives an engine that rejects the calls it advertises", async () => {
    // Some engines throw from setPositionState mid-seek and from setActionHandler
    // for actions they do not support. Neither may break playback.
    env.mediaSession.setActionHandler = () => {
      throw new Error("unsupported action");
    };
    env.mediaSession.setPositionState = vi.fn(() => {
      throw new Error("rejected");
    });
    const { player } = await import("./player");

    expect(() => player.play(song("a", 200_000))).not.toThrow();
    el().duration = 200;
    expect(() => el().fire("timeupdate")).not.toThrow();
    expect(player.getState().current?.id).toBe("a");
  });

  it("does nothing at all where there is no media session", async () => {
    vi.stubGlobal("navigator", {});
    const { player } = await import("./player");

    expect(() => {
      player.play(song("a"));
      player.stop();
    }).not.toThrow();
  });
});

// AirPlay is Safari-only; the button appears when a target shows up on the network
// and highlights while audio is actually routed to it.
describe("player AirPlay", () => {
  beforeEach(() => {
    vi.resetModules();
    stubEnvironment();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the button only once a target is on the network", async () => {
    const { player } = await import("./player");
    player.play(song("a"));
    expect(player.getState().airplayAvailable).toBe(false);

    el().fireWith("webkitplaybacktargetavailabilitychanged", {
      availability: "available",
    });
    expect(player.getState().airplayAvailable).toBe(true);

    el().fireWith("webkitplaybacktargetavailabilitychanged", {
      availability: "not-available",
    });
    expect(player.getState().airplayAvailable).toBe(false);
  });

  it("highlights the button while audio is routed to a wireless device", async () => {
    const { player } = await import("./player");
    player.play(song("a"));

    el().webkitCurrentPlaybackTargetIsWireless = true;
    el().fire("webkitcurrentplaybacktargetiswirelesschanged");
    expect(player.getState().airplayActive).toBe(true);

    el().webkitCurrentPlaybackTargetIsWireless = false;
    el().fire("webkitcurrentplaybacktargetiswirelesschanged");
    expect(player.getState().airplayActive).toBe(false);
  });

  it("opens Safari's native device chooser", async () => {
    const { player } = await import("./player");
    player.play(song("a"));

    player.showAirplayPicker();

    expect(el().webkitShowPlaybackTargetPicker).toHaveBeenCalled();
  });

  it("is inert on engines without the WebKit API", async () => {
    vi.stubGlobal("Audio", MockAudio); // no webkit picker
    const { player } = await import("./player");
    player.play(song("a"));

    expect(() => player.showAirplayPicker()).not.toThrow();
    expect(player.getState().airplayAvailable).toBe(false);
  });
});

describe("readSnapshot / clearSnapshot", () => {
  let env: ReturnType<typeof stubEnvironment>;
  const KEY = "music.player.v1";

  beforeEach(() => {
    vi.resetModules();
    env = stubEnvironment();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns the saved track and position", async () => {
    env.store.set(KEY, JSON.stringify({ id: "a", positionMs: 42_000 }));
    const { readSnapshot } = await import("./player");

    expect(readSnapshot()).toEqual({ id: "a", positionMs: 42_000 });
  });

  it("returns nothing when there is no snapshot", async () => {
    const { readSnapshot } = await import("./player");

    expect(readSnapshot()).toBeNull();
  });

  it("ignores a corrupt or unusable snapshot rather than restoring nonsense", async () => {
    const { readSnapshot } = await import("./player");

    for (const raw of [
      "not json",
      "null",
      '{"id":5,"positionMs":1}',
      '{"id":"a"}',
      '{"id":"a","positionMs":-1}',
      '{"id":"a","positionMs":"x"}',
    ]) {
      env.store.set(KEY, raw);
      expect(readSnapshot()).toBeNull();
    }
  });

  it("survives storage being unavailable (private mode)", async () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("SecurityError");
        },
        removeItem: () => {
          throw new Error("SecurityError");
        },
      },
      addEventListener: () => {},
    });
    const { readSnapshot, clearSnapshot } = await import("./player");

    expect(readSnapshot()).toBeNull();
    expect(() => clearSnapshot()).not.toThrow();
  });

  it("clears the snapshot so a stale track is not restored", async () => {
    env.store.set(KEY, JSON.stringify({ id: "a", positionMs: 1 }));
    const { clearSnapshot, readSnapshot } = await import("./player");

    clearSnapshot();

    expect(readSnapshot()).toBeNull();
  });
});

// usePlayer is what every component sees: a snapshot that re-renders on change,
// with the transport bound alongside it.
describe("usePlayer", () => {
  beforeEach(() => {
    vi.resetModules();
    stubEnvironment();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("re-renders with the current snapshot as playback changes, and unsubscribes on unmount", async () => {
    const { player, usePlayer } = await import("./player");
    const view = renderHook(() => usePlayer());

    expect(view.result().current).toBeNull();

    player.play(song("a", 200_000), [song("b")]);
    expect(view.result().current?.id).toBe("a");
    expect(view.result().queue.map((q) => q.id)).toEqual(["b"]);
    expect(view.result().durationMs).toBe(200_000);

    // The transport comes bound, so a component never reaches for the singleton.
    view.result().next();
    expect(view.result().current?.id).toBe("b");

    view.unmount();
    player.stop();
    expect(view.result().current?.id).toBe("b"); // stale — no longer subscribed
  });
});
