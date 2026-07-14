import { useEffect, useState } from "react";
import { streamUrl, reportPlay, type Song } from "./api";
import { coverUrl } from "./cover";
import { saveResume, loadResume, clearResume, isResumeFresh, type ResumeState } from "./resume";
import { prime } from "./analyser";

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
// history (so prev can return to it). With an empty queue it stops instead.
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
let pendingSeekMs = 0;
let lastPersist = 0;

function emit() {
  for (const l of listeners) l();
}

function set(patch: Partial<PlayerState>) {
  state = { ...state, ...patch };
  emit();
}

function resumeStore() {
  return window.localStorage;
}

function persist(songId: string, positionMs: number) {
  const now = Date.now();
  if (now - lastPersist < 4000) return; // throttle disk writes
  lastPersist = now;
  saveResume(resumeStore(), { songId, positionMs, reported: session.reported, savedAt: now } satisfies ResumeState);
}

// persistNow writes resume state immediately, bypassing the throttle. Used the
// instant a play is reported so the saved `reported` flag can't lag behind a
// tab close and let a resumed listen re-count (spec §9 integrity).
function persistNow(songId: string, positionMs: number) {
  const now = Date.now();
  lastPersist = now;
  saveResume(resumeStore(), { songId, positionMs, reported: session.reported, savedAt: now } satisfies ResumeState);
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

function setupMediaHandlers() {
  if (!hasMediaSession()) return;
  const ms = navigator.mediaSession;
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch {
      // unsupported action — ignore
    }
  };
  guard(() => ms.setActionHandler("play", () => player.toggle()));
  guard(() => ms.setActionHandler("pause", () => player.toggle()));
  guard(() => ms.setActionHandler("nexttrack", () => player.next()));
  guard(() => ms.setActionHandler("previoustrack", () => player.prev()));
}

function getAudio(): HTMLAudioElement {
  if (audio) return audio;
  const el = new Audio();
  el.preload = "metadata";
  el.addEventListener("timeupdate", onTimeUpdate);
  el.addEventListener("loadedmetadata", () => {
    set({ durationMs: (el.duration || 0) * 1000 });
    if (pendingSeekMs > 0) {
      el.currentTime = pendingSeekMs / 1000;
      pendingSeekMs = 0;
    }
    updatePositionState();
  });
  el.addEventListener("ended", () => player.next());
  el.addEventListener("play", () => {
    set({ playing: true });
    setPlaybackState("playing");
  });
  el.addEventListener("pause", () => {
    set({ playing: false });
    setPlaybackState("paused");
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
    persistNow(state.current.id, positionMs); // save reported=true at once, no throttle lag
  } else {
    persist(state.current.id, positionMs);
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
  // Tap the element into the analyser graph BEFORE it plays: rerouting a paused
  // element is seamless, rerouting a playing one glitches (the first-open
  // equalizer stutter). Idempotent, so this only does real work on first play.
  if (autoplay) {
    prime(el);
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
    if (wasCurrent) getAudio().pause();
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
      prime(el); // tap before playback resumes — before el.play() (see loadCurrent)
      void el.play().catch(() => {});
    } else el.pause();
  },
  // stop is the user-facing "close the player": halt audio, forget the track, and
  // wipe the resume state so restore() won't reseed it on the next load. The dock
  // self-unmounts once current is null (PlayerBar's `if (!p.current) return null`).
  stop() {
    if (!state.current) return;
    getAudio().pause();
    clearResume(resumeStore());
    set({ current: null, queue: [], history: [], playing: false, positionMs: 0, durationMs: 0 });
  },
  next() {
    const before = state.current?.id;
    state = advance(state);
    emit();
    if (state.current?.id !== before) loadCurrent(true);
    else {
      // queue empty — advance stopped playback and reset positionMs to 0; reset
      // the element to the start too so the paused track is cued to replay from 0.
      const el = getAudio();
      el.pause();
      el.currentTime = 0;
    }
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
  // restore seeds the last track WITHOUT autoplay (spec §15a: no surprise
  // autoplay). The saved position is only resumed within RESUME_WINDOW_MS of the
  // last activity (accidental close / short break); after a longer gap the track
  // loads at 0:00 so you don't reopen parked mid-song. Playback resumes from the
  // restored position on the next explicit play/toggle.
  restore(songs: Song[]) {
    if (state.current) return; // already playing something
    const saved = loadResume(resumeStore());
    if (!saved) return;
    const song = songs.find((s) => s.id === saved.songId);
    if (!song) return;
    const resumeMs = isResumeFresh(saved, Date.now()) ? saved.positionMs : 0;
    set({ current: song, positionMs: resumeMs, durationMs: song.durationMs || 0, playing: false });
    // A resumed listen must not re-count. Prefer the persisted `reported` flag
    // (written the instant the play was counted); fall back to the position
    // check for older saved state. Resuming an unreported, sub-threshold
    // position still counts once the threshold is later crossed (a real play).
    session = { reported: saved.reported ?? qualifiesForPlay(saved.positionMs, song.durationMs || 0) };
    pendingSeekMs = resumeMs; // 0 when stale → loadedmetadata handler won't seek
    const el = getAudio();
    el.src = streamUrl(song.id);
    setMediaMetadata(song);
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
    restore: player.restore,
    remove: player.remove,
    patchSong: player.patchSong,
    showAirplayPicker: player.showAirplayPicker,
  };
}
