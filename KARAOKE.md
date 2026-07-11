# Karaoke / synced lyrics

The plan and living reference for taking the app from "lyrics as text" to
"highlight exactly what's being sung, in time with the audio." This is the single
source of truth for the karaoke feature — status, architecture, what's built, and
the detailed plans for what's next.

---

## Big picture

**The core insight:** the user always has the full, correct lyrics for every song
(pasted from Suno, stored in the ID3 tag). So the problem is never *transcription*
("what words are sung?") — it is *forced alignment* ("given these known words, when
is each one sung?"). Every design choice follows from that.

**Granularity target:** word-level (a start/end time per word), which enables true
karaoke "wipe" highlighting. Line-level falls out of the word timings for free.

### Architecture

```
 ┌───────────┐   HTTP (JSON)    ┌──────────────────────┐   HTTP (multipart)   ┌─────────────────────┐
 │  React SPA │ ───────────────▶ │  Go app (static bin)  │ ───────────────────▶ │  alignment sidecar   │
 │  (ui/src)  │ ◀─────────────── │  backend/             │ ◀─────────────────── │  (sidecar/align/)    │
 └───────────┘   poll status     └──────────────────────┘   word timings JSON  │  Python: WhisperX     │
                                                                                │  + Demucs, GPU opt.   │
                                                                                └─────────────────────┘
```

- **Go app** stays a minimal, static (CGO-off) binary in Alpine. It owns storage,
  auth, job orchestration, and the HTTP contract — but contains **zero ML**. It only
  ever speaks HTTP to the sidecar.
- **Alignment sidecar** is a separate, opt-in container (heavy: torch + WhisperX +
  Demucs + ffmpeg, GBs). Stateless and synchronous: given audio + known lyrics, it
  returns word timings. All ML complexity is quarantined here.
- **SPA** reads timings and (Phase 3+) renders the highlighting.

### Alignment data flow (async, mirrors the fanart pattern)

1. `POST /api/songs/:id/align` (auth) → atomically claims a `song_alignment` row in
   `generating` state, returns `202`, spawns a **detached goroutine**.
2. The goroutine streams the MP3 + cleaned lyrics to the sidecar (`POST /align`),
   which runs Demucs vocal isolation → WhisperX forced alignment of the *known*
   lyrics, and returns per-word timings.
3. The goroutine stores the timings as JSON and marks the row `ready`/`failed`. A
   panic is recovered into `failed`; a process restart reaps orphaned `generating`
   rows to `failed` on boot.
4. The client polls `GET /api/songs/:id/align` until `ready`.

### Design principles (carried across every phase)

- **Known lyrics, always** → forced alignment, never ASR. The sidecar feeds WhisperX
  the real lyrics; it never trusts machine transcription of sung vocals.
- **Keep the Go image minimal** → all Python/ML lives in the sidecar; the main app is
  a static binary that only makes HTTP calls.
- **Reuse existing patterns** → async work = detached goroutine + `generating/ready/
  failed` DB status + boot reaper (the fanart pattern). External/optional capability =
  `BACKEND_*` env config gated by presence (the BFL pattern), surfaced as a session
  flag.
- **Never silently drop content** → e.g. lyric cleaning is a user-reviewed button,
  not an automatic destructive edit.

---

## Status

| Phase | Status | Summary |
|-------|--------|---------|
| **1 — Lyrics field** | ✅ Done (PR #48) | Lyrics box + Clean button in the tag editor; read/write ID3 `USLT`. |
| **2 — Alignment engine** | ✅ Done (PR #52) | Generate + store word-level timings via the sidecar. Engine only, no UI. |
| **2.5 — Quality evaluation** | ⏳ Deferred (do before Phase 3) | Prove the sidecar actually produces usable timings; fix the tokenizer cascade. |
| **3 — Highlighting player** | 📋 Planned | Front-end karaoke view that highlights the active word/line; `.lrc` export. |
| **4 — Correction editor** | 📋 Planned | UI to hand-correct mis-timed words. |

---

## What's built so far

### Phase 1 — Lyrics field (✅ PR #48)

A **Lyrics** box in the "Edit tags" modal, backed end-to-end by the ID3 `USLT`
(unsynchronised lyrics) frame:

- Reads embedded lyrics on upload, **auto-cleaning** Suno's `[Verse]`/`[Chorus]`/
  `[Guitar solo]` bracket directives (parenthetical `(ad-libs)` are kept — they're
  usually sung).
- Persists lyrics in `songs.lyrics` (migration `0002_song_lyrics.sql`).
- A **Clean** button re-runs the strip on demand (user reviews before saving —
  nothing removed silently).
- Bakes lyrics back into the `USLT` frame on download with delete-then-set (no stale
  or duplicate frames).

Key files: `ui/src/TagEditor.tsx` (box + Clean), `backend/internal/metadata/mp3.go`
(read + `cleanLyrics`), `.../metadata/write.go` (USLT write), `.../library/songs.go`
+ `.../library/edit.go` (persistence), `.../httpapi/tags.go` + `.../httpapi/songs.go`
(edit/download wiring). The clean rule is duplicated in Go (import) and TS (button),
kept in sync by comment.

### Phase 2 — Alignment engine (✅ PR #52)

Generates and stores word-level timings; **no visible player yet**. Manual trigger
(alignment is minutes-long and GPU-heavy), gated by `BACKEND_ALIGN_URL`.

- **DB:** `song_alignment` table (migration `0003_song_alignment.sql`) — `song_id` PK,
  `status` (`generating|ready|failed`), server-only `error`, `engine`, `data` (JSON
  timings), `created_at`. One row per song; re-running replaces it.
- **Persistence:** `backend/internal/library/alignment.go` — `StartAlignment`
  (atomic claim via `ON CONFLICT … WHERE status<>'generating'`, returns `started`),
  `MarkAlignmentReady`, `MarkAlignmentFailed`, `GetAlignment`, `FailOrphanedAlignments`
  (boot reaper). The `error` column is never selected into the read struct, so it
  cannot leak to a client.
- **Sidecar client:** `backend/internal/align/client.go` — streams multipart to the
  sidecar, parses the timings, surfaces the sidecar's `{"error":…}` on non-2xx.
- **Endpoints:** `backend/internal/httpapi/alignment.go` — `postAlign` (auth → 404 if
  disabled → 404 if no song → 400 if no lyrics → 409 if already generating → 202 +
  detached `runAlignment` goroutine with panic recovery) and `getAlign` (poll).
- **Wiring:** `backend/internal/httpapi/server.go` — routes, the typed-nil aligner
  gating (untyped-nil interface when disabled so `h.aligner == nil` holds), boot
  reaper, and the `alignmentEnabled` session flag.
- **Config:** `backend/internal/config/config.go` — `AlignURL`, `AlignTimeout`,
  `AlignmentEnabled()`.
- **Sidecar:** `sidecar/align/` — `app.py` (FastAPI: `POST /align`, `GET /health`;
  Demucs → WhisperX forced alignment of the whole lyric as one segment),
  `grouping.py` (pure word→line regrouping, unit-tested), `Containerfile`,
  `requirements.txt`.
- **Ops:** `compose.yaml` gained an opt-in `align` service (profile `align`, GPU
  optional).

Tests: Go persistence/gating/client/endpoints + server-level wiring tests (routes,
typed-nil gating, session flag, full upload→POST→poll-to-`ready` against a stub
sidecar); Python `grouping.py` unit tests. All ML-free and green.

---

## Known limitations / deferred work

These are documented in-code and carried forward honestly:

1. **Alignment *quality* is unverified.** Phase 2's plumbing is proven end-to-end, but
   no real sidecar run has confirmed the timings are *usable*. The load-bearing
   assumption — feeding the whole lyric to WhisperX as one `[0, duration]` segment —
   is unproven on real songs.
2. **Tokenizer-mismatch cascade** in `sidecar/align/grouping.py`. Line word counts use
   naive `str.split()`, but the flat word list comes from WhisperX's own tokenization.
   A per-line count mismatch (apostrophes, hyphens, punctuation, dropped words) shifts
   every *later* line's timings silently while the row still reads `ready`. The guard
   only prevents a crash, not the drift. A robust fix aligns WhisperX tokens back to
   source words rather than counting.

---

## Phase 2.5 — Quality evaluation (⏳ do this before Phase 3)

**Why first:** building a player on top of unverified timings risks faithfully
displaying bad data. De-risk the engine before investing in UI.

Scope:
- Build + run the sidecar container (`sidecar/align/Containerfile`) with models.
- Run the smoke test: align a few real songs with known lyrics; assert per-word times
  are monotonic, within `[0, duration]`, and every input word is present.
- Evaluate the single-whole-track-segment approach vs. chunking the lyrics into a few
  multi-line segments; pick whichever aligns better.
- Fix the tokenizer cascade (limitation #2): map WhisperX tokens back to source words
  instead of counting, so a mismatch can't silently shift later lines.
- Record findings (accuracy, failure modes, per-song runtime CPU vs GPU) back into
  this file.

Deliverable: a documented, trustworthy engine — or a concrete list of what to change.

---

## Phase 3 — Highlighting player + LRC export (📋 next after 2.5)

**Goal:** while a song with `ready` timings plays, highlight the active word/line in
time with the audio; and export the timings as an enhanced `.lrc` file.

Scope:
1. **Karaoke view** in the web UI. On each audio `timeupdate` tick, find the active
   segment (`start ≤ currentTime < end`), highlight the current word/line, and
   auto-scroll it into view. Optional per-word gradient "wipe" using
   `(currentTime − start) / (end − start)`. Fall back gracefully to the plain stored
   lyrics when a song has no alignment. Gate on the `alignmentEnabled` session flag +
   the per-song alignment `status`.
2. **`.lrc` export** — an endpoint that renders a song's stored timings as enhanced
   LRC (word-level A2 `<mm:ss.xx>` markers), downloadable.

Integration points:
- Timings come from `GET /api/songs/:id/align` → `{status, engine, lines:[{text,
  start,end,words:[{w,start,end,conf}]}]}` (see Data contract below).
- The front end is React/TS with **inline `React.CSSProperties` + CSS custom
  properties** (no CSS framework); mirror that. The now-playing player lives in
  `ui/src` — decide during brainstorming where the karaoke view attaches (overlay,
  dedicated route, or expanded now-playing panel).

Process: worktree; brainstorm the UI/placement first; write a plan; TDD; **verify the
visible UI in a real browser (Playwright)**, not just build+tests; generic-subagent
code review; PR to `master`.

---

## Phase 4 — Correction editor (📋 later)

**Goal:** a UI to hand-correct mis-timed words — sung vocals never align perfectly,
and this is the escape hatch.

Scope (to be refined in its own brainstorm):
- Tap-to-retime a word; nudge/shift a whole line; re-run alignment for a single
  stanza rather than the whole song.
- Persist corrected timings back into the `song_alignment.data` JSON (the schema
  already carries arbitrary line/word timing JSON, so likely no migration).
- Reflect edits immediately in the Phase 3 player.

---

## Data contract reference

**Alignment JSON** (`song_alignment.data`, and the `lines` field of the GET
response):
```json
{
  "engine": "whisperx+demucs",
  "lines": [
    { "text": "Never gonna give you up",
      "start": 12.00, "end": 13.60,
      "words": [ {"w": "Never", "start": 12.00, "end": 12.40, "conf": 0.97}, … ] }
  ]
}
```
Times are seconds from track start, monotonic non-decreasing, within `[0, duration]`.

**Endpoints:**
- `POST /api/songs/:id/align` (auth) → `202 {"status":"generating"}` | `409` already
  generating | `400` no lyrics | `404` disabled/unknown song | `403` anon.
- `GET /api/songs/:id/align` (auth) → `{status}` while generating/failed;
  `{status:"ready", engine, lines:[…]}` when done; `404` if never requested. The
  server-only `error` is never included.

**Config / gating:**
- `BACKEND_ALIGN_URL` (e.g. `http://align:8000`) enables the feature; empty = off.
- `BACKEND_ALIGN_TIMEOUT` (default `10m`) bounds the whole alignment request.
- Session flag `alignmentEnabled` = `AlignmentEnabled() && authenticated`.
- Sidecar: `docker compose --profile align up -d`, then set `BACKEND_ALIGN_URL`.

**Sidecar contract** (`sidecar/align/`):
- `POST /align` multipart: `audio` (MP3 bytes) + `lyrics` (plain UTF-8, one line per
  text line, already cleaned) + optional `language` (default `en`) → the JSON above.
- `GET /health` → `{"status":"ok"}`.

---

## Process conventions (all phases)

- Work in an isolated git **worktree**; default branch is `master`; open a **PR**,
  never push to `master` directly.
- **Brainstorm → spec → plan → TDD**, then a **generic-subagent code review** before
  merge. Design specs live under `docs/superpowers/specs/`, plans under
  `docs/superpowers/plans/`.
- For visible UI work, **verify in a real browser (Playwright)** — build + unit tests
  are not sufficient evidence a UI change works.
- New HTTP endpoints get a test through the **real server/mux** (routes, gating,
  auth), not just in-package handler unit tests.
