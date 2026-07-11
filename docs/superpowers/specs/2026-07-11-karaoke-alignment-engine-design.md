# Design — Karaoke Phase 2: word-level alignment engine

**Date:** 2026-07-11
**Status:** Approved design, pending implementation plan
**Roadmap:** `docs/karaoke-roadmap.md` (Phase 2 of 4)

## Context

Phase 1 gave every song stored lyrics (the ID3 `USLT` frame, cleaned of Suno
directives). Phase 2 turns those words into **word-level timings** — a
`{word, start, end}` for every sung word — so a later phase can highlight exactly
what's being sung. Because the user always has the full, correct lyrics, this is a
**forced-alignment** problem (align known text to audio), not transcription.

The deployment is a minimal, static Go binary in an Alpine image (no Python, ffmpeg,
ML runtime, or GPU), self-hosted via Docker Compose. WhisperX + Demucs cannot live in
that image. The app already has the two patterns we need: external submit→poll calls
(BFL image gen) and detached-goroutine async work with a `generating/ready/failed` DB
status + boot reaper (fanart generation). Phase 2 is another instance of both.

**Scope:** generate + store timings only. No player UI (Phase 3), no correction editor
(Phase 4). Verify via stored data / a debug JSON view.

## Architecture

```
 browser ──POST /api/songs/:id/align──▶ Go handler
                                          │ insert song_alignment row status=generating
                                          │ return 202
                                          └─▶ detached goroutine (context.Background)
                                                 │ read cleaned lyrics + audio file
                                                 │ POST /align (mp3 + lyrics) ──▶ align-sidecar
                                                 │                                  Demucs → WhisperX
                                                 │ ◀── JSON word timings ───────────  (Python, GPU opt.)
                                                 │ store data, mark ready|failed
 browser ──GET /api/songs/:id/align (poll)──▶ status + timings
```

Two independently understandable units:

1. **Go alignment orchestrator** (`internal/align` + httpapi handlers + `library`
   persistence). Knows: how to kick off/track/store an alignment job. Depends on: an
   HTTP aligner endpoint and the song's lyrics/audio. Never touches ML.
2. **Alignment sidecar** (separate repo dir / image, e.g. `sidecar/align/`). Knows:
   given audio + known lyrics, return word timings. Depends on: WhisperX, Demucs,
   ffmpeg, torch. Stateless and synchronous — no DB, no job state.

### Boundary contract (the seam)

- `POST /align` — `multipart/form-data`: `audio` (the MP3 bytes), `lyrics` (plain
  UTF-8, one lyric line per text line, already cleaned). Optional `language` (default
  `en`).
- Response `200`: JSON
  ```json
  {
    "engine": "whisperx-<ver>+demucs",
    "lines": [
      { "text": "Never gonna give you up",
        "start": 12.00, "end": 13.60,
        "words": [ {"w":"Never","start":12.00,"end":12.40,"conf":0.97}, ... ] }
    ]
  }
  ```
  Times are seconds from track start, monotonic non-decreasing, within `[0, duration]`.
- Response `4xx/5xx`: `{ "error": "<reason>" }`. Any non-2xx ⇒ Go marks the job
  `failed` with the reason (server-only).
- `GET /health` ⇒ `200` when models are loaded.

The Go goroutine holds the `POST /align` request open for the whole job (long timeout,
`BACKEND_ALIGN_TIMEOUT`, default e.g. 10 min), exactly like BFL's poll deadline. The
sidecar owns all ML complexity (vocal isolation, feeding known lyrics to WhisperX's
alignment stage rather than its ASR, interpolating unalignable words); the Go side only
sees the JSON contract above.

## Data model

New migration `backend/internal/store/migrations/0003_song_alignment.sql`:

```sql
CREATE TABLE song_alignment (
    song_id    TEXT PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'generating'
                 CHECK (status IN ('generating','ready','failed')),
    error      TEXT,                       -- server-only failure reason
    engine     TEXT,                       -- e.g. 'whisperx-3.x+demucs'
    data       TEXT,                       -- JSON: the `lines` array above
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

One row per song (re-running an alignment upserts/replaces it). Timings are stored as
the sidecar's JSON `lines` array verbatim — a song is a few hundred words, so a TEXT
column is ample; no need for a per-word table. Mirrors the `fanart` / `studio_coverart`
`status`/`error` shape, so the boot-reaper and status helpers are near-copies.

Persistence lives in `backend/internal/library/alignment.go`:
`CreateGeneratingAlignment`, `MarkAlignmentReady(engine, data)`,
`MarkAlignmentFailed(error)`, `GetAlignment(songID)`, and
`FailOrphanedAlignments()` (boot reaper, called from `server.go` wiring).

## HTTP API

- `POST /api/songs/:id/align` — auth required (403 anon), `alignmentEnabled` required
  (404 when off), song must exist (404). Upserts a `generating` row, spawns the
  detached goroutine, returns `202 {"status":"generating"}`. If a job is already
  `generating` for that song, return `409` (no double-spawn).
- `GET /api/songs/:id/align` — returns `{status, engine, lines}` when ready,
  `{status:'generating'}` while running, `{status:'failed'}` (error omitted — it's
  server-only) on failure, `404` if never requested.

Registered in `backend/internal/httpapi/server.go` alongside the song routes.

## Config & gating (BFL/Chat pattern)

- `config.Config` gains `AlignURL string` + `AlignTimeout time.Duration`, loaded from
  `BACKEND_ALIGN_URL` / `BACKEND_ALIGN_TIMEOUT`. `AlignmentEnabled()` ⇒ `AlignURL != ""`.
- `GET /api/auth/session` adds `alignmentEnabled: cfg.AlignmentEnabled() && authenticated`.
- The aligner client is `backend/internal/align/client.go` — a thin `net/http` client
  (base URL, timeout) mirroring `imagegen/bfl.go` minus the polling (sidecar is sync).

## Deployment

`compose.yaml` gains an `align` service running the sidecar image
(`ghcr.io/trick77/music-align` or built from `sidecar/align/Containerfile`). The main
app gets `BACKEND_ALIGN_URL=http://align:8000`. GPU is optional via a documented
`deploy.resources.reservations.devices` block (commented out by default; CPU works,
slower). The sidecar is a separate Containerfile so the main image stays static/tiny.

## Testing

**Go (no ML):**
- Async orchestration: `POST` → `202` → goroutine calls a **stubbed sidecar**
  (`httptest.Server` returning canned `lines`) → row transitions `generating`→`ready`
  → stored JSON matches. Failure path: stub returns `500` → row `failed`.
- Boot reaper: seed a `generating` row, run `FailOrphanedAlignments`, assert `failed`.
- Gating/auth: anon `POST`/`GET` ⇒ 403; alignment-disabled ⇒ 404; unknown song ⇒ 404;
  double-`POST` while generating ⇒ 409.
- Contract: JSON (de)serialization of the `lines` shape round-trips.

**Sidecar:**
- Smoke test: align a short clip with known lyrics; assert per-word times are
  monotonic, within `[0, duration]`, and every input word is present in the output.

## Out of scope (later phases)

- Highlighting player, `.lrc` export (Phase 3).
- Hand-correction UI (Phase 4).
- Auto-align on upload (kept manual: alignment is minutes-long and GPU-heavy).
- SSE progress (polling is sufficient, matches fanart).

## Open implementation questions (resolve during planning)

- Exact WhisperX invocation for *known-text* forced alignment (feed lyrics as
  pre-set segments to `whisperx.align()` vs. a dedicated forced aligner if alignment
  quality on a single whole-track segment is poor).
- Whether the sidecar returns line bounds directly or Go derives them from word bounds.
- Sidecar base image + how models are baked in vs. downloaded on first run.
