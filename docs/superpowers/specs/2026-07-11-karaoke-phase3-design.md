# Karaoke Phase 3 — Highlighting player, triggers/lifecycle, SYLT-on-download

Status: approved design (brainstorm complete). Source of truth: `KARAOKE.md` §"Phase 3"
plus the locked mock in `docs/mockups/karaoke/player_integration.py`. This spec records
the integration architecture and the decisions the mock/spec leave open; the look and
motion are lifted verbatim from the mock.

## Goal

While a song with `ready` word-timings plays, an Apple-Music-style continuous highlight
sweeps each line in time with the vocal, inside the existing full-screen player. Plus the
trigger/lifecycle UI to generate timings (lyrics-driven + manual), a serialized queue in
front of the single-threaded sidecar, progress indicators everywhere the song appears,
and baking the timings into the downloaded MP3's `SYLT` frame.

Phases 1/2/2.5 are merged: the engine (`POST/GET /api/songs/:id/align`), the
`song_alignment` table, the sidecar, and the `alignmentEnabled` session flag already
exist. This phase adds no new alignment *engine* — it wires triggers, a queue, UI, and
export around the existing contract.

## Decisions (the open forks, resolved)

- **Progress surfaces: inline only, no global toast.** Now-playing chip, song-row badge,
  and Lyrics-view card cover the `generating` state everywhere a song appears. A toast is
  redundant for a quiet background job; skipped to keep Phase 3 tight.
- **Failed alignment: a failed card with retry.** The Lyrics view shows a "Couldn't sync —
  Try again" card (the Needs-sync card with failure copy + a retry CTA that re-POSTs
  `/align`). Recoverable and honest, not a silent fallback.
- **Manual menu label: context-aware.** SongMenu shows "Generate karaoke" when the song
  has no `ready` alignment and "Re-sync karaoke" when it is already synced.
- **Empty lyrics can never trigger alignment (hard no-op, never a failure).**
  - SongMenu / Lyrics CTA render the trigger only when `alignmentEnabled && lyrics.trim() !== ""`.
  - No-lyrics songs hide the Lyrics toggle entirely, so there is no button to press.
  - Server triggers enqueue only for non-empty lyrics (import: embedded lyrics present;
    save: the *changed* value is non-empty — clearing lyrics never enqueues).
  - `enqueueAlignment` no-ops on empty lyrics rather than claiming a doomed row; `postAlign`
    keeps its `400 "no lyrics"` guard as defense-in-depth, handled quietly by clients.

## A. Backend

### A1. `alignmentStatus` on the Song payload
A song *row in a list* cannot show "● Syncing" unless status ships in the payload, and
`Song` has no alignment field today. Following the fanart pattern (status lives inside the
entity), add `alignmentStatus` (`"" | "generating" | "ready" | "failed"`; `""` = never
requested).

- Add `al.status` via `LEFT JOIN song_alignment al ON al.song_id = s.id` to the single
  `songSelect` const (`internal/library/songs.go`) and to the parallel top-ten query in
  `internal/library/plays.go` (`scanSongWithCount`). `scanSong`/`scanSongWithCount` read a
  `sql.NullString` into `Song.AlignmentStatus`.
- Add the field to the `Song` struct and its JSON. It rides every existing song response
  (list, home, search, playlists, artist, get) with no new endpoint. Anonymous browse gets
  `""` for all — harmless.

### A2. Serialized queue (one worker)
The sidecar handles one job at a time, so bulk edits/imports must not stampede it.

- Refactor `go h.runAlignment(...)` into a single funnel `h.enqueueAlignment(songID,
  relPath, lyrics)` that all triggers (postAlign, import, save) call.
- `enqueueAlignment` performs the atomic `StartAlignment` claim (flips the row to
  `generating` immediately, so the indicator lights and 202/409 semantics survive), then
  pushes the job onto a buffered channel. It no-ops on empty lyrics or a non-`started`
  claim.
- Exactly **one** worker goroutine, started at server init next to the boot reaper, drains
  the channel and runs `runAlignment` bodies sequentially. The existing boot reaper
  (`FailOrphanedAlignments`) already reaps rows left `generating` by a restart, which now
  also covers queued-but-unstarted jobs.
- `postAlign` returns `202` on a successful claim+enqueue, `409` if already generating —
  unchanged from the client's view. Detached-goroutine panic recovery is preserved in the
  worker.

### A3. Triggers
- **Import** (`upload` handler): after a successful import, enqueue alignment **only when
  the uploaded MP3 already carried embedded lyrics** (the parsed lyrics are non-empty).
  Gated on `alignmentEnabled`.
- **Lyrics save** (`patch`/edit handler): compare the incoming lyrics against the stored
  value; when it is non-empty **and changed**, enqueue. Server-side so every edit path is
  covered and none can bypass it. Gated on `alignmentEnabled`.
- **Manual**: unchanged `POST /api/songs/:id/align` from the Lyrics-view CTA and SongMenu.

### A4. SYLT on download
bogem/id3v2 v2.1.4 supports only USLT — confirmed by inspection. `Framer.WriteTo` takes a
plain `io.Writer`, so a custom frame needs only stdlib.

- New `metadata.SyncedLyricsFrame` implementing bogem's `Framer` (`Size`,
  `UniqueIdentifier`, `WriteTo`), added to the tag via `tag.AddFrame("SYLT", frame)`.
- **Body layout (ID3v2 SYLT):** `enc(1) + language(3) + timeFormat 0x02(ms) +
  contentType 0x01(lyrics) + descriptor(text+term)` then repeated
  `[text][term][uint32 ms big-endian]` sync entries, one per word (or per line — see
  below), each line-leading entry prefixed with `\n`.
- **Encoding: UTF-16 + BOM (key `0x01`, 2-byte terminators)** for safety across arbitrary
  tags/lyrics without depending on a v2.4 tag.
- **`Size()` must exactly equal the bytes `WriteTo` emits, terminators included** — a
  mismatch desyncs every frame after SYLT. This is the bug to fear; guarded by a
  byte-count unit test *and* a round-trip re-parse.
- Wiring: extend `songTags` (`internal/httpapi/songs.go`) to fetch `GetAlignment`; when
  `status == "ready"`, parse the stored line JSON into sync entries and attach them to the
  `WriteableTags` (new `Synced []SyncedLine` field or similar). `WriteTags` does
  delete-then-set (`DeleteFrames("SYLT")` then add), exactly like USLT. Best-effort: any
  parse/attach failure leaves SYLT off and never fails the download (matches the existing
  stamp fallback). The stored file is never mutated — timings go only into the throwaway
  download copy.
- **Granularity:** emit one SYLT sync entry **per word** (the frame's native granularity),
  reconstructing line breaks with a leading `\n` on each line's first word — this is what
  players expect and preserves the word timings we have.

## B. Frontend — player view

### B1. Audio-element access for a smooth sweep
`player.ts` exposes only a throttled (~4 Hz `timeupdate`) `positionMs`; the `<audio>`
element is a private singleton. Add `player.getAudioElement(): HTMLAudioElement | null`
returning the live element. The karaoke view runs its **own** `requestAnimationFrame`
loop reading `audio.currentTime` and writing fill-widths/scroll **directly to DOM refs** —
never through React state at 60 fps.

### B2. `KaraokeView.tsx` (new)
Lifts the mock's CSS/JS into React with the locked constants `LEAD = 0.6`,
`MAX_SWEEP = 1.2`:
- One bright `fill` overlay per line, clipped to a single leading edge (`frontX`) that
  glides through words *and* the spaces between them; sweep speed tracks each word's
  duration, capped at `MAX_SWEEP`.
- Active line takes focus/scroll `LEAD` s before its first word, clamped past the previous
  line's end.
- Inactive lines dim + blur increasing with distance; eased auto-scroll anchors the active
  line ~40% down; top/bottom mask.
- Word x-positions measured after `document.fonts.ready`, re-measured on resize.
- Themed to loom tokens via existing `--color-*` / `--font-serif` custom properties.
- rAF loop cleaned up on unmount.

### B3. PlayerBar `full` integration
- A **Lyrics toggle** in the full-screen control row swaps cover-art ↔ `KaraokeView`;
  artwork shrinks to the now-playing chip; the scrubber/transport stay docked and keep
  driving playback. No new route.
- On open (and while `generating`), fetch `GET /api/songs/:id/align`; poll while
  `generating`.
- **State machine** (gated on `alignmentEnabled`):
  - `ready` → the sweep.
  - lyrics present, not `ready`:
    - `generating` → "Aligning…" card + the syncing chip.
    - `failed` → "Couldn't sync — Try again" card (retry re-POSTs `/align`).
    - none/`""` → "Sync lyrics to the music" needs-sync card (Generate CTA).
    - Behind any card, fall back to **plain lyrics** so a poorly-aligned or unaligned song
      still shows its words.
  - no lyrics → hide the Lyrics toggle entirely.

## C. Frontend — indicators
Driven by `song.alignmentStatus` and the open-surface `GET /align` polls:
- **Now-playing chip**: "● Syncing karaoke…" while generating.
- **Song-row badge** in lists: a small "Syncing" indicator when `alignmentStatus ===
  "generating"`.
- **Lyrics-view card**: Synced / Needs-sync / Generating / Failed (§B3).
- No global toast (decision above).

## D. Testing

### Go
- Queue: multiple enqueues run strictly one-at-a-time (serialization), claim-at-enqueue
  flips status immediately, empty lyrics no-op.
- Payload: `alignmentStatus` populated via the join for list/get; `""` when no row.
- Triggers: import enqueues only with embedded lyrics; save enqueues only on a non-empty
  *changed* value; clearing lyrics does not enqueue.
- SYLT: `Size()` == actual `WriteTo` byte count (table of cases incl. multibyte lyrics);
  **round-trip** — stamp a file, re-open with bogem (parses clean) and assert the SYLT
  frame is present/well-formed (ffprobe/mid3v2 as an out-of-band manual check).
- Endpoints unchanged, so the existing real-mux server tests continue to cover
  routes/gating/auth. (No new endpoint ⇒ no new assembled-server test required.)

### Playwright (visible UI — required, not optional)
- Seed a synthetic `ready` alignment row (a few lines + word timings) for a deterministic
  sweep/scroll/toggle test and the fallback states (needs-sync / generating / failed /
  plain-lyrics / no-lyrics-hides-toggle).
- One real sidecar trigger→ready smoke run out-of-band (the 8.5 GB `music-align` image),
  not in the UI loop.

## Files touched (anticipated)
- Backend: `internal/library/songs.go` (join + struct + scan), `internal/library/plays.go`
  (top-ten join), `internal/httpapi/alignment.go` (enqueue funnel + worker),
  `internal/httpapi/server.go` (start worker), `internal/httpapi/songs.go` (import trigger,
  save trigger, SYLT in songTags), `internal/metadata/write.go` + new
  `internal/metadata/sylt.go` (custom frame).
- Frontend: `ui/src/player.ts` (`getAudioElement`), new `ui/src/KaraokeView.tsx`,
  `ui/src/PlayerBar.tsx` (toggle + integration + chip), `ui/src/SongMenu.tsx` (context-aware
  trigger), `ui/src/TagEditor.tsx` (no change needed — save trigger is server-side),
  `ui/src/api.ts` (`alignmentStatus` type + `getAlign`/`postAlign` helpers), song-row
  components for the badge.
- Docs: update `KARAOKE.md` status table + Phase 3 section on completion.

## Process
Worktree (done: `worktree-karaoke-phase3`); TDD; verify the visible UI in a real browser
(Playwright); generic-subagent code review; PR to `master`, never push directly.
