# Karaoke alignment

How the app turns a song's stored lyrics into word-level timestamps, and drives
the synced-highlight player from them. Covers the sidecar, the Go backend
pipeline, the frontend renderer, and SYLT export.

## Overview

```
[Generate clicked / lyrics saved / song imported]
              │
              ▼
   enqueueAlignment (claims song_alignment row, status=generating)
              │
              ▼
   single serial worker (alignWorker) ── one alignment job at a time, system-wide
              │
              ▼
   POST {audio, lyrics} to the align sidecar (Python/FastAPI)
              │
              ├─ Demucs: isolate vocal stem
              ├─ WhisperX: force-align the KNOWN lyric words (not ASR) to the vocal stem
              └─ regroup the flat word list back into lines
              │
              ▼
   {engine, lines:[{text,start,end,words:[{w,start,end,conf}]}]}
              │
              ▼
   MarkAlignmentReady — JSON stored in song_alignment.data, status=ready
              │
              ▼
   frontend polls GET /api/songs/{id}/align every 2s while the lyrics view is open
              │
              ▼
   KaraokeView: 60fps requestAnimationFrame loop reads audio.currentTime,
   paints a per-word sweep highlight directly via DOM style (no React re-renders)
              │
              ▼
   (optional) MP3 download bakes the same timings into an ID3 SYLT frame
```

Karaoke requires two things at once: `BACKEND_ALIGN_URL` configured (a running
sidecar) and an authenticated user — anonymous listeners never see it, even if
the sidecar is up.

## The align sidecar (`sidecar/align/`)

A small FastAPI service, `app.py` + `grouping.py`, deployed as its own container
(`compose.yaml`'s `align` service, image `ghcr.io/trick77/music-align:latest`,
built from `sidecar/align/Containerfile`, `linux/amd64` only — some ML deps ship
no arm64 wheel). It has no state and no database; every request is independent.

**`GET /health`** → `{"status": "ok"}`.

**`POST /align`** — multipart form: `audio` (file), `lyrics` (text, required),
`language` (optional, default `"en"`). Returns `{engine, lines: [...]}` on
success, or `400`/`500` `{"error": "..."}`.

Pipeline per request (`app.py`):

1. **Vocal isolation.** Demucs (`htdemucs`, two-stem mode) separates vocals from
   the mix, giving a cleaner signal for alignment. If separation throws for any
   reason, the code falls back to the original full mix rather than failing the
   request — best-effort, never fatal.
2. **Forced alignment, not transcription.** This is the core trick: the song's
   *known* lyrics (the whole lyric text, lines joined with spaces) are fed to
   WhisperX's wav2vec2 alignment stage as one fabricated segment spanning
   `[0, duration]`. WhisperX's `align()` doesn't generate text — it force-aligns
   the given words against the audio timeline. Because the words are never
   produced by ASR, **wrong-word transcription can't happen** — only *timing* is
   inferred for words that are already known to be correct.
3. The align model is language-specific and loaded lazily, then cached per
   language in a module-level dict, so repeat requests in the same language
   reuse the already-loaded model instead of reloading it.
4. The result's flat, time-ordered word list (`word_segments`) is filtered to
   words that got a start/end, then mapped to `{w, start, end, conf}` (`conf` is
   wav2vec2's alignment confidence, 0–1).
5. **Regrouping into lines** (`grouping.py`): the flat word list is sliced back
   into the original lyric lines purely by each line's whitespace word count
   (`str.split()`). This is a documented known limitation: WhisperX's own
   tokenization can disagree with `str.split()` on apostrophes, hyphens,
   punctuation, or numbers, or it can drop a word it couldn't align at all. Any
   per-line count mismatch doesn't just affect one line — it *shifts every
   subsequent line's words by the delta*, so timings can drift silently for the
   rest of the song while the row still ends up marked `ready`. It cannot crash
   (trailing lines just get whatever remains, possibly empty), but it isn't
   self-correcting either. A robust fix would align WhisperX's tokens back to
   the source words instead of counting; this is deferred pending more real
   output to evaluate against.

Output shape per line: `{text, start, end, words: [{w, start, end, conf}]}` —
`start`/`end` are the first/last word's timestamps.

**Engine tag:** hardcoded `"whisperx+demucs"`, returned as `engine` and stored
verbatim in the DB.

**CPU/GPU:** `torch.cuda.is_available()` picks the device automatically. On
CPU, both the Python process (`torch.set_num_threads`) and the container's
`OMP_NUM_THREADS` env var (set in the `Containerfile`'s CMD) are pinned to
*all cores but one* — torch under-detects cores inside a container and can
otherwise pin itself to a single thread, but leaving one core in reserve keeps
the host responsive. No-op on GPU. GPU support (~10x faster per the compose
comment) is opt-in via a commented-out NVIDIA `deploy.resources.reservations`
block in `compose.yaml` — requires the NVIDIA container toolkit on the host.

To disable karaoke entirely: set `BACKEND_ALIGN_URL=""` on the `music` service
and don't run the `align` service at all.

## Go backend (`backend/internal/align/`, `backend/internal/httpapi/alignment.go`)

`internal/align` is a thin HTTP client with no ML of its own: `align.New(baseURL,
timeout)` builds a client; `(*Client).Align(ctx, audio, filename, lyrics)` streams
a multipart POST to `{baseURL}/align` and decodes the JSON response into
`Result{Engine string, Lines []Line}` (`Line{Text, Start, End, Words []Word}`,
`Word{W, Start, End, Conf float64}`).

### Storage

One row per song in `song_alignment` (`backend/internal/store/migrations/0003_song_alignment.sql`):

```sql
CREATE TABLE song_alignment (
    song_id    TEXT PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'generating' CHECK (status IN ('generating','ready','failed')),
    error      TEXT,       -- server-only failure reason, never sent to the client
    engine     TEXT,
    data       TEXT,       -- JSON: []Line, passed through to the client verbatim
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Re-running alignment replaces the row (`data`/`error`/`engine` are cleared on
re-claim). The DB only ever has three statuses: `generating`, `ready`, `failed`.
The frontend adds a fourth, purely client-side, pseudo-status — `needs` — for
"no row exists yet", which maps to the `404` the API returns for a
never-requested song.

### Single serial worker queue

Every trigger — the "Generate"/"Try again" button, saving changed lyrics in the
tag editor, and importing a file with embedded lyrics — funnels through one
function, `enqueueAlignment`. It:

1. Atomically claims the row via `StartAlignment` (`INSERT ... ON CONFLICT DO
   UPDATE ... WHERE status <> 'generating'`), flipping it to `generating`. If a
   job for that song is already generating, this is a no-op and the caller gets
   `started=false`.
2. Pushes the job onto a single buffered channel (`chan alignJob`, capacity
   1024) from a goroutine, so a full buffer can never block the HTTP handler —
   the row is already claimed, so the job is guaranteed to run eventually.

Exactly **one** `alignWorker` goroutine (started once at server init) drains
that channel and runs jobs strictly one at a time — system-wide, not per-song.
That means alignment requests queue up rather than run in parallel, on purpose:
each job is CPU/GPU-heavy (Demucs + WhisperX), so serializing avoids resource
contention on the sidecar.

`runAlignment` opens the song's stored audio file, POSTs it to the sidecar with
a timeout of `BACKEND_ALIGN_TIMEOUT + 30s` (default timeout `10m`, so ~10m30s
total headroom) on a **detached** context — so an HTTP request that already
returned `202` can't cancel a long-running job. On success it marshals
`Lines` to JSON and calls `MarkAlignmentReady` on a **fresh** short-lived
context (so an expired job context can't strand the row mid-write). Any
failure — file open, sidecar error, JSON marshal, or even a recovered panic —
calls `MarkAlignmentFailed` instead, so one bad job can never kill the worker
or leave a row stuck in `generating` forever. A boot-time sweep
(`FailOrphanedAlignments`) also flips any row still `generating` from before a
restart to `failed`, since the worker goroutine (and its job) don't survive a
process restart.

On success, the backend logs coverage stats: word count, aligned time span, and
the percentage of words with confidence below 0.4 — a cheap signal for
spot-checking alignment quality without inspecting the full JSON.

### HTTP endpoints

- **`POST /api/songs/{id}/align`** — auth-gated. `404` if the aligner isn't
  configured or the song doesn't exist; `400` if the song has no lyrics; `409`
  if already generating; otherwise `202 {"status":"generating"}` and the job is
  enqueued.
- **`GET /api/songs/{id}/align`** — auth-gated. `404` if no row exists at all
  (→ frontend's `needs`). Otherwise `{"status": ...}`, and when `status ==
  "ready"` also `{"engine": ..., "lines": [...]}` (the stored JSON, passed
  through as-is). The failure `reason` string is never exposed to clients.

Retries are not incremental: "Try again" just re-POSTs, which re-claims the row
and reruns the entire pipeline from scratch.

## Frontend playback (`ui/src/PlayerBar.tsx`, `KaraokeCard.tsx`, `KaraokeView.tsx`)

`canKaraoke = alignmentEnabled && hasLyrics` gates everything — the lyrics
glyph (mini-player and full player) only appears when both hold.

**Polling.** While the full-screen lyrics view is open, `PlayerBar` fetches
`GET /align` immediately and, if `status === "generating"`, re-polls every 2
seconds via `setTimeout` — plain HTTP polling, no SSE/websocket. Clicking
Generate/Try-again optimistically sets local state to `generating` before the
next poll confirms it, so the UI reacts instantly rather than waiting a full
poll cycle.

**Non-ready states** (`needs`, `generating`, `failed`) render `KaraokeCard`, a
presentational overlay on top of the dimmed plain lyrics text — so even a song
that's never been aligned still shows something behind the "Generate karaoke"
prompt.

**The sweep highlight** (`KaraokeView`, once `status === "ready"`) is
deliberately **not** timer- or CSS-animation-driven, and does not poll the
server for position. It runs a single `requestAnimationFrame` loop that reads
`currentTime` directly off the live `<audio>` element every frame (~60fps) and
writes DOM styles imperatively — never through React state, since React
state can't sustain 60fps updates without visible jank. Per line:

- The line "activates" 0.6s before its first word's start (clamped to never
  precede the previous line's end), so the highlight leads the vocal slightly
  rather than lagging it.
- The sweep's x-position is computed by walking the line's words and summing
  their fill fraction against the current time; each word's fill duration is
  capped at 1.2s even if the aligned timing itself spans longer, so a single
  long-held word doesn't crawl painfully slowly.
- A line stays visually active for 4s after its last word ends, so the
  highlight doesn't vanish the instant the line finishes.
- Word x-positions are measured once via DOM `offsetLeft`/`offsetWidth` after
  webfonts finish loading, and re-measured on resize.

Visually, each line renders as two overlapping text layers: a dim full-line
base and a bright fill clipped by a per-frame CSS `width` with a soft
mask-gradient edge for the sweep look. Off-focus lines fade/blur based on
distance from the active line, and the container translates vertically to
keep the active line centered — a continuous "now playing" scroll, ported from
the mockup at `docs/mockups/karaoke/player_integration.py`.

## SYLT export (`backend/internal/metadata/sylt.go`, `songs.go`)

When a song's alignment is `ready`, downloading its MP3 also bakes the word
timings into an embedded ID3 **SYLT** (synchronized lyrics) frame, so any
external player — a car stereo, another music app — can show the same synced
lyrics outside this app.

- `bogem/id3v2` (the tagging library this project uses) has no built-in SYLT
  support, so `sylt.go` hand-rolls a `Framer` implementation: UTF-16LE with
  BOM, ID3 absolute-millisecond timestamp format, content type "lyrics",
  default language code `"eng"`.
- The stored alignment JSON is flattened to one `SyncedWord{Text, TimeMs}` per
  word (`TimeMs = word.Start * 1000`); each line's first word is prefixed with
  a newline so players render line breaks, later words in the line with a
  leading space.
- This only happens on download, into a temp file — the on-disk original is
  never mutated. It's best-effort: if fetching or decoding the alignment fails
  for any reason, the SYLT frame is just omitted and the download proceeds
  with the song's other tags (title, artist, lyrics, cover) as normal.

## Failure modes at a glance

| Symptom | Cause |
|---|---|
| Lyrics glyph never appears | `BACKEND_ALIGN_URL` unset, or user not authenticated |
| Stuck on "Generating…" after a restart | Boot-time sweep should have failed it — check it actually ran; otherwise the row is genuinely still processing (single global worker, so heavy queue backlog is expected under concurrent requests) |
| Lyrics drift out of sync partway through a song | Line-regrouping word-count mismatch (see grouping.py's known limitation above) — re-running won't fix it if the underlying line/word-count mismatch persists |
| "Try again" reruns from scratch, slow | By design — no partial/incremental retry |
| SYLT missing from a downloaded MP3 despite karaoke working in-app | Alignment wasn't `ready` at download time, or decoding the stored JSON failed — check server logs; the download itself never fails because of this |
