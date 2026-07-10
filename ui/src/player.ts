import { useEffect, useState } from "react";
import { streamUrl, reportPlay, type Song } from "./api";
import { coverUrl } from "./cover";
import { saveResume, loadResume, type ResumeState } from "./resume";

export type PlayerState = {
  current: Song | null;
  queue: Song[];
  history: Song[];
  playing: boolean;
  positionMs: number;
  durationMs: number;
};

// ── Pure transitions (unit-tested) ─────────────────────────────────────────

// advance moves the queue head to current, pushing the outgoing current onto
// history (so prev can return to it). With an empty queue it stops instead.
export function advance(state: PlayerState): PlayerState {
  if (state.queue.length === 0) {
    return { ...state, playing: false };
  }
  const [next, ...rest] = state.queue;
  const history = state.current ? [...state.history, state.current] : state.history;
  return { ...state, current: next, queue: rest, history, positionMs: 0 };
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

// qualifiesForPlay decides when a listen counts: >=30s, OR >=50% of the track
// for short songs (spec §9). Avoids skip-inflation.
export function qualifiesForPlay(positionMs: number, durationMs: number): boolean {
  if (positionMs >= 30000) return true;
  return durationMs > 0 && positionMs >= durationMs / 2;
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
  saveResume(resumeStore(), { songId, positionMs } satisfies ResumeState);
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
  persist(state.current.id, positionMs);
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
  if (autoplay) void el.play().catch(() => {});
}

export const player = {
  getState(): PlayerState {
    return state;
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
  toggle() {
    if (!state.current) return;
    const el = getAudio();
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  },
  next() {
    const before = state.current?.id;
    state = advance(state);
    emit();
    if (state.current?.id !== before) loadCurrent(true);
    else {
      // queue empty — advance stopped playback; reflect it on the element
      getAudio().pause();
    }
  },
  prev() {
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
  // restore seeds the last track + position WITHOUT autoplay (spec §15a: no
  // surprise autoplay). Playback resumes from the restored position on the next
  // explicit play/toggle.
  restore(songs: Song[]) {
    if (state.current) return; // already playing something
    const saved = loadResume(resumeStore());
    if (!saved) return;
    const song = songs.find((s) => s.id === saved.songId);
    if (!song) return;
    set({ current: song, positionMs: saved.positionMs, durationMs: song.durationMs || 0, playing: false });
    // A resumed listen must not re-count: if the restored position already
    // qualifies, treat this session as already reported. Resuming below the
    // threshold still counts once it is later crossed (a genuine first play).
    session = { reported: qualifiesForPlay(saved.positionMs, song.durationMs || 0) };
    pendingSeekMs = saved.positionMs;
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
    next: player.next,
    prev: player.prev,
    seek: player.seek,
    setQueue: player.setQueue,
    restore: player.restore,
  };
}
