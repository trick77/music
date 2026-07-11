# Karaoke / synced-lyrics roadmap

The multi-phase plan to take the app from "lyrics as text" to "highlight exactly
what's being sung, in time with the audio." Each phase is independently shippable
and has (or will have) its own design spec under `docs/superpowers/specs/`.

| Phase | Status | What it delivers |
|-------|--------|------------------|
| **1 — Lyrics field** | ✅ Done (PR #48) | A Lyrics box + Clean button in the tag editor. Reads/writes the ID3 `USLT` frame; auto-strips Suno `[Verse]`/`[Chorus]` directives on import. Stores the words — the prerequisite for everything below. |
| **2 — Alignment engine** | 🔨 In review (PR #52) | Generate + store **word-level timings** (`{word, start, end}`) for a song from its stored lyrics + audio. Self-hosted alignment **sidecar** (WhisperX + Demucs vocal isolation); Go calls it submit→poll→store, fanart-style async status. No visible player yet. Spec: `docs/superpowers/specs/2026-07-11-karaoke-alignment-engine-design.md`. |
| **3 — Highlighting player** | 📋 Planned | Front-end karaoke view: on each audio tick, highlight the active word/line from the stored timings; optional per-word gradient "wipe." Enhanced-LRC (`.lrc`) export of the timings. |
| **4 — Correction editor** | 📋 Planned | UI to hand-nudge mis-timed words (sung vocals never align perfectly). Tap-to-retime, shift a line, re-run a single stanza. |

## Design principles carried across phases

- **Known lyrics, always.** The user always has the full lyrics, so alignment is a
  *forced-alignment* problem (map known words → audio), never transcription. This is
  why the sidecar feeds WhisperX the real lyrics instead of using its ASR output.
- **Keep the Go image minimal.** All Python/ML lives in the sidecar; the main app
  stays a static Go binary and only ever speaks HTTP to the aligner.
- **Reuse existing patterns.** Async work = detached goroutine + `generating/ready/
  failed` DB status + boot reaper (the fanart pattern). External calls = `BACKEND_*`
  env config gated by key presence (the BFL pattern).
