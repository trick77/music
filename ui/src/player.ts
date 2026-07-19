import { useEffect, useState } from "react";
import { streamUrl, reportPlay, type Song } from "./api";
import { coverUrl } from "./cover";

export type PlayerState = {
  current: Song | null;
  queue: Song[];
  history: Song[];
  playing: boolean;
  positionMs: number;
  durationMs: number;
  // AirPlay (Safari on Apple devices only). airplayAvailable flips true when a
  // target appears on the network; airplayActive tracks whether audio is
  // currently routed to a wireless device. Both stay false everywhere else.
  airplayAvailable: boolean;
  airplayActive: boolean;
};

// ── Pure transitions (unit-tested) ─────────────────────────────────────────

// advance moves the queue head to current, pushing the outgoing current onto
// history (so prev can return to it). With an empty queue it stops instead —
// kept so the transition stays total, but note that end-of-queue no longer comes
// through here: next() short-circuits to stop() (closing the player) before it
// would ever call advance() on an empty queue.
export function advance(state: PlayerState): PlayerState {
  if (state.queue.length === 0) {
    return { ...state, playing: false, positionMs: 0 };
  }
  const [next, ...rest] = state.queue;
  const history = state.current ? [...state.history, state.current] : state.history;
  return { ...state, current: next, queue: rest, history, positionMs: 0 };
}

// removeSong drops a song (e.g. one that was deleted) from the player. If it is
// the current track, playback stops and current clears; otherwise it is just
// filtered out of the queue and history.
export function removeSong(state: PlayerState, id: string): PlayerState {
  const queue = state.queue.filter((s) => s.id !== id);
  const history = state.history.filter((s) => s.id !== id);
  if (state.current?.id === id) {
    return { ...state, current: null, queue, history, playing: false, positionMs: 0, durationMs: 0 };
  }
  return { ...state, queue, history };
}

// replaceSong swaps an edited song in wherever its id appears (current, queue,
// history), leaving playback position/state untouched — a tag edit changes the
// metadata shown, not what is playing.
export function replaceSong(state: PlayerState, saved: Song): PlayerState {
  const swap = (s: Song) => (s.id === saved.id ? saved : s);
  return {
    ...state,
    current: state.current ? swap(state.current) : state.current,
    queue: state.queue.map(swap),
    history: state.history.map(swap),
  };
}

// back pops history into current, pushing the outgoing current to the front of
// the queue. With empty history it restarts the current track.
export function back(state: PlayerState): PlayerState {
  if (state.history.length === 0) {
    return { ...state, positionMs: 0 };
  }
  const prev = state.history[state.history.length - 1];
  const history = state.history.slice(0, -1);
  const queue = state.current ? [state.current, ...state.queue] : state.queue;
  return { ...state, current: prev, history, queue, positionMs: 0 };
}

// shouldRestart decides the "previous" button behaviour: if we're more than a
// few seconds into the current track, a press restarts it (returns true) rather
// than stepping back to the previous song. Only a second press — now near the
// start — actually goes back. Threshold in ms.
export function shouldRestart(positionMs: number, thresholdMs = 3000): boolean {
  return positionMs > thresholdMs;
}

// qualifiesForPlay decides when a listen counts: >=30s, OR >=50% of the track
// for short songs (spec §9). Avoids skip-inflation.
export function qualifiesForPlay(positionMs: number, durationMs: number): boolean {
  if (positionMs >= 30000) return true;
  return durationMs > 0 && positionMs >= durationMs / 2;
}

// shuffle returns a new array with items in random order (Fisher–Yates) without
// mutating the input. Pure function suitable for unit testing.
export function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// shouldReport fires at most once per play session. It flips session.reported so
// a single listen can never inflate the chart, even across many timeupdate ticks.
export function shouldReport(session: { reported: boolean }, qualifies: boolean): boolean {
  if (qualifies && !session.reported) {
    session.reported = true;
    return true;
  }
  return false;
}

// ── Side-effecting singleton (exercised via Playwright, not unit tests) ─────

type Listener = () => void;

let state: PlayerState = {
  current: null,
  queue: [],
  history: [],
  playing: false,
  positionMs: 0,
  durationMs: 0,
  airplayAvailable: false,
  airplayActive: false,
};
const listeners = new Set<Listener>();
let audio: HTMLAudioElement | null = null;
let session = { reported: false };

function emit() {
  syncNextAction(); // keep the OS "next track" control in step with the queue
  for (const l of listeners) l();
}

function set(patch: Partial<PlayerState>) {
  state = { ...state, ...patch };
  emit();
}

function hasMediaSession(): boolean {
  return typeof navigator !== "undefined" && "mediaSession" in navigator;
}

function setMediaMetadata(song: Song) {
  if (!hasMediaSession() || typeof MediaMetadata === "undefined") return;
  const artwork = song.coverArtId
    ? [
        { src: coverUrl(song.coverArtId, "card"), sizes: "480x480", type: "image/jpeg" },
        { src: coverUrl(song.coverArtId, "thumb"), sizes: "160x160", type: "image/jpeg" },
      ]
    : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: song.title,
    artist: song.artistName,
    album: song.album || "",
    artwork,
  });
}

function setPlaybackState(s: "playing" | "paused" | "none") {
  if (hasMediaSession()) navigator.mediaSession.playbackState = s;
}

// clearMediaSession wipes the OS Now Playing widget (lock screen, macOS control
// centre). Without it a forgotten track lingers there with controls that no-op
// against a null current. Every path that clears `current` must call this.
function clearMediaSession() {
  if (!hasMediaSession()) return;
  guardMedia(() => (navigator.mediaSession.metadata = null));
  setPlaybackState("none");
}

function updatePositionState() {
  if (!hasMediaSession() || !audio) return;
  const d = audio.duration;
  if (!d || !isFinite(d)) return;
  try {
    navigator.mediaSession.setPositionState({ duration: d, position: audio.currentTime, playbackRate: audio.playbackRate });
  } catch {
    // some engines reject setPositionState mid-seek — non-fatal
  }
}

function guardMedia(fn: () => void) {
  try {
    fn();
  } catch {
    // unsupported action — ignore
  }
}

// An OS Media Session "play"/"pause" command (lock screen, AirPods, macOS Now
// Playing — and, crucially, Apple Continuity relaying a command from another
// device signed into the same account) must be idempotent about direction:
// "play" while already playing, or "pause" while already paused, must do nothing.
// Wiring both actions to a blind toggle() inverted the state instead — an OS
// "play" arriving at an already-playing tab paused it — which is how two open
// tabs on two devices fell out of phase. Gate the toggle on the audio element's
// own paused truth so a redundant command is a no-op, not a flip.
export function mediaShouldToggle(action: "play" | "pause", paused: boolean): boolean {
  return action === "play" ? paused : !paused;
}

function setupMediaHandlers() {
  if (!hasMediaSession()) return;
  const ms = navigator.mediaSession;
  guardMedia(() => ms.setActionHandler("play", () => { if (audio && mediaShouldToggle("play", audio.paused)) player.toggle(); }));
  guardMedia(() => ms.setActionHandler("pause", () => { if (audio && mediaShouldToggle("pause", audio.paused)) player.toggle(); }));
  guardMedia(() => ms.setActionHandler("previoustrack", () => player.prev()));
  syncNextAction();
}

// syncNextAction mirrors the greyed-out Next button onto the OS media controls
// (AirPods double-tap, the macOS Now Playing widget, lock screen). A null handler
// is how you tell the platform an action is unavailable, so the system greys out
// its own Next too — otherwise a headphone tap would still close the player from
// behind a disabled on-screen button. Driven from emit() so it can never drift out
// of sync with the queue; lastNextAction keeps a 4x/second timeupdate from
// re-registering the handler on every tick.
let lastNextAction: boolean | null = null;
function syncNextAction() {
  if (!hasMediaSession()) return;
  const canNext = state.queue.length > 0;
  if (canNext === lastNextAction) return;
  lastNextAction = canNext;
  guardMedia(() => navigator.mediaSession.setActionHandler("nexttrack", canNext ? () => player.next() : null));
}

function getAudio(): HTMLAudioElement {
  if (audio) return audio;
  const el = new Audio();
  el.preload = "metadata";
  el.addEventListener("timeupdate", onTimeUpdate);
  el.addEventListener("loadedmetadata", () => {
    set({ durationMs: (el.duration || 0) * 1000 });
    updatePositionState();
  });
  el.addEventListener("ended", () => player.next());
  el.addEventListener("play", () => {
    set({ playing: true });
    setPlaybackState("playing");
  });
  el.addEventListener("pause", () => {
    set({ playing: false });
    // pause() on a playing element queues this event asynchronously, so it lands
    // *after* stop() has already torn the player down — reporting "paused" then
    // would resurrect the finished track on the OS widget. With no current track
    // there is nothing paused, only nothing playing.
    setPlaybackState(state.current ? "paused" : "none");
  });
  // AirPlay wiring, Safari-only. Feature-detect the picker; if it exists we can
  // trust the companion events fire, so we listen for target availability (to
  // show/hide the button) and for the active wireless route (to highlight it).
  if (typeof el.webkitShowPlaybackTargetPicker === "function") {
    el.addEventListener("webkitplaybacktargetavailabilitychanged", (e) => {
      set({ airplayAvailable: e.availability === "available" });
    });
    el.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", () => {
      set({ airplayActive: el.webkitCurrentPlaybackTargetIsWireless === true });
    });
  }
  setupMediaHandlers();
  audio = el;
  return el;
}

function onTimeUpdate() {
  if (!audio || !state.current) return;
  const positionMs = audio.currentTime * 1000;
  set({ positionMs });
  if (shouldReport(session, qualifiesForPlay(positionMs, state.durationMs))) {
    void reportPlay(state.current.id);
  }
  updatePositionState();
}

// loadCurrent points the audio element at state.current and (optionally) plays.
function loadCurrent(autoplay: boolean) {
  if (!state.current) return;
  session = { reported: false };
  const el = getAudio();
  el.src = streamUrl(state.current.id);
  el.currentTime = 0;
  setMediaMetadata(state.current);
  // Deliberately does NOT tap the element into the analyser graph. See toggle().
  if (autoplay) {
    void el.play().catch(() => {});
  }
}

export const player = {
  getState(): PlayerState {
    return state;
  },
  // getAudioElement exposes the live <audio> for the karaoke view's own rAF loop,
  // which reads currentTime at 60fps — far finer than the throttled positionMs.
  getAudioElement(): HTMLAudioElement | null {
    return audio;
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  play(song: Song, upNext: Song[] = []) {
    const history = state.current && state.current.id !== song.id ? [...state.history, state.current] : state.history;
    set({ current: song, queue: upNext, history, positionMs: 0, durationMs: song.durationMs || 0 });
    loadCurrent(true);
  },
  setQueue(queue: Song[]) {
    set({ queue });
  },
  remove(id: string) {
    const wasCurrent = state.current?.id === id;
    state = removeSong(state, id);
    // removeSong clears current when the deleted song was playing, so the OS
    // widget has to go with it — same reasoning as stop().
    if (wasCurrent) {
      getAudio().pause();
      clearMediaSession();
    }
    emit();
  },
  // patchSong swaps in an edited song wherever it appears (current/queue/history)
  // so a tag edit is reflected live. It deliberately does NOT reload the audio
  // element — playback continues uninterrupted; only the metadata shown changes.
  patchSong(saved: Song) {
    const wasCurrent = state.current?.id === saved.id;
    state = replaceSong(state, saved);
    if (wasCurrent) setMediaMetadata(saved);
    emit();
  },
  toggle() {
    if (!state.current) return;
    const el = getAudio();
    if (el.paused) {
      // Do NOT tap the element into the Web Audio graph here. createMediaElementSource()
      // pulls the <audio> out of the browser's normal output path; WebKit then interrupts
      // the AudioContext when an iPhone locks, so playback goes silent on the lock screen
      // (currentTime keeps advancing, sound returns on unlock). Only VisualizerView taps,
      // and only once actually opened. Priming here (f3e42be) fixed a cosmetic first-open
      // equalizer stutter at the cost of lock-screen audio for everyone — a bad trade.
      void el.play().catch(() => {});
    } else el.pause();
  },
  // stop is the user-facing "close the player": halt audio and forget the track.
  // The dock self-unmounts once current is null (PlayerBar's `if (!p.current)
  // return null`).
  stop() {
    if (!state.current) return;
    getAudio().pause();
    clearMediaSession(); // matters more now that stop() also runs when the last song ends
    set({ current: null, queue: [], history: [], playing: false, positionMs: 0, durationMs: 0 });
  },
  next() {
    // Advancing past the end closes the player. The `ended` listener and the Next
    // control funnel through here, so finishing the last song tidies the dock away
    // instead of parking it at 0:00. The UI greys Next out when the queue is empty
    // (Transport's canNext), so a deliberate press can't reach this — `ended` is the
    // real caller.
    if (state.queue.length === 0) {
      player.stop();
      return;
    }
    state = advance(state);
    emit();
    loadCurrent(true);
  },
  prev() {
    // Standard media-player "back": more than a few seconds into the track, the
    // first press restarts it; only a second press (now near the start) steps
    // back to the previous song. Avoids losing your place on an accidental tap.
    const el = getAudio();
    if (state.current && shouldRestart(el.currentTime * 1000)) {
      el.currentTime = 0;
      set({ positionMs: 0 });
      return;
    }
    const before = state.current?.id;
    state = back(state);
    emit();
    if (state.current?.id !== before) loadCurrent(true);
    else getAudio().currentTime = 0;
  },
  seek(ms: number) {
    const el = getAudio();
    if (el.duration && isFinite(el.duration)) {
      el.currentTime = Math.max(0, Math.min(ms, el.duration * 1000)) / 1000;
      set({ positionMs: el.currentTime * 1000 });
    }
  },
  // showAirplayPicker opens Safari's native AirPlay device chooser. No-op where
  // the WebKit API is absent (non-Safari); the button is hidden there anyway.
  showAirplayPicker() {
    getAudio().webkitShowPlaybackTargetPicker?.();
  },
};

// usePlayer subscribes a component to the player singleton.
export function usePlayer() {
  const [snap, setSnap] = useState<PlayerState>(() => player.getState());
  useEffect(() => {
    const unsub = player.subscribe(() => setSnap(player.getState()));
    setSnap(player.getState());
    return unsub;
  }, []);
  return {
    ...snap,
    play: player.play,
    toggle: player.toggle,
    stop: player.stop,
    next: player.next,
    prev: player.prev,
    seek: player.seek,
    setQueue: player.setQueue,
    remove: player.remove,
    patchSong: player.patchSong,
    showAirplayPicker: player.showAirplayPicker,
  };
}
