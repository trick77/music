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
| **2.5 — Quality evaluation** | ✅ Validated (spike) | Real container built + run; a real Suno song aligned **cleanly** (see results below). Two build bugs found + fixed. |
| **3 — Highlighting player** | 🔜 Next | Apple-Music-style karaoke sweep in the full-screen player, trigger/indicator UI, and SYLT baked into downloads. |
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

1. **Alignment *quality* is validated on one clean track, not broadly.** The Phase 2.5
   spike confirmed the whole-track-single-segment approach produces good timings on a
   slower, clear Suno vocal (see above). It has **not** been tested on busy mixes,
   fast/rap vocals, or non-English — those may need lyric chunking or per-song tuning.
2. **Tokenizer-mismatch cascade** in `sidecar/align/grouping.py`. Line word counts use
   naive `str.split()`, but the flat word list comes from WhisperX's own tokenization.
   A per-line count mismatch (apostrophes, hyphens, punctuation, dropped words) shifts
   every *later* line's timings silently while the row still reads `ready`. The guard
   only prevents a crash, not the drift. A robust fix aligns WhisperX tokens back to
   source words rather than counting.

---

## Phase 2.5 — Quality evaluation (✅ validated)

De-risked the engine before investing in the player, by building + running the **real
container** and aligning a real song end-to-end.

### Build bugs found + fixed
1. **`Containerfile` name breaks Docker.** `docker build` / `docker compose build`
   default to `Dockerfile`. Fixed `compose.yaml` to `build: {context, dockerfile:
   Containerfile}` + `platform: linux/amd64`.
2. **Unpinned deps + arch.** `demucs` pulls `sphn`, which has no arm64 wheel → Rust
   source build fails on the slim image. Prod is amd64 (release.yaml), where wheels
   exist. Fixed by building `linux/amd64` and **pinning** `requirements.txt` to the
   validated versions (torch 2.8.0, whisperx 3.8.6, demucs 4.1.0, fastapi 0.139.0,
   uvicorn 0.51.0, python-multipart 0.0.32).

### Runtime: validated, no `app.py` bugs
Container builds (8.57 GB), `/health` 200, all heavy imports load. `/align` returns the
exact JSON contract; Demucs + WhisperX + `grouping.py` all fire. First call downloads
models (~360 MB align + Demucs); mount `-v music-align-cache:/root/.cache` so later runs
skip it.

### Quality: a real Suno track ("When the canopy…", 208 s) aligned cleanly
- 190 words spanning **20.9 s → 204.3 s** — words fill the whole song; the instrumental
  intro (0–21 s) correctly has none. The whole-track-single-segment approach (the main
  risk) **did not collapse**.
- Timings monotonic, non-overlapping. Confidence median **0.79** (max 0.98), only
  ~9% below 0.4.
- The 4 repeated chorus lines placed at **distinct** positions (51 / 70 / 125 / 180 s),
  not smeared onto one — the hard repeated-block case worked.
- Confirmed good on playback. **Verdict: the approach works; greenlight Phase 3.**

### Still unproven (revisit if quality regresses)
- Only one clean, slower vocal tested. Busier/faster/rap tracks may be harder.
- The **tokenizer-mismatch cascade** (limitation #2 below) did not visibly manifest
  here, but is not proven robust — watch for it on tougher songs. The spike driver +
  self-contained HTML preview (`align_preview.py`) can re-check any song quickly.

---

## Phase 3 — Highlighting karaoke player (🔜 next after 2.5)

**Goal:** a beautiful in-app karaoke view — while a song with `ready` timings plays, a
single continuous highlight sweeps across each line in time with the vocal (Apple-Music
style), inactive lines depth-blurred, over the artwork backdrop — plus the trigger /
lifecycle UI to generate timings, and baking the timings into the MP3 on download.

### The player view (design locked via mock — see `docs/mockups/`)
- Lives **inside the existing full-screen player** (`PlayerBar.tsx` `full` state), which
  already paints a blurred cover-art background. A **Lyrics toggle** in the control row
  swaps cover art ↔ karaoke sweep; artwork shrinks to a now-playing chip; the scrubber /
  transport stay docked and keep driving playback. No new route or shell.
- **Continuous per-line sweep** (NOT per-word): one bright overlay per line clipped to a
  single leading edge that glides through words *and* the spaces between them, driven by
  the word timings. Sweep speed tracks each word's duration (fast words accelerate, held
  words ease), capped at `MAX_SWEEP` so long words don't crawl.
- **Line-advance lead**: the active line takes focus/scroll `LEAD` seconds *before* its
  first word (clamped past the previous line's end), so the eye arrives early.
- Inactive lines **dim + blur, increasing with distance**; eased auto-scroll anchors the
  active line ~40% down; top/bottom fade masks.
- Validated mock values: `LEAD ≈ 0.6 s`, `MAX_SWEEP ≈ 1.2 s`; themed to loom tokens
  (cream-ink fill, terracotta glow, serif type).
- **Fallback**: lyrics but no alignment → plain lyrics; no lyrics → hide the Lyrics
  toggle. Gate on `alignmentEnabled` + per-song `status`.

### Triggering alignment (lyrics-driven + manual)
Alignment is meaningless without lyrics and goes stale if lyrics change, so it's driven
by lyrics availability — never blanket-on-import:
1. **On lyrics save in the tag editor** — saving a non-empty, *changed* Lyrics field
   auto-starts alignment in the background (covers "file had no lyrics, added later").
2. **On import** — only when the uploaded MP3 already carries embedded lyrics.
3. **Manual "Generate karaoke" / "Re-sync"** — in the Lyrics-view CTA and the song ···
   menu (`SongMenu.tsx`), for on-demand runs or re-syncs.

Editing lyrics later re-triggers (the DB upsert already resets the row to `generating`).

### Async + queue + progress indicator
- Runs as a background job (fanart pattern: detached goroutine, `generating/ready/failed`
  DB status, boot reaper). The sidecar processes one song at a time, so triggers feed a
  **serialized queue** (one alignment at a time) — a Phase 3 addition (Phase 2 has none).
- **Indicator** driven by the song's `generating` status, shown everywhere the song
  appears: the now-playing chip ("● Syncing karaoke…"), the **song row** in lists, the
  Lyrics-view card, and optionally a global toast (like `UploadToast.tsx`). Clients poll
  `GET /api/songs/:id/align` while generating.

### Storage + download bake (SYLT)
- **DB is the source of truth** — `song_alignment.data` JSON; **no server-side file**.
- **On download, bake the timings into the MP3's `SYLT` (synchronised lyrics) frame**,
  stamped like the other tags (title/artist/USLT/cover) via `metadata.StampTags` /
  `songTags` — the stored file is untouched; timings go into the throwaway download copy.
  *Impl caveat:* confirm `bogem/id3v2` supports `SYLT`; if not, add a small custom frame
  writer. (Reverses the earlier "in-app only, no export" note.)

Integration points:
- Timings: `GET /api/songs/:id/align` → `{status, engine, lines:[{text,start,end,
  words:[{w,start,end,conf}]}]}`.
- Trigger: `POST /api/songs/:id/align` (exists) — wire it to the tag-editor save, the
  CTA, and the song menu; add the serialized queue in front of it.
- Front end is React/TS, inline `React.CSSProperties` + CSS custom properties (loom
  tokens): player `PlayerBar.tsx`, menu `SongMenu.tsx`, tag editor `TagEditor.tsx`.

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
