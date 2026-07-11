# Karaoke Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the in-app karaoke highlighting player, its trigger/lifecycle UI, a serialized alignment queue, progress indicators, and SYLT-baked downloads — around the existing Phase 2 alignment engine.

**Architecture:** Backend adds `alignmentStatus` to the Song payload (one central `LEFT JOIN`), funnels all alignment triggers through a claim-at-enqueue funnel drained by a single worker goroutine, wires server-side triggers (import + lyrics-save), and bakes timings into a custom `SYLT` id3v2 frame on download. Frontend adds a self-contained `requestAnimationFrame` karaoke sweep view inside the full-screen player, a Lyrics toggle, and inline progress indicators.

**Tech Stack:** Go 1.x (net/http, database/sql, `github.com/bogem/id3v2/v2`), SQLite, React + TypeScript (Vite, Vitest), Playwright MCP for visible-UI verification.

## Global Constraints

- Default branch **`master`**; work stays on `worktree-karaoke-phase3`; open a PR, never push to master.
- Swiss orthography in any German text (none expected here).
- The alignment JSON contract is fixed: `{engine, lines:[{text,start,end,words:[{w,start,end,conf}]}]}`; times are seconds from track start.
- Locked player constants: `LEAD = 0.6`, `MAX_SWEEP = 1.2`. Look/motion lifted from `docs/mockups/karaoke/player_integration.py`; theme via existing loom CSS custom properties (`--color-*`, `--font-serif`).
- The sweep must NOT be driven by React state at 60fps — own `requestAnimationFrame` loop writing to DOM refs, reading the real `<audio>` element.
- Empty lyrics must never trigger alignment and must never surface as a failure.
- `SYLT.Size()` must exactly equal the bytes `WriteTo` emits — derive both from the same encoder.
- Frontend uses inline `React.CSSProperties` + CSS custom properties (no CSS framework).
- Stored files are never mutated; downloads bake tags into a throwaway copy (existing `StampTags` pattern).

---

## Task 1: `alignmentStatus` on the Song payload

**Files:**
- Modify: `backend/internal/library/songs.go` (Song struct ~L12, `songSelect` ~L180, `scanSong` ~L200)
- Modify: `backend/internal/library/plays.go` (`topTenSelect` ~L34, `scanSongWithCount` ~L74)
- Test: `backend/internal/library/songs_test.go` (add a test)

**Interfaces:**
- Produces: `Song.AlignmentStatus string` (JSON `alignmentStatus`), values `"" | "generating" | "ready" | "failed"`; `""` when no `song_alignment` row exists.

- [ ] **Step 1: Write the failing test**

Add to `backend/internal/library/songs_test.go` (reuse whatever test DB helper the file already uses — e.g. `newTestRepo(t)` / `openTestRepo(t)`; match the existing pattern in that file):

```go
func TestSong_AlignmentStatus(t *testing.T) {
	r := newTestRepo(t) // match existing helper name in this test file
	ctx := context.Background()
	id := seedSong(t, r) // match existing seed helper; must create one song with lyrics

	// No alignment row yet -> empty status.
	got, err := r.GetByID(ctx, id) // match the existing single-song getter name
	if err != nil {
		t.Fatal(err)
	}
	if got.AlignmentStatus != "" {
		t.Fatalf("want empty status, got %q", got.AlignmentStatus)
	}

	// After a claim, the song reports "generating".
	if _, err := r.StartAlignment(ctx, id); err != nil {
		t.Fatal(err)
	}
	got, err = r.GetByID(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if got.AlignmentStatus != "generating" {
		t.Fatalf("want generating, got %q", got.AlignmentStatus)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/library/ -run TestSong_AlignmentStatus -v`
Expected: FAIL (field `AlignmentStatus` undefined, or empty because not selected).

- [ ] **Step 3: Implement**

In `songs.go`, add to the `Song` struct (after `Published`):

```go
	// AlignmentStatus is the karaoke word-timing state ("" = never requested,
	// generating|ready|failed). Rides every song payload via a LEFT JOIN so list
	// rows can show a "syncing" indicator (Phase 3).
	AlignmentStatus string `json:"alignmentStatus"`
```

Change `songSelect` to add the join + column (column appended LAST so existing scans that don't read it are unaffected only where updated — but we update scanSong, so append after `is_published`):

```go
const songSelect = `SELECT s.id, s.title, s.artist_id, a.name, s.album, s.year, s.track_no,
	s.duration_ms, s.file_path, s.file_size, s.content_hash, s.cover_art_id, s.lyrics, s.created_at, s.is_published,
	COALESCE(al.status, '') AS alignment_status
	FROM songs s JOIN artists a ON a.id = s.artist_id
	LEFT JOIN song_alignment al ON al.song_id = s.id`
```

In `scanSong`, scan the trailing column:

```go
func scanSong(row scanner) (*Song, error) {
	var s Song
	var album, cover, lyrics sql.NullString
	var year, track sql.NullInt64
	var published int64
	if err := row.Scan(&s.ID, &s.Title, &s.ArtistID, &s.ArtistName, &album, &year, &track,
		&s.DurationMS, &s.FilePath, &s.FileSize, &s.ContentHash, &cover, &lyrics, &s.CreatedAt, &published,
		&s.AlignmentStatus); err != nil {
		return nil, err
	}
	// ... unchanged tail ...
```

In `plays.go`, add the join to `topTenSelect` and the column before `COUNT(...)`:

```go
const topTenSelect = `SELECT s.id, s.title, s.artist_id, a.name, s.album, s.year, s.track_no,
	s.duration_ms, s.file_path, s.file_size, s.content_hash, s.cover_art_id, s.created_at, s.is_published,
	COALESCE(al.status, '') AS alignment_status,
	COUNT(p.id) AS play_count
	FROM songs s JOIN artists a ON a.id = s.artist_id JOIN plays p ON p.song_id = s.id
	LEFT JOIN song_alignment al ON al.song_id = s.id%s
	GROUP BY s.id
	ORDER BY play_count DESC, lower(s.title) ASC, s.id ASC
	LIMIT 10`
```

And in `scanSongWithCount`, scan `&s.AlignmentStatus` before `count`:

```go
	if err := row.Scan(&s.ID, &s.Title, &s.ArtistID, &s.ArtistName, &album, &year, &track,
		&s.DurationMS, &s.FilePath, &s.FileSize, &s.ContentHash, &cover, &s.CreatedAt, &published,
		&s.AlignmentStatus, count); err != nil {
		return nil, err
	}
```

(Note: `topTenSelect` does not select `lyrics`; that is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/library/ -v`
Expected: PASS (all library tests, incl. the new one and existing top-ten/list tests).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/library/songs.go backend/internal/library/plays.go backend/internal/library/songs_test.go
git commit -m "feat(karaoke): surface alignmentStatus on the Song payload"
```

---

## Task 2: Serialized alignment queue (claim-at-enqueue, single worker)

**Files:**
- Modify: `backend/internal/httpapi/alignment.go` (add job type, `enqueueAlignment`, `alignWorker`; rewire `postAlign`)
- Modify: `backend/internal/httpapi/server.go` (init the channel + start one worker, ~L126/L149)
- Modify: `backend/internal/httpapi/handlers.go` OR wherever `songHandlers` is defined (add `alignQueue` field — grep `type songHandlers struct`)
- Test: `backend/internal/httpapi/alignment_test.go` (add serialization test)

**Interfaces:**
- Produces: `func (h *songHandlers) enqueueAlignment(ctx context.Context, songID, relPath, lyrics string) (started bool, err error)` — no-ops (returns `false,nil`) when aligner is nil, lyrics blank, or a job is already generating; otherwise claims the row (`StartAlignment`) and hands the job to the single worker. Callers: `postAlign`, `upload`, `patch`.
- Produces: `func (h *songHandlers) alignWorker()` — drains `h.alignQueue`, runs one `runAlignment` at a time.

- [ ] **Step 1: Write the failing test**

Add to `backend/internal/httpapi/alignment_test.go`. Use the existing test harness for `songHandlers` with a stub aligner (grep the file for how `aligner` is stubbed today). The stub must block so we can observe concurrency:

```go
// A stub aligner that records the maximum number of concurrent Align calls and
// blocks each call until released, so the test can prove one-at-a-time execution.
type serialSpyAligner struct {
	mu       sync.Mutex
	inFlight int
	maxSeen  int
	release  chan struct{}
}

func (s *serialSpyAligner) Align(ctx context.Context, audio io.Reader, filename, lyrics string) (*align.Result, error) {
	s.mu.Lock()
	s.inFlight++
	if s.inFlight > s.maxSeen {
		s.maxSeen = s.inFlight
	}
	s.mu.Unlock()
	<-s.release // block until the test lets this job finish
	s.mu.Lock()
	s.inFlight--
	s.mu.Unlock()
	return &align.Result{Engine: "stub", Lines: []align.Line{}}, nil
}

func TestAlignQueue_RunsOneAtATime(t *testing.T) {
	spy := &serialSpyAligner{release: make(chan struct{})}
	h := newTestSongHandlers(t, spy) // match existing helper; wires repo/media/aligner + starts the worker
	ctx := context.Background()

	// Seed 3 songs with lyrics + a resolvable file. Enqueue all three.
	ids := seedThreeAlignableSongs(t, h) // helper: returns []string of song IDs
	for _, id := range ids {
		song, _ := h.repo.GetByID(ctx, id)
		started, err := h.enqueueAlignment(ctx, song.ID, song.FilePath, song.Lyrics)
		if err != nil || !started {
			t.Fatalf("enqueue %s: started=%v err=%v", id, started, err)
		}
	}

	// Give the worker a moment to pick up jobs; only ONE may be in flight.
	waitFor(t, func() bool { spy.mu.Lock(); defer spy.mu.Unlock(); return spy.inFlight == 1 })
	spy.mu.Lock()
	if spy.maxSeen != 1 {
		spy.mu.Unlock()
		t.Fatalf("expected serial execution, maxSeen=%d", spy.maxSeen)
	}
	spy.mu.Unlock()

	// Release all three; they should complete without ever exceeding 1 in flight.
	close(spy.release)
	waitFor(t, func() bool {
		a, _ := h.repo.GetAlignment(ctx, ids[2])
		return a != nil && a.Status == "ready"
	})
	if spy.maxSeen != 1 {
		t.Fatalf("serialization violated, maxSeen=%d", spy.maxSeen)
	}
}
```

If `newTestSongHandlers`/`seedThreeAlignableSongs`/`waitFor` do not exist, add small helpers in the test file (a `waitFor` that polls up to ~2s with a short sleep; a seed helper that writes a real tiny MP3 into the media store used by existing alignment tests — reuse the fixture path those tests already use).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/httpapi/ -run TestAlignQueue_RunsOneAtATime -v`
Expected: FAIL (`enqueueAlignment` undefined).

- [ ] **Step 3: Implement**

In the `songHandlers` struct definition, add:

```go
	alignQueue chan alignJob
```

In `alignment.go`, add the job type + funnel + worker, and rewire `postAlign`:

```go
type alignJob struct {
	songID  string
	relPath string
	lyrics  string
}

// enqueueAlignment is the single funnel every trigger (manual, import, save) uses.
// It claims the alignment slot synchronously (so the row flips to generating and
// 202/409 semantics hold) then hands the job to the one serial worker. It no-ops
// on a disabled aligner, blank lyrics, or a slot already generating.
func (h *songHandlers) enqueueAlignment(ctx context.Context, songID, relPath, lyrics string) (bool, error) {
	if h.aligner == nil || strings.TrimSpace(lyrics) == "" {
		return false, nil
	}
	started, err := h.repo.StartAlignment(ctx, songID)
	if err != nil || !started {
		return started, err
	}
	// Send on a goroutine so a full buffer can never block an HTTP handler; the
	// row is already claimed, so the job is guaranteed to run when the worker
	// reaches it. The single worker still executes jobs strictly one at a time.
	go func() { h.alignQueue <- alignJob{songID: songID, relPath: relPath, lyrics: lyrics} }()
	return true, nil
}

// alignWorker drains the queue, running exactly one alignment at a time. Each
// runAlignment recovers its own panic, so one bad job cannot kill the worker.
func (h *songHandlers) alignWorker() {
	for job := range h.alignQueue {
		h.runAlignment(job.songID, job.relPath, job.lyrics)
	}
}
```

Rewrite the tail of `postAlign` (replace the `StartAlignment` + `go h.runAlignment(...)` block) with:

```go
	started, err := h.enqueueAlignment(r.Context(), song.ID, song.FilePath, song.Lyrics)
	if err != nil {
		serverError(w, "start alignment", err)
		return
	}
	if !started {
		httpError(w, http.StatusConflict, "alignment already in progress")
		return
	}
	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, map[string]any{"status": "generating"})
```

Add `"strings"` to the imports if not present.

In `server.go`, initialize the channel in the `songHandlers` literal and start one worker after the reaper calls:

```go
	h := &songHandlers{
		// ... existing fields ...
		alignQueue: make(chan alignJob, 1024),
	}
	// ... existing reaper calls ...
	go h.alignWorker() // single serial worker in front of the one-at-a-time sidecar
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/httpapi/ -run 'TestAlign|TestPostAlign|TestGetAlign' -v`
Expected: PASS (serialization test + existing align endpoint tests, incl. the existing full upload→POST→poll-to-ready wiring test).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/httpapi/alignment.go backend/internal/httpapi/server.go backend/internal/httpapi/*.go
git commit -m "feat(karaoke): serialized alignment queue with one worker"
```

---

## Task 3: Server-side triggers (import + lyrics-save)

**Files:**
- Modify: `backend/internal/httpapi/songs.go` (`upload` handler, after `Create` ~L195-206)
- Modify: `backend/internal/httpapi/tags.go` (`patch` handler, after `Update` ~L48-55)
- Test: `backend/internal/httpapi/alignment_test.go` (add two tests)

**Interfaces:**
- Consumes: `enqueueAlignment` (Task 2). Both triggers are best-effort (log on error, never fail the request).

- [ ] **Step 1: Write the failing tests**

```go
func TestImport_TriggersAlignmentWhenEmbeddedLyrics(t *testing.T) {
	spy := &serialSpyAligner{release: make(chan struct{})}
	srv := newTestServer(t, spy) // assembled server/mux with the stub aligner + a media store
	// Upload an MP3 that already carries embedded USLT lyrics (reuse a fixture with lyrics).
	song := uploadFixture(t, srv, "with_lyrics.mp3")
	// The alignment row should be claimed (generating) right after import.
	waitFor(t, func() bool {
		a, _ := srv.repo.GetAlignment(context.Background(), song.ID)
		return a != nil && a.Status == "generating"
	})
}

func TestImport_NoTriggerWhenNoLyrics(t *testing.T) {
	spy := &serialSpyAligner{release: make(chan struct{})}
	srv := newTestServer(t, spy)
	song := uploadFixture(t, srv, "no_lyrics.mp3")
	// No lyrics -> no alignment row ever appears.
	time.Sleep(150 * time.Millisecond)
	a, _ := srv.repo.GetAlignment(context.Background(), song.ID)
	if a != nil {
		t.Fatalf("expected no alignment row, got status=%q", a.Status)
	}
}

func TestSave_TriggersOnChangedNonEmptyLyrics(t *testing.T) {
	spy := &serialSpyAligner{release: make(chan struct{})}
	srv := newTestServer(t, spy)
	song := uploadFixture(t, srv, "no_lyrics.mp3")

	// PATCH with new non-empty lyrics -> triggers.
	patchLyrics(t, srv, song.ID, "la la la\nsecond line")
	waitFor(t, func() bool {
		a, _ := srv.repo.GetAlignment(context.Background(), song.ID)
		return a != nil && a.Status == "generating"
	})
}

func TestSave_NoTriggerWhenLyricsUnchangedOrCleared(t *testing.T) {
	spy := &serialSpyAligner{release: make(chan struct{})}
	srv := newTestServer(t, spy)
	song := uploadFixture(t, srv, "with_lyrics.mp3") // triggers once on import
	waitFor(t, func() bool {
		a, _ := srv.repo.GetAlignment(context.Background(), song.ID)
		return a != nil && a.Status == "generating"
	})
	close(spy.release) // let import job finish -> ready
	waitFor(t, func() bool {
		a, _ := srv.repo.GetAlignment(context.Background(), song.ID)
		return a != nil && a.Status == "ready"
	})

	// PATCH with the SAME lyrics -> no re-trigger (stays ready).
	patchLyrics(t, srv, song.ID, song.Lyrics)
	time.Sleep(150 * time.Millisecond)
	a, _ := srv.repo.GetAlignment(context.Background(), song.ID)
	if a.Status != "ready" {
		t.Fatalf("unchanged lyrics should not re-trigger, status=%q", a.Status)
	}

	// PATCH clearing lyrics -> no trigger.
	patchLyrics(t, srv, song.ID, "")
	time.Sleep(150 * time.Millisecond)
	a, _ = srv.repo.GetAlignment(context.Background(), song.ID)
	if a.Status == "generating" {
		t.Fatalf("clearing lyrics must not trigger alignment")
	}
}
```

Add `newTestServer`/`uploadFixture`/`patchLyrics` helpers if absent, reusing the existing assembled-server test harness in `server_test.go` (grep for how upload→POST→poll tests build the server). Add fixtures `with_lyrics.mp3` / `no_lyrics.mp3` under the existing metadata/httpapi testdata dir if not already present (reuse the Phase 1/2 lyrics fixtures if they exist).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/httpapi/ -run 'TestImport|TestSave' -v`
Expected: FAIL (no trigger wired yet).

- [ ] **Step 3: Implement**

In `songs.go` `upload`, after the song is created (after the `Create` call returns `song`), add:

```go
	// Karaoke: a freshly imported file that already carries lyrics gets aligned in
	// the background (best-effort; never fail the upload). Files without embedded
	// lyrics are not aligned — alignment is meaningless without words.
	if strings.TrimSpace(tags.Lyrics) != "" {
		if _, err := h.enqueueAlignment(r.Context(), song.ID, song.FilePath, tags.Lyrics); err != nil {
			slog.Warn("karaoke: import alignment enqueue failed", "song", song.ID, "err", err)
		}
	}
```

In `tags.go` `patch`, after `updated` is returned from `h.repo.Update`, add:

```go
	// Karaoke: a changed, non-empty Lyrics value re-syncs in the background (covers
	// "file had no lyrics, added later"). Unchanged or cleared lyrics never trigger.
	if newLyrics := strings.TrimSpace(req.Lyrics); newLyrics != "" && req.Lyrics != song.Lyrics {
		if _, err := h.enqueueAlignment(r.Context(), song.ID, song.FilePath, req.Lyrics); err != nil {
			slog.Warn("karaoke: save alignment enqueue failed", "song", song.ID, "err", err)
		}
	}
```

Add `"strings"` / `"log/slog"` imports where missing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/httpapi/ -run 'TestImport|TestSave' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/httpapi/songs.go backend/internal/httpapi/tags.go backend/internal/httpapi/alignment_test.go backend/internal/httpapi/testdata
git commit -m "feat(karaoke): trigger alignment on import and lyrics save"
```

---

## Task 4: Custom SYLT id3v2 frame

**Files:**
- Create: `backend/internal/metadata/sylt.go`
- Test: `backend/internal/metadata/sylt_test.go`

**Interfaces:**
- Produces: `type SyncedWord struct { Text string; TimeMs uint32 }` — `Text` includes a leading `"\n"` for a line's first word.
- Produces: `func NewSyncedLyricsFrame(language string, words []SyncedWord) id3v2.Framer` — a SYLT frame (UTF-16+BOM, ms timestamps, content type = lyrics). `Size()` equals the exact `WriteTo` byte count.

- [ ] **Step 1: Write the failing test**

Create `backend/internal/metadata/sylt_test.go`:

```go
package metadata

import (
	"bytes"
	"os"
	"testing"

	id3v2 "github.com/bogem/id3v2/v2"
)

func TestSyncedLyricsFrame_SizeMatchesWriteTo(t *testing.T) {
	cases := [][]SyncedWord{
		{},
		{{Text: "\nNever", TimeMs: 12000}, {Text: " gonna", TimeMs: 12400}},
		{{Text: "\nRésumé café", TimeMs: 1000}, {Text: " naïve", TimeMs: 2000}}, // multibyte
		{{Text: "\n日本語", TimeMs: 3000}},                                        // non-latin
	}
	for i, words := range cases {
		f := NewSyncedLyricsFrame("eng", words)
		var buf bytes.Buffer
		n, err := f.WriteTo(&buf)
		if err != nil {
			t.Fatalf("case %d WriteTo: %v", i, err)
		}
		if int(n) != f.Size() {
			t.Fatalf("case %d: WriteTo wrote %d bytes but Size()=%d", i, n, f.Size())
		}
		if buf.Len() != f.Size() {
			t.Fatalf("case %d: buffer len %d != Size() %d", i, buf.Len(), f.Size())
		}
	}
}

func TestSyncedLyricsFrame_RoundTripParsesClean(t *testing.T) {
	// Stamp a SYLT frame into a real MP3 and re-open it with bogem: it must parse
	// without error and preserve other frames (title).
	src := "testdata/sample.mp3" // reuse an existing tiny MP3 fixture in this package
	dst := t.TempDir() + "/out.mp3"
	if err := copyFile(src, dst); err != nil {
		t.Fatal(err)
	}
	tag, err := id3v2.Open(dst, id3v2.Options{Parse: true})
	if err != nil {
		t.Fatal(err)
	}
	tag.SetTitle("Round Trip")
	tag.AddFrame("SYLT", NewSyncedLyricsFrame("eng", []SyncedWord{
		{Text: "\nHello", TimeMs: 1000}, {Text: " world", TimeMs: 1500},
	}))
	if err := tag.Save(); err != nil {
		t.Fatal(err)
	}
	tag.Close()

	reopened, err := id3v2.Open(dst, id3v2.Options{Parse: true})
	if err != nil {
		t.Fatalf("re-open after SYLT stamp failed to parse: %v", err)
	}
	defer reopened.Close()
	if reopened.Title() != "Round Trip" {
		t.Fatalf("title frame lost after SYLT stamp: %q", reopened.Title())
	}
	if _, err := os.Stat(dst); err != nil {
		t.Fatal(err)
	}
}
```

(If `testdata/sample.mp3` does not exist in the metadata package, reuse whichever tiny MP3 fixture `write_test.go` / `mp3_test.go` already loads — grep those tests for the path and use it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && go test ./internal/metadata/ -run TestSyncedLyricsFrame -v`
Expected: FAIL (`NewSyncedLyricsFrame`/`SyncedWord` undefined).

- [ ] **Step 3: Implement**

Create `backend/internal/metadata/sylt.go`:

```go
package metadata

import (
	"bytes"
	"encoding/binary"
	"io"
	"unicode/utf16"

	id3v2 "github.com/bogem/id3v2/v2"
)

// SyncedWord is one timed lyric fragment for a SYLT frame. Text carries a leading
// "\n" when it starts a new lyric line (the ID3 convention for line breaks).
type SyncedWord struct {
	Text   string
	TimeMs uint32
}

// syncedLyricsFrame implements id3v2.Framer for the SYLT (synchronised lyrics)
// frame, which bogem/id3v2 v2.1.4 does not provide. Encoding is UTF-16 with a BOM
// (encoding byte 0x01, two-byte terminators) so arbitrary lyrics survive without
// requiring a v2.4 tag. Timestamps are absolute milliseconds (format 0x02),
// content type "lyrics" (0x01). Size() and WriteTo() both build from encodeUTF16,
// so the declared size can never drift from the emitted bytes.
type syncedLyricsFrame struct {
	language string
	words    []SyncedWord
}

// NewSyncedLyricsFrame returns a SYLT frame; add it via tag.AddFrame("SYLT", f).
func NewSyncedLyricsFrame(language string, words []SyncedWord) id3v2.Framer {
	if language == "" {
		language = "eng"
	}
	return syncedLyricsFrame{language: language, words: words}
}

// encodeUTF16 returns s as UTF-16LE with a leading BOM, followed by the two-byte
// UTF-16 terminator. Used for both the descriptor and every sync-text fragment.
func encodeUTF16(s string) []byte {
	units := utf16.Encode([]rune(s))
	b := make([]byte, 0, 2+len(units)*2+2)
	b = append(b, 0xFF, 0xFE) // BOM (little-endian)
	for _, u := range units {
		b = append(b, byte(u), byte(u>>8))
	}
	b = append(b, 0x00, 0x00) // UTF-16 terminator
	return b
}

func (f syncedLyricsFrame) header() []byte {
	// encoding(1) + language(3) + timeFormat(1) + contentType(1) + descriptor(term).
	h := []byte{0x01}
	h = append(h, []byte(f.language)...)
	h = append(h, 0x02, 0x01) // ms timestamps, content type = lyrics
	h = append(h, encodeUTF16("")...)
	return h
}

func (f syncedLyricsFrame) Size() int {
	n := len(f.header())
	for _, w := range f.words {
		n += len(encodeUTF16(w.Text)) + 4 // text+term + uint32 timestamp
	}
	return n
}

// UniqueIdentifier keys the frame; one SYLT per (language, descriptor) is used and
// the descriptor is empty, so language alone is unique.
func (f syncedLyricsFrame) UniqueIdentifier() string { return f.language }

func (f syncedLyricsFrame) WriteTo(w io.Writer) (int64, error) {
	if len(f.language) != 3 {
		return 0, id3v2.ErrInvalidLanguageLength
	}
	var buf bytes.Buffer
	buf.Write(f.header())
	var ts [4]byte
	for _, wd := range f.words {
		buf.Write(encodeUTF16(wd.Text))
		binary.BigEndian.PutUint32(ts[:], wd.TimeMs)
		buf.Write(ts[:])
	}
	n, err := w.Write(buf.Bytes())
	return int64(n), err
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && go test ./internal/metadata/ -run TestSyncedLyricsFrame -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/internal/metadata/sylt.go backend/internal/metadata/sylt_test.go
git commit -m "feat(karaoke): custom SYLT id3v2 frame writer"
```

---

## Task 5: Bake SYLT into downloads

**Files:**
- Modify: `backend/internal/metadata/write.go` (`WriteableTags` struct + `WriteTags` SYLT block)
- Modify: `backend/internal/httpapi/songs.go` (`songTags` ~L337 — build `Synced` from the alignment row)
- Test: `backend/internal/metadata/write_lyrics_test.go` (or a new `write_sylt_test.go`), `backend/internal/httpapi/tags_test.go`

**Interfaces:**
- Consumes: `NewSyncedLyricsFrame`, `SyncedWord` (Task 4); `repo.GetAlignment` (existing); `align.Line`/`align.Word` (existing).
- Produces: `WriteableTags.Synced []SyncedWord` — when non-empty, `WriteTags` writes a SYLT frame (delete-then-set).

- [ ] **Step 1: Write the failing tests**

In `backend/internal/metadata/write_sylt_test.go`:

```go
package metadata

import (
	"testing"

	id3v2 "github.com/bogem/id3v2/v2"
)

func TestWriteTags_WritesSYLTWhenSynced(t *testing.T) {
	src := "testdata/sample.mp3" // same fixture as sylt_test.go
	dst := t.TempDir() + "/out.mp3"
	err := StampTags(src, dst, WriteableTags{
		Title:  "T",
		Artist: "A",
		Lyrics: "Hello world",
		Synced: []SyncedWord{{Text: "\nHello", TimeMs: 1000}, {Text: " world", TimeMs: 1500}},
	})
	if err != nil {
		t.Fatal(err)
	}
	tag, err := id3v2.Open(dst, id3v2.Options{Parse: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tag.Close()
	if frames := tag.GetFrames("SYLT"); len(frames) != 1 {
		t.Fatalf("want exactly 1 SYLT frame, got %d", len(frames))
	}
	// USLT (plain lyrics) still present alongside SYLT.
	if tag.GetLastFrame(tag.CommonID("Unsynchronised lyrics/text transcription")) == nil {
		t.Fatalf("USLT frame missing")
	}
}

func TestWriteTags_NoSYLTWhenEmpty(t *testing.T) {
	src := "testdata/sample.mp3"
	dst := t.TempDir() + "/out.mp3"
	if err := StampTags(src, dst, WriteableTags{Title: "T", Artist: "A"}); err != nil {
		t.Fatal(err)
	}
	tag, _ := id3v2.Open(dst, id3v2.Options{Parse: true})
	defer tag.Close()
	if frames := tag.GetFrames("SYLT"); len(frames) != 0 {
		t.Fatalf("want no SYLT frame, got %d", len(frames))
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && go test ./internal/metadata/ -run TestWriteTags_.*SYLT -v`
Expected: FAIL (`Synced` field undefined).

- [ ] **Step 3: Implement**

In `write.go`, add to `WriteableTags`:

```go
	// Synced, when non-empty, is baked as a SYLT (synchronised lyrics) frame — the
	// karaoke word timings. Empty leaves no SYLT frame. Set only at download time.
	Synced []SyncedWord
```

In `WriteTags`, after the USLT block (before the cover block), add:

```go
	// Delete-then-set SYLT (like USLT/cover) so repeated stamps never duplicate and
	// cleared timings don't linger.
	tag.DeleteFrames("SYLT")
	if len(t.Synced) > 0 {
		tag.AddFrame("SYLT", NewSyncedLyricsFrame("eng", t.Synced))
	}
```

In `httpapi/songs.go` `songTags`, before `return t`, fetch the alignment and populate `Synced`:

```go
	// Karaoke: bake word timings into a SYLT frame when the song is aligned. Best
	// effort — any failure just omits SYLT so the download still succeeds.
	if a, err := h.repo.GetAlignment(ctx, s.ID); err == nil && a != nil && a.Status == "ready" {
		if words := syltWords(a.Data); len(words) > 0 {
			t.Synced = words
		}
	}
```

Add a helper in `songs.go` (or a small `alignment` helper file in the package):

```go
// syltWords flattens stored alignment line JSON into SYLT sync entries, one per
// word, prefixing each line's first word with "\n" so players render line breaks.
func syltWords(data string) []metadata.SyncedWord {
	var lines []align.Line
	if err := json.Unmarshal([]byte(data), &lines); err != nil {
		return nil
	}
	var out []metadata.SyncedWord
	for _, ln := range lines {
		for i, wd := range ln.Words {
			text := wd.W
			if i == 0 {
				text = "\n" + wd.W
			} else {
				text = " " + wd.W
			}
			ms := uint32(wd.Start * 1000)
			out = append(out, metadata.SyncedWord{Text: text, TimeMs: ms})
		}
	}
	return out
}
```

Ensure `songs.go` imports `align`, `json`, and `metadata` (metadata already imported). If `align` import would be unused elsewhere, it's used here.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && go test ./internal/metadata/ ./internal/httpapi/ -run 'SYLT|Download|Tags' -v`
Expected: PASS. Then full backend: `cd backend && go test ./...` → all green.

- [ ] **Step 5: Manual round-trip check (out-of-band, once)**

After a real alignment exists (Task 12 smoke), download the MP3 and confirm the SYLT frame with:

```bash
ffprobe -hide_banner -show_entries stream_tags:format_tags <downloaded>.mp3 2>&1 | grep -i sync || true
# or: pip install mutagen && python -c "from mutagen.id3 import ID3; print([k for k in ID3('f.mp3').keys() if k.startswith('SYLT')])"
```

Expected: a `SYLT` frame present. (Documented as manual; not part of the Go suite.)

- [ ] **Step 6: Commit**

```bash
git add backend/internal/metadata/write.go backend/internal/metadata/write_sylt_test.go backend/internal/httpapi/songs.go
git commit -m "feat(karaoke): bake SYLT synchronised lyrics into downloads"
```

---

## Task 6: Frontend API — alignment types + helpers

**Files:**
- Modify: `ui/src/api.ts` (add `alignmentStatus` to `Song`, add `AlignmentData`/`getAlign`/`postAlign`)
- Test: `ui/src/api.test.ts`

**Interfaces:**
- Produces:
  - `Song.alignmentStatus?: "" | "generating" | "ready" | "failed"`
  - `type AlignedWord = { w: string; start: number; end: number; conf: number }`
  - `type AlignedLine = { text: string; start: number; end: number; words: AlignedWord[] }`
  - `type AlignmentData = { status: string; engine?: string; lines?: AlignedLine[] }`
  - `async function getAlign(id: string): Promise<AlignmentData | null>` — `null` on 404 (never requested)
  - `async function postAlign(id: string): Promise<void>` — resolves on 202; swallows 400/404/409 quietly (empty-lyrics/disabled/already-running are non-errors for the caller)

- [ ] **Step 1: Write the failing test**

Add to `ui/src/api.test.ts` (match the existing fetch-mock style in that file):

```ts
import { getAlign, postAlign } from "./api";

test("getAlign returns null on 404", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
  expect(await getAlign("s1")).toBeNull();
});

test("getAlign parses ready payload", async () => {
  const body = { status: "ready", engine: "e", lines: [{ text: "hi", start: 1, end: 2, words: [] }] };
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  const a = await getAlign("s1");
  expect(a?.status).toBe("ready");
  expect(a?.lines?.[0].text).toBe("hi");
});

test("postAlign resolves on 202 and swallows 409", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 202 }));
  await expect(postAlign("s1")).resolves.toBeUndefined();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 409 }));
  await expect(postAlign("s1")).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/api.test.ts`
Expected: FAIL (`getAlign`/`postAlign` not exported).

- [ ] **Step 3: Implement**

In `ui/src/api.ts`, add `alignmentStatus?: "" | "generating" | "ready" | "failed";` to the `Song` type, and append:

```ts
export type AlignedWord = { w: string; start: number; end: number; conf: number };
export type AlignedLine = { text: string; start: number; end: number; words: AlignedWord[] };
export type AlignmentData = { status: string; engine?: string; lines?: AlignedLine[] };

// getAlign polls a song's karaoke alignment. Returns null when none was ever
// requested (404), so callers can distinguish "never synced" from a real error.
export async function getAlign(id: string): Promise<AlignmentData | null> {
  const r = await fetch(`/api/songs/${id}/align`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`align status failed (${r.status})`);
  return r.json();
}

// postAlign requests karaoke generation. 202 = started. 400/404/409 are quiet
// non-errors (no lyrics / disabled / already running) — nothing for the UI to do.
export async function postAlign(id: string): Promise<void> {
  const r = await fetch(`/api/songs/${id}/align`, { method: "POST" });
  if (r.status === 202 || r.status === 400 || r.status === 404 || r.status === 409) return;
  if (!r.ok) throw new Error(`align request failed (${r.status})`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api.ts ui/src/api.test.ts
git commit -m "feat(karaoke): frontend alignment types + getAlign/postAlign"
```

---

## Task 7: Expose the audio element from the player

**Files:**
- Modify: `ui/src/player.ts` (add `getAudioElement` to the `player` object + `usePlayer` return)
- Test: none (side-effecting singleton is Playwright-verified; folded into Task 9)

**Interfaces:**
- Produces: `player.getAudioElement(): HTMLAudioElement | null` — the live element, or null before any track loaded.

- [ ] **Step 1: Implement**

In `ui/src/player.ts`, add to the `player` object (near `getState`):

```ts
  // getAudioElement exposes the live <audio> for the karaoke view's own rAF loop,
  // which reads currentTime at 60fps — far finer than the throttled positionMs.
  getAudioElement(): HTMLAudioElement | null {
    return audio;
  },
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/player.ts
git commit -m "feat(karaoke): expose the audio element for the sweep loop"
```

---

## Task 8: KaraokeView component (the sweep)

**Files:**
- Create: `ui/src/KaraokeView.tsx`
- Reference: `docs/mockups/karaoke/player_integration.py` (exact motion/CSS being ported)
- Test: Playwright (Task 9); a light Vitest render smoke here.

**Interfaces:**
- Consumes: `player.getAudioElement` (Task 7); `AlignedLine` (Task 6).
- Produces: `export function KaraokeView({ lines }: { lines: AlignedLine[] }): JSX.Element` — renders the sweep; runs its own rAF loop; no props change per frame.

- [ ] **Step 1: Write the render smoke test**

Create `ui/src/KaraokeView.test.tsx`:

```tsx
import { render } from "@testing-library/react";
import { KaraokeView } from "./KaraokeView";

test("renders each line's words as base text", () => {
  const lines = [
    { text: "hello world", start: 1, end: 2, words: [
      { w: "hello", start: 1, end: 1.4, conf: 0.9 },
      { w: "world", start: 1.4, end: 2, conf: 0.9 },
    ] },
  ];
  const { container } = render(<KaraokeView lines={lines} />);
  expect(container.textContent).toContain("hello");
  expect(container.textContent).toContain("world");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/KaraokeView.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** — port the mock's JS/CSS to React (DOM refs + rAF, not React state):

```tsx
import { useEffect, useRef } from "react";
import { player } from "./player";
import type { AlignedLine } from "./api";

const LEAD = 0.6;
const MAX_SWEEP = 1.2;

type WordBox = { left: number; right: number; s: number; e: number };
type LineRt = { el: HTMLDivElement; fill: HTMLSpanElement; wordSpans: HTMLSpanElement[]; wl: AlignedLine["words"]; words: WordBox[]; lineW: number; on?: boolean };

// KaraokeView renders the Apple-Music-style continuous per-line sweep. It measures
// word x-positions after layout, then a single requestAnimationFrame loop reads the
// live <audio> currentTime and writes fill-widths, per-line dim/blur, and the eased
// auto-scroll straight to the DOM — never through React state (which can't keep 60fps).
export function KaraokeView({ lines }: { lines: AlignedLine[] }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<LineRt[]>([]);

  useEffect(() => {
    const inner = innerRef.current;
    const stage = stageRef.current;
    if (!inner || !stage) return;
    const L = lineRefs.current;

    // activateAt[i]: when line i takes focus — LEAD before its first word, clamped
    // past the previous line's end so we never jump back.
    const activateAt = lines.map((ln, i) => {
      if (ln.start == null) return Infinity;
      if (i === 0) return 0;
      const pe = lines[i - 1]?.end != null ? lines[i - 1].end : ln.start - LEAD;
      return Math.max(ln.start - LEAD, pe);
    });

    function measure() {
      for (const l of L) {
        const n = l.wordSpans.length;
        l.words = [];
        for (let i = 0; i < n; i++) {
          const sp = l.wordSpans[i];
          const left = sp.offsetLeft;
          const right = i + 1 < n ? l.wordSpans[i + 1].offsetLeft : left + sp.offsetWidth;
          l.words.push({ left, right, s: +l.wl[i].start, e: +l.wl[i].end });
        }
        l.lineW = l.words.length ? l.words[l.words.length - 1].right : 0;
      }
    }

    function frontX(l: LineRt, t: number): number {
      const ws = l.words;
      if (!ws.length) return 0;
      if (t < ws[0].s) return 0;
      let x = 0;
      for (const w of ws) {
        const se = w.s + Math.min(w.e - w.s, MAX_SWEEP);
        if (t >= se) x = w.right;
        else if (t >= w.s) return w.left + ((t - w.s) / (se - w.s)) * (w.right - w.left);
        else return x;
      }
      return x;
    }

    let raf = 0;
    let lastActive = -2;
    function frame() {
      const audio = player.getAudioElement();
      const t = audio ? audio.currentTime : 0;
      let active = -1;
      for (let i = 0; i < lines.length; i++) if (t >= activateAt[i]) active = i;
      L.forEach((l, i) => {
        const on = i === active;
        if (l.on !== on) {
          l.el.classList.toggle("kv-active", on);
          l.fill.classList.toggle("kv-sweeping", on);
          l.on = on;
        }
        if (!on) {
          const dist = Math.abs(i - (active < 0 ? 0 : active));
          l.el.style.opacity = Math.max(0.1, 0.48 - dist * 0.1).toFixed(2);
          l.el.style.filter = "blur(" + Math.min(7, 1 + dist * 1.5).toFixed(1) + "px)";
        } else {
          l.el.style.opacity = "";
          l.el.style.filter = "";
        }
        let x: number;
        if (i < active) x = l.lineW;
        else if (i > active) x = 0;
        else x = frontX(l, t);
        l.fill.style.width = x + "px";
      });
      if (active !== lastActive && inner) {
        const el = L[active < 0 ? 0 : active]?.el;
        if (el) inner.style.transform = "translateY(" + (window.innerHeight * 0.4 - (el.offsetTop + el.offsetHeight / 2)) + "px)";
        lastActive = active;
      }
      raf = requestAnimationFrame(frame);
    }

    function start() {
      measure();
      const el = L[0]?.el;
      if (el && inner) inner.style.transform = "translateY(" + (window.innerHeight * 0.4 - (el.offsetTop + el.offsetHeight / 2)) + "px)";
      raf = requestAnimationFrame(frame);
    }
    const onResize = () => { measure(); lastActive = -2; };
    window.addEventListener("resize", onResize);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(start);
    else raf = requestAnimationFrame(start);

    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
  }, [lines]);

  lineRefs.current = [];
  return (
    <>
      <style>{KV_CSS}</style>
      <div ref={stageRef} className="kv-stage">
        <div ref={innerRef} className="kv-inner">
          {lines.map((ln, li) => (
            <LineRow key={li} line={ln} register={(rt) => (lineRefs.current[li] = rt)} />
          ))}
        </div>
      </div>
    </>
  );
}

function LineRow({ line, register }: { line: AlignedLine; register: (rt: LineRt) => void }) {
  const elRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const wordRefs = useRef<HTMLSpanElement[]>([]);
  const wl = line.words ?? [];
  useEffect(() => {
    if (elRef.current && fillRef.current) {
      register({ el: elRef.current, fill: fillRef.current, wordSpans: wordRefs.current, wl, words: [], lineW: 0 });
    }
  });
  wordRefs.current = [];
  return (
    <div ref={elRef} className="kv-line">
      <div className="kv-lc">
        <span className="kv-base">
          {wl.length ? wl.map((w, i) => (
            <span key={i}>
              <span ref={(el) => { if (el) wordRefs.current[i] = el; }}>{w.w}</span>
              {i < wl.length - 1 ? " " : ""}
            </span>
          )) : (line.text || " ")}
        </span>
        <span ref={fillRef} className="kv-fill">
          {wl.length ? wl.map((w, i) => (
            <span key={i}>{w.w}{i < wl.length - 1 ? " " : ""}</span>
          )) : (line.text || " ")}
        </span>
      </div>
    </div>
  );
}

// Ported verbatim from docs/mockups/karaoke/player_integration.py, themed to loom
// tokens (var(--color-*) / var(--font-serif)).
const KV_CSS = `
.kv-stage { position:relative; z-index:2; height:100%; overflow:hidden;
  -webkit-mask-image: linear-gradient(180deg, transparent 0, #000 20%, #000 66%, transparent 92%);
  mask-image: linear-gradient(180deg, transparent 0, #000 20%, #000 66%, transparent 92%); }
.kv-inner { position:absolute; left:0; right:0; padding:0 max(24px, 8vw);
  transition: transform .55s cubic-bezier(.22,.61,.20,1); will-change: transform; }
.kv-line { padding:14px 0; opacity:.28; filter: blur(3px); transform: scale(.96); transform-origin:left center;
  transition: opacity .45s ease, filter .45s ease, transform .45s cubic-bezier(.22,.61,.2,1); }
.kv-line.kv-active { opacity:1; filter: blur(0); transform: scale(1.02); }
.kv-lc { position:relative; display:inline-block; white-space:nowrap;
  font-family:var(--font-serif); font-size: clamp(24px,3.9vw,46px); font-weight:700; line-height:1.22; letter-spacing:-.01em; }
.kv-base { color: rgba(250,249,245,.22); }
.kv-fill { position:absolute; left:0; top:0; height:100%; width:0; overflow:hidden; white-space:nowrap;
  color: var(--color-ink); text-shadow: 0 0 20px rgba(217,119,87,.4), 0 0 6px rgba(250,249,245,.25); }
.kv-fill.kv-sweeping {
  -webkit-mask-image: linear-gradient(90deg,#000 calc(100% - 24px), rgba(0,0,0,.3) calc(100% - 7px), transparent);
  mask-image: linear-gradient(90deg,#000 calc(100% - 24px), rgba(0,0,0,.3) calc(100% - 7px), transparent); }
`;
```

- [ ] **Step 4: Run the smoke test + tsc**

Run: `cd ui && npx vitest run src/KaraokeView.test.tsx && npx tsc --noEmit`
Expected: PASS + no type errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/KaraokeView.tsx ui/src/KaraokeView.test.tsx
git commit -m "feat(karaoke): KaraokeView sweep component"
```

---

## Task 9: Lyrics toggle + player integration + fallback states

**Files:**
- Modify: `ui/src/PlayerBar.tsx` (Lyrics toggle in the `full` control row; swap art↔KaraokeView; now-playing chip; state cards)
- Create: `ui/src/KaraokeCard.tsx` (needs-sync / generating / failed cards + the plain-lyrics fallback)
- Test: Playwright (real browser), plus `tsc`.

**Interfaces:**
- Consumes: `getAlign`, `postAlign`, `AlignmentData` (Task 6); `KaraokeView` (Task 8); session `alignmentEnabled`.
- Produces: within PlayerBar `full`, a lyrics mode gated on `alignmentEnabled && song.lyrics`.

- [ ] **Step 1: Implement KaraokeCard**

Create `ui/src/KaraokeCard.tsx`:

```tsx
// KaraokeCard renders the non-playing karaoke states over the plain lyrics: a
// needs-sync CTA, a generating spinner, or a failed+retry card. Copy mirrors the
// locked mock (docs/mockups/karaoke). onGenerate re-POSTs /align.
export function KaraokeCard({ state, title, lyrics, onGenerate }: {
  state: "needs" | "generating" | "failed";
  title: string;
  lyrics: string;
  onGenerate: () => void;
}) {
  const copy = {
    needs: { h: "Sync lyrics to the music", p: "Generate word-by-word karaoke timing — about a minute. Also runs automatically when you save lyrics in the tag editor.", btn: "Generate karaoke" },
    failed: { h: "Couldn’t sync this song", p: "Something went wrong aligning the words. You can try again.", btn: "Try again" },
    generating: { h: "Aligning…", p: "Matching each word to the vocal — about a minute. Keep browsing; it shows a spinner until it’s ready.", btn: "" },
  }[state];
  return (
    <div style={{ position: "relative", height: "100%" }}>
      {/* plain lyrics behind the card so an unaligned song still shows its words */}
      <pre style={{ position: "absolute", inset: 0, overflow: "auto", margin: 0, padding: "8vh 8vw",
        fontFamily: "var(--font-serif)", fontSize: 20, lineHeight: 1.6, color: "rgba(250,249,245,.55)",
        whiteSpace: "pre-wrap", textAlign: "center", filter: "blur(2px)", opacity: 0.5 }}>{lyrics}</pre>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", padding: 24 }}>
        <div style={{ textAlign: "center", maxWidth: 380, background: "color-mix(in srgb, var(--color-panel) 80%, transparent)",
          border: "1px solid var(--color-border)", borderRadius: 16, padding: "30px 28px", backdropFilter: "blur(16px)" }}>
          {state === "generating"
            ? <div style={{ width: 42, height: 42, margin: "0 auto 18px", borderRadius: "50%", border: "3px solid var(--color-active)", borderTopColor: "var(--color-accent-strong)", animation: "kv-spin 1s linear infinite" }} />
            : <div style={{ width: 54, height: 54, margin: "0 auto 16px", borderRadius: "50%", background: "var(--color-active)", display: "grid", placeItems: "center", color: "var(--color-accent-strong)", fontSize: 26 }}>♪</div>}
          <h3 style={{ fontFamily: "var(--font-serif)", fontWeight: 600, margin: "0 0 8px", fontSize: 21, color: "var(--color-ink)" }}>{copy.h}</h3>
          <p style={{ margin: "0 0 20px", color: "var(--color-muted)", fontSize: 14, lineHeight: 1.55 }}>{copy.p}</p>
          {copy.btn && (
            <button onClick={onGenerate} style={{ background: "var(--color-accent-fill)", color: "var(--color-ink)", border: "none",
              borderRadius: 10, padding: "12px 20px", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>{copy.btn}</button>
          )}
          <style>{"@keyframes kv-spin { to { transform: rotate(360deg); } }"}</style>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Integrate into PlayerBar `full`**

In `ui/src/PlayerBar.tsx`: accept the session flag (thread `alignmentEnabled` from where PlayerBar is rendered — grep `<PlayerBar` in `App.tsx`; the session is already loaded there). Add local state and a lyrics-mode branch. Sketch of the additions (keep the existing cover/scrubber/transport; add the toggle button + swap the art region):

```tsx
// props gain: alignmentEnabled: boolean
const [lyricsMode, setLyricsMode] = useState(false);
const [align, setAlign] = useState<AlignmentData | null>(null);
const hasLyrics = !!song.lyrics && song.lyrics.trim() !== "";
const canKaraoke = alignmentEnabled && hasLyrics;

// fetch + poll while generating, only in lyrics mode
useEffect(() => {
  if (!full || !lyricsMode || !canKaraoke) return;
  let alive = true;
  const tick = async () => {
    const a = await getAlign(song.id).catch(() => null);
    if (!alive) return;
    setAlign(a);
    if (a?.status === "generating") setTimeout(tick, 2000);
  };
  tick();
  return () => { alive = false; };
}, [full, lyricsMode, canKaraoke, song.id]);

const onGenerate = () => { void postAlign(song.id); setAlign({ status: "generating" }); };
```

In the `full` overlay, replace the fixed cover-art block with: when `lyricsMode && canKaraoke`, render the karaoke region (chip up top + body); else the existing large cover art. Body logic:

```tsx
{align?.status === "ready" && align.lines?.length
  ? <KaraokeView lines={align.lines} />
  : <KaraokeCard
      state={align?.status === "generating" ? "generating" : align?.status === "failed" ? "failed" : "needs"}
      title={song.title} lyrics={song.lyrics ?? ""} onGenerate={onGenerate} />}
```

Add the Lyrics toggle button to the control row (only when `canKaraoke`), styled like the mock's `.lyr` accent button, toggling `lyricsMode`. When `lyricsMode`, shrink the artwork into a now-playing chip at top-left showing cover + title + (while generating) "● Syncing karaoke…". Keep `Scrubber`/`Transport` docked exactly as now.

Thread `alignmentEnabled` at the `<PlayerBar ... />` call site in `App.tsx`.

- [ ] **Step 3: Type-check + unit suite**

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: no type errors; all existing + new unit tests pass.

- [ ] **Step 4: Playwright — seed a synthetic ready alignment and verify the sweep**

Prep a deterministic fixture with a real `ready` row (no sidecar): in dev, seed via the DB or a test-only helper, OR intercept `GET /api/songs/:id/align` in the browser with a stub payload. Preferred: use Playwright's `browser_evaluate` to monkeypatch `window.fetch` for the align endpoint before opening the player, returning:

```json
{ "status": "ready", "engine": "stub",
  "lines": [
    { "text": "hello world", "start": 1, "end": 3, "words": [
      { "w": "hello", "start": 1.0, "end": 1.8, "conf": 0.9 },
      { "w": "world", "start": 1.8, "end": 3.0, "conf": 0.9 } ] },
    { "text": "second line here", "start": 3, "end": 6, "words": [
      { "w": "second", "start": 3.0, "end": 4.0, "conf": 0.9 },
      { "w": "line", "start": 4.0, "end": 5.0, "conf": 0.9 },
      { "w": "here", "start": 5.0, "end": 6.0, "conf": 0.9 } ] } ] }
```

Steps (Playwright MCP): navigate to the app (authenticated), play a song with lyrics, expand the player, click the Lyrics toggle, screenshot. Then set `audio.currentTime` (via `browser_evaluate` on `player.getAudioElement()`) to 1.5 / 4.5 and screenshot each — assert the fill width advances and the active line changes / auto-scrolls. Verify the fallback states by returning `{status:"failed"}` and `null` from the stub and confirming the failed card + needs-sync card render; and that a no-lyrics song hides the toggle.

Expected: sweep fill grows within the active line, inactive lines blurred, active line ~40% down; cards render for non-ready states; toggle hidden without lyrics.

- [ ] **Step 5: Commit**

```bash
git add ui/src/PlayerBar.tsx ui/src/KaraokeCard.tsx ui/src/App.tsx
git commit -m "feat(karaoke): Lyrics toggle + player integration with fallback states"
```

---

## Task 10: Progress indicators (chip already in Task 9; song-row badge + Lyrics-view usage)

**Files:**
- Modify: the song-row component(s) that render list rows (grep `song.title` render sites — likely `ui/src/Rail.tsx`, `ui/src/Library.tsx`, `ui/src/Detail.tsx`, `ui/src/Search.tsx`; pick the shared row if one exists)
- Test: Playwright + `tsc`.

**Interfaces:**
- Consumes: `song.alignmentStatus` (Task 1/6).

- [ ] **Step 1: Add a small badge**

Find the shared song-row rendering. Add, next to the title/subtitle, a small muted indicator shown only when `song.alignmentStatus === "generating"`:

```tsx
{song.alignmentStatus === "generating" && (
  <span title="Syncing karaoke…" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--color-accent-strong)", fontSize: "var(--text-label)" }}>
    <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", animation: "kv-spin 1s linear infinite" }} /> Syncing
  </span>
)}
```

If there is no single shared row component, apply consistently to each list that shows songs (per the global "apply consistently" rule).

- [ ] **Step 2: Type-check**

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: green.

- [ ] **Step 3: Playwright — verify the badge**

Stub `GET /api/songs` (or the relevant list endpoint) to include a song with `alignmentStatus:"generating"`; confirm the "Syncing" badge renders in the row; confirm it is absent for `ready`/`""`.

- [ ] **Step 4: Commit**

```bash
git add ui/src/*.tsx
git commit -m "feat(karaoke): song-row syncing indicator"
```

---

## Task 11: Context-aware trigger in SongMenu

**Files:**
- Modify: `ui/src/SongMenu.tsx` (add the menu item); grep its call sites for whether they pass `alignmentEnabled` (thread it in like `authenticated`)
- Test: Playwright + `tsc`.

**Interfaces:**
- Consumes: `postAlign` (Task 6); `song.alignmentStatus`, `song.lyrics`; a new `alignmentEnabled: boolean` prop.

- [ ] **Step 1: Implement**

Add an `alignmentEnabled: boolean` prop to `SongMenu` `Props` and a menu item, placed after "Edit…":

```tsx
{p.authenticated && p.alignmentEnabled && !!p.song.lyrics && p.song.lyrics.trim() !== "" && (
  <MenuItem icon="sparkles" onClick={() => { void postAlign(p.song.id); p.onClose(); }}>
    {p.song.alignmentStatus === "ready" ? "Re-sync karaoke" : "Generate karaoke"}
  </MenuItem>
)}
```

(Use an existing icon name from `Icon.tsx`/`Glyph.tsx` — grep for a suitable one like `sparkles`/`music`/`star`; fall back to an existing one if `sparkles` is absent.) Thread `alignmentEnabled` from each `<SongMenu ... />` call site (same places that pass `authenticated`).

- [ ] **Step 2: Type-check**

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: green.

- [ ] **Step 3: Playwright — verify the menu item**

Open a song's ··· menu for a song with lyrics → "Generate karaoke" appears; for a synced song → "Re-sync karaoke"; for a no-lyrics song → item absent. Click it and confirm a `POST /api/songs/:id/align` fires (network panel) and the row shows "Syncing".

- [ ] **Step 4: Commit**

```bash
git add ui/src/SongMenu.tsx ui/src/*.tsx
git commit -m "feat(karaoke): context-aware Generate/Re-sync in the song menu"
```

---

## Task 12: Real sidecar smoke + docs

**Files:**
- Modify: `KARAOKE.md` (flip Phase 3 status to done; note SYLT delivered via custom frame)

- [ ] **Step 1: Real trigger→ready→SYLT smoke (out-of-band, manual)**

```bash
docker run -d --name align --platform linux/amd64 -p 8000:8000 -v music-align-cache:/root/.cache music-align
# run the app with BACKEND_ALIGN_URL=http://localhost:8000
```

Upload/edit a song with real lyrics, watch it go generating→ready, open the player, confirm the sweep tracks the real vocal, then download the MP3 and confirm the SYLT frame (Task 5 Step 5 command). Record the result.

- [ ] **Step 2: Update KARAOKE.md**

Flip the Phase 3 row to ✅ with a one-line summary; under Phase 3 note that SYLT shipped via a custom `metadata.SyncedLyricsFrame` (bogem lacks SYLT). Keep the plain-lyrics fallback + tokenizer-cascade caveats.

- [ ] **Step 3: Commit**

```bash
git add KARAOKE.md
git commit -m "docs(karaoke): mark Phase 3 done; SYLT via custom frame"
```

---

## Final verification (before PR)

- [ ] `cd backend && go test ./...` → all green
- [ ] `cd ui && npx tsc --noEmit && npx vitest run` → all green
- [ ] `cd ui && npm run build` → succeeds
- [ ] Playwright: sweep + all fallback states + row badge + menu item verified in a real browser
- [ ] Generic-subagent code review (superpowers:requesting-code-review), address findings
- [ ] Open PR to `master` (never push directly)

## Self-review notes (coverage map)
- Player view → Tasks 7,8,9. Continuous per-line sweep, LEAD/MAX_SWEEP, dim/blur, auto-scroll, mask → Task 8. Fallbacks (plain/needs/generating/failed, hide-toggle) → Task 9. Loom theme → Task 8/9.
- Triggers (import, save, manual) → Tasks 3,11. Empty-lyrics no-op → Tasks 2,3,11 (+ backend 400 kept).
- Serialized queue → Task 2. Progress indicators (chip, row, card) → Tasks 9,10. No toast (decided).
- SYLT bake → Tasks 4,5 (+ round-trip + manual ffprobe). Storage-only-source-of-truth preserved (download copy).
- alignmentStatus everywhere the song appears → Task 1 (payload) feeding Tasks 9,10,11.
