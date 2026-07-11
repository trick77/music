# Karaoke Phase 2: Alignment Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate and store word-level timings for a song by forced-aligning its stored lyrics to its audio via a self-hosted sidecar.

**Architecture:** The Go app stays a minimal static binary. An authenticated `POST /api/songs/:id/align` inserts a `song_alignment` row (`generating`), spawns a detached goroutine (the fanart pattern), which streams the MP3 + cleaned lyrics to a stateless Python sidecar (Demucs vocal isolation → WhisperX forced alignment fed the *known* lyrics), stores the returned word timings as JSON, and marks the row `ready`/`failed`. Clients poll `GET /api/songs/:id/align`.

**Tech Stack:** Go 1.25 (`net/http`, `database/sql`, `ncruces/go-sqlite3`), React/TS SPA (session flag only this phase), Python sidecar (FastAPI + WhisperX + Demucs + ffmpeg).

## Global Constraints

- Backend module: `github.com/trick77/music`, Go 1.25. Tests run with the project Go toolchain: `cd backend && go test ./...`.
- SQLite is the pure-Go `ncruces/go-sqlite3`; migrations are embedded numbered files in `backend/internal/store/migrations/`, applied in filename order. **Never edit an applied migration — always add a new numbered file.**
- Swiss orthography in any German text (none expected here).
- Async work pattern (copy from fanart): detached `context.Background()` goroutine + `generating`/`ready`/`failed` DB status + boot reaper that fails orphaned rows.
- External-capability gating pattern (copy from BFL/Chat): a `config.Config` field + an `XxxEnabled()` method keyed on env presence; surfaced in `GET /api/auth/session` as `<flag> && id.Authenticated`.
- Server-only failure text: the `error` column is never serialized to clients (mirror `fanart` `json:"-"`).
- The stored file is authoritative audio; read it via `h.media.Open(song.FilePath)` / resolve with `h.media.Resolve`.

---

## File Structure

**Backend (new):**
- `backend/internal/store/migrations/0003_song_alignment.sql` — the table.
- `backend/internal/library/alignment.go` (+ `alignment_test.go`) — persistence.
- `backend/internal/align/client.go` (+ `client_test.go`) — sidecar HTTP client + shared timing types.
- `backend/internal/httpapi/alignment.go` (+ `alignment_test.go`) — handlers, async orchestration, aligner interface.

**Backend (modify):**
- `backend/internal/config/config.go` — `AlignURL`, `AlignTimeout`, `AlignmentEnabled()`.
- `backend/internal/httpapi/songs.go` — add `aligner` field to `songHandlers`.
- `backend/internal/httpapi/server.go` — session flag, construct aligner, register routes, reaper call.

**Sidecar (new):**
- `sidecar/align/app.py` — FastAPI service.
- `sidecar/align/grouping.py` (+ `test_grouping.py`) — pure word→line regrouping (ML-free, unit-tested).
- `sidecar/align/requirements.txt`, `sidecar/align/Containerfile`.

**Ops/docs (modify):**
- `compose.yaml` — the `align` sidecar service.
- `docs/karaoke-roadmap.md` — flip Phase 2 status on completion.

---

## Task 1: `song_alignment` table + persistence

**Files:**
- Create: `backend/internal/store/migrations/0003_song_alignment.sql`
- Create: `backend/internal/library/alignment.go`
- Test: `backend/internal/library/alignment_test.go`

**Interfaces:**
- Produces:
  - `type Alignment struct { SongID, Status, Engine, Data string; CreatedAt string }` (`Data` is the raw JSON timings; `Status` ∈ `generating|ready|failed`; the server-only error is not exposed on this struct)
  - `(*Repo) UpsertGeneratingAlignment(ctx, songID string) error`
  - `(*Repo) MarkAlignmentReady(ctx, songID, engine, data string) error`
  - `(*Repo) MarkAlignmentFailed(ctx, songID, reason string) error`
  - `(*Repo) GetAlignment(ctx, songID string) (*Alignment, error)` — `(nil,nil)` when absent
  - `(*Repo) FailOrphanedAlignments(ctx) (int64, error)`

- [ ] **Step 1: Write the migration**

Create `backend/internal/store/migrations/0003_song_alignment.sql`:
```sql
-- Word-level lyric timings produced by the alignment sidecar. One row per song;
-- re-running an alignment replaces the row. Mirrors the fanart status/error shape.
CREATE TABLE song_alignment (
    song_id    TEXT PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'generating'
                 CHECK (status IN ('generating','ready','failed')),
    error      TEXT,                       -- server-only failure reason
    engine     TEXT,                       -- e.g. 'whisperx-3.x+demucs'
    data       TEXT,                       -- JSON: [{text,start,end,words:[{w,start,end,conf}]}]
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Write the failing persistence test**

Create `backend/internal/library/alignment_test.go`:
```go
package library

import (
	"context"
	"testing"
)

func TestAlignment_lifecycle(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	song, err := r.Create(ctx, NewID(), sampleParams())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Absent -> (nil, nil).
	if a, err := r.GetAlignment(ctx, song.ID); err != nil || a != nil {
		t.Fatalf("GetAlignment absent = %v, %v; want nil,nil", a, err)
	}

	// Upsert generating.
	if err := r.UpsertGeneratingAlignment(ctx, song.ID); err != nil {
		t.Fatalf("UpsertGeneratingAlignment: %v", err)
	}
	a, err := r.GetAlignment(ctx, song.ID)
	if err != nil || a == nil || a.Status != "generating" {
		t.Fatalf("after upsert = %+v, %v; want status generating", a, err)
	}

	// Ready stores engine + data.
	if err := r.MarkAlignmentReady(ctx, song.ID, "whisperx+demucs", `[{"text":"hi"}]`); err != nil {
		t.Fatalf("MarkAlignmentReady: %v", err)
	}
	a, _ = r.GetAlignment(ctx, song.ID)
	if a.Status != "ready" || a.Engine != "whisperx+demucs" || a.Data != `[{"text":"hi"}]` {
		t.Fatalf("after ready = %+v", a)
	}

	// Re-upsert resets to generating and clears data.
	if err := r.UpsertGeneratingAlignment(ctx, song.ID); err != nil {
		t.Fatalf("re-upsert: %v", err)
	}
	a, _ = r.GetAlignment(ctx, song.ID)
	if a.Status != "generating" || a.Data != "" {
		t.Fatalf("re-upsert did not reset: %+v", a)
	}

	// Failed.
	if err := r.MarkAlignmentFailed(ctx, song.ID, "boom"); err != nil {
		t.Fatalf("MarkAlignmentFailed: %v", err)
	}
	a, _ = r.GetAlignment(ctx, song.ID)
	if a.Status != "failed" {
		t.Fatalf("after failed = %+v", a)
	}
}

func TestFailOrphanedAlignments(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	song, _ := r.Create(ctx, NewID(), sampleParams())
	if err := r.UpsertGeneratingAlignment(ctx, song.ID); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	n, err := r.FailOrphanedAlignments(ctx)
	if err != nil || n != 1 {
		t.Fatalf("FailOrphanedAlignments = %d, %v; want 1, nil", n, err)
	}
	a, _ := r.GetAlignment(ctx, song.ID)
	if a.Status != "failed" {
		t.Fatalf("orphan not failed: %+v", a)
	}
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd backend && go test ./internal/library/ -run 'TestAlignment_lifecycle|TestFailOrphanedAlignments' -v`
Expected: FAIL — `r.GetAlignment` / `UpsertGeneratingAlignment` undefined.

- [ ] **Step 4: Implement persistence**

Create `backend/internal/library/alignment.go`:
```go
package library

import (
	"context"
	"database/sql"
	"errors"
)

// Alignment is a stored word-timing row. The server-only failure reason is
// intentionally not carried here — GetAlignment is used to build client responses.
type Alignment struct {
	SongID    string
	Status    string
	Engine    string
	Data      string // JSON timings; empty until ready
	CreatedAt string
}

// UpsertGeneratingAlignment creates or resets the song's alignment row to the
// 'generating' state, clearing any prior data/error/engine so a re-run starts clean.
func (r *Repo) UpsertGeneratingAlignment(ctx context.Context, songID string) error {
	_, err := r.db.ExecContext(ctx,
		`INSERT INTO song_alignment(song_id, status) VALUES(?, 'generating')
		 ON CONFLICT(song_id) DO UPDATE SET status='generating', data=NULL, error=NULL, engine=NULL`,
		songID)
	return err
}

// MarkAlignmentReady records the timings JSON + engine and clears any prior error.
func (r *Repo) MarkAlignmentReady(ctx context.Context, songID, engine, data string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE song_alignment SET status='ready', engine=?, data=?, error=NULL WHERE song_id=?`,
		engine, data, songID)
	return err
}

// MarkAlignmentFailed records a terminal failure with a server-only reason.
func (r *Repo) MarkAlignmentFailed(ctx context.Context, songID, reason string) error {
	_, err := r.db.ExecContext(ctx,
		`UPDATE song_alignment SET status='failed', error=? WHERE song_id=?`, reason, songID)
	return err
}

// GetAlignment returns the song's alignment row, or (nil, nil) if none exists.
func (r *Repo) GetAlignment(ctx context.Context, songID string) (*Alignment, error) {
	var a Alignment
	var engine, data sql.NullString
	err := r.db.QueryRowContext(ctx,
		`SELECT song_id, status, engine, data, created_at FROM song_alignment WHERE song_id=?`, songID).
		Scan(&a.SongID, &a.Status, &engine, &data, &a.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	a.Engine = engine.String
	a.Data = data.String
	return &a, nil
}

// FailOrphanedAlignments flips any 'generating' alignment rows to 'failed' on boot —
// the alignment goroutine cannot survive a restart, mirroring FailOrphanedGenerating.
func (r *Repo) FailOrphanedAlignments(ctx context.Context) (int64, error) {
	res, err := r.db.ExecContext(ctx,
		`UPDATE song_alignment SET status='failed', error='alignment interrupted by a restart' WHERE status='generating'`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd backend && go test ./internal/library/ -run 'TestAlignment_lifecycle|TestFailOrphanedAlignments' -v`
Expected: PASS. Also run `go test ./internal/store/` — the migration-count test there asserts a specific count; if it fails, update it to the new count (there will now be 3 recorded migrations) exactly as was done for `0002`.

- [ ] **Step 6: Commit**

```bash
git add backend/internal/store/migrations/0003_song_alignment.sql backend/internal/library/alignment.go backend/internal/library/alignment_test.go backend/internal/store/store_test.go
git commit -m "feat(align): song_alignment table + persistence"
```

---

## Task 2: Config flag + session gating

**Files:**
- Modify: `backend/internal/config/config.go`
- Modify: `backend/internal/httpapi/server.go` (session JSON only, ~line 66)
- Test: `backend/internal/config/config_test.go` (add case)

**Interfaces:**
- Produces: `Config.AlignURL string`, `Config.AlignTimeout time.Duration`, `(Config) AlignmentEnabled() bool` (⇔ `AlignURL != ""`).

- [ ] **Step 1: Write the failing config test**

Add to `backend/internal/config/config_test.go` (create a focused test; adapt to the file's existing env-set helper if present):
```go
func TestAlignmentEnabled(t *testing.T) {
	if (Config{}).AlignmentEnabled() {
		t.Fatal("empty AlignURL should be disabled")
	}
	if !(Config{AlignURL: "http://align:8000"}).AlignmentEnabled() {
		t.Fatal("set AlignURL should be enabled")
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && go test ./internal/config/ -run TestAlignmentEnabled -v`
Expected: FAIL — `AlignmentEnabled` / `AlignURL` undefined.

- [ ] **Step 3: Implement config fields + loader + method**

In `backend/internal/config/config.go`:

Add fields near `BFLPollTimeout` (~line 52-55):
```go
	AlignURL     string
	AlignTimeout time.Duration
```

Add the method near `ImageGenEnabled` (~line 67):
```go
// AlignmentEnabled reports whether the word-timing alignment sidecar is configured.
func (c Config) AlignmentEnabled() bool { return c.AlignURL != "" }
```

Add loading in `Load()` near the BFL loads (~line 129-136); default timeout 10 min:
```go
	cfg.AlignURL = env("BACKEND_ALIGN_URL", "")
	alignTimeout, err := time.ParseDuration(env("BACKEND_ALIGN_TIMEOUT", "10m"))
	if err != nil {
		return Config{}, fmt.Errorf("BACKEND_ALIGN_TIMEOUT: %w", err)
	}
	cfg.AlignTimeout = alignTimeout
```
(Match the exact error-return signature used by the neighboring `BFLPollTimeout` parse — copy its shape.)

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && go test ./internal/config/ -run TestAlignmentEnabled -v`
Expected: PASS.

- [ ] **Step 5: Add the session flag**

In `backend/internal/httpapi/server.go`, in the `GET /api/auth/session` JSON (~line 66-68), add after `chatEnabled`:
```go
			"alignmentEnabled": cfg.AlignmentEnabled() && id.Authenticated,
```

- [ ] **Step 6: Verify build + commit**

Run: `cd backend && go build ./... && go test ./internal/config/ ./internal/httpapi/`
Expected: build OK, tests PASS.
```bash
git add backend/internal/config/config.go backend/internal/config/config_test.go backend/internal/httpapi/server.go
git commit -m "feat(align): AlignmentEnabled config flag + session gating"
```

---

## Task 3: Align sidecar HTTP client + timing types

**Files:**
- Create: `backend/internal/align/client.go`
- Test: `backend/internal/align/client_test.go`

**Interfaces:**
- Produces:
  - `type Word struct { W string; Start, End, Conf float64 }` (JSON `w,start,end,conf`)
  - `type Line struct { Text string; Start, End float64; Words []Word }` (JSON `text,start,end,words`)
  - `type Result struct { Engine string; Lines []Line }` (JSON `engine,lines`)
  - `type Client struct { ... }` with `func New(baseURL string, timeout time.Duration) *Client`
  - `(*Client) Align(ctx context.Context, audio io.Reader, filename, lyrics string) (*Result, error)`

- [ ] **Step 1: Write the failing client test**

Create `backend/internal/align/client_test.go`:
```go
package align

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestAlign_postsMultipartAndParsesResult(t *testing.T) {
	var gotLyrics, gotAudio string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/align" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Fatalf("parse multipart: %v", err)
		}
		gotLyrics = r.FormValue("lyrics")
		f, _, _ := r.FormFile("audio")
		b, _ := io.ReadAll(f)
		gotAudio = string(b)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"engine":"whisperx+demucs","lines":[{"text":"hi there","start":1.0,"end":2.0,"words":[{"w":"hi","start":1.0,"end":1.4,"conf":0.9},{"w":"there","start":1.5,"end":2.0,"conf":0.8}]}]}`)
	}))
	defer srv.Close()

	c := New(srv.URL, 5*time.Second)
	res, err := c.Align(context.Background(), strings.NewReader("AUDIOBYTES"), "song.mp3", "hi there")
	if err != nil {
		t.Fatalf("Align: %v", err)
	}
	if gotLyrics != "hi there" || gotAudio != "AUDIOBYTES" {
		t.Fatalf("sidecar got lyrics=%q audio=%q", gotLyrics, gotAudio)
	}
	if res.Engine != "whisperx+demucs" || len(res.Lines) != 1 || len(res.Lines[0].Words) != 2 {
		t.Fatalf("parsed result wrong: %+v", res)
	}
	if res.Lines[0].Words[0].W != "hi" || res.Lines[0].Words[1].End != 2.0 {
		t.Fatalf("word parse wrong: %+v", res.Lines[0].Words)
	}
}

func TestAlign_nonJSONErrorSurfaced(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		io.WriteString(w, `{"error":"model not loaded"}`)
	}))
	defer srv.Close()
	c := New(srv.URL, 5*time.Second)
	_, err := c.Align(context.Background(), strings.NewReader("x"), "s.mp3", "hi")
	if err == nil || !strings.Contains(err.Error(), "model not loaded") {
		t.Fatalf("want error containing sidecar reason, got %v", err)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && go test ./internal/align/ -v`
Expected: FAIL — package/`New`/`Align` undefined.

- [ ] **Step 3: Implement the client**

Create `backend/internal/align/client.go`:
```go
// Package align is the Go client for the word-timing alignment sidecar. It sends a
// song's audio + known lyrics and returns per-word timings. All ML lives in the
// sidecar; this package only speaks its HTTP contract.
package align

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"
)

// Word is one aligned word: start/end seconds from track start, plus a 0..1 confidence.
type Word struct {
	W     string  `json:"w"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Conf  float64 `json:"conf"`
}

// Line groups the words of one original lyric line with its overall span.
type Line struct {
	Text  string  `json:"text"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
	Words []Word  `json:"words"`
}

// Result is the sidecar's full response for one song.
type Result struct {
	Engine string `json:"engine"`
	Lines  []Line `json:"lines"`
}

// Client calls the alignment sidecar synchronously.
type Client struct {
	baseURL string
	http    *http.Client
}

// New builds a client for a sidecar base URL (e.g. "http://align:8000") with a
// per-request timeout covering the whole (minutes-long) alignment.
func New(baseURL string, timeout time.Duration) *Client {
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), http: &http.Client{Timeout: timeout}}
}

// Align POSTs the audio + lyrics as multipart/form-data and returns parsed timings.
// A non-2xx response surfaces the sidecar's {"error":...} reason.
func (c *Client) Align(ctx context.Context, audio io.Reader, filename, lyrics string) (*Result, error) {
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		var err error
		defer func() { _ = pw.CloseWithError(err) }()
		if err = mw.WriteField("lyrics", lyrics); err != nil {
			return
		}
		var fw io.Writer
		if fw, err = mw.CreateFormFile("audio", filename); err != nil {
			return
		}
		if _, err = io.Copy(fw, audio); err != nil {
			return
		}
		err = mw.Close()
	}()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/align", pr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode/100 != 2 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(body, &e)
		if e.Error != "" {
			return nil, fmt.Errorf("align sidecar: %s", e.Error)
		}
		return nil, fmt.Errorf("align sidecar: status %d", resp.StatusCode)
	}
	var out Result
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, fmt.Errorf("align sidecar: bad JSON: %w", err)
	}
	return &out, nil
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend && go test ./internal/align/ -v`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add backend/internal/align/
git commit -m "feat(align): sidecar HTTP client + timing types"
```

---

## Task 4: Handlers + async orchestration + wiring

**Files:**
- Create: `backend/internal/httpapi/alignment.go`
- Test: `backend/internal/httpapi/alignment_test.go`
- Modify: `backend/internal/httpapi/songs.go` (add `aligner` field, ~line 32-34)
- Modify: `backend/internal/httpapi/server.go` (construct aligner, register routes, reaper)

**Interfaces:**
- Consumes: `align.Client`/`align.Result` (Task 3); `library` alignment methods (Task 1); `config.AlignmentEnabled` (Task 2).
- Produces (in package `httpapi`):
  - `type aligner interface { Align(ctx context.Context, audio io.Reader, filename, lyrics string) (*align.Result, error) }` (satisfied by `*align.Client`; stubbed in tests)
  - `songHandlers.aligner aligner` field (nil ⇒ feature off)
  - `(*songHandlers) postAlign(w, r)`, `(*songHandlers) getAlign(w, r)`, `(*songHandlers) runAlignment(songID, relPath, lyrics string)`
  - `songHandlers.onAlignComplete func(id string)` (test hook; nil in prod)

- [ ] **Step 1: Add the aligner field + test hook to the handler struct**

In `backend/internal/httpapi/songs.go`, inside `type songHandlers struct` after `onGenComplete` (~line 34), add:
```go
	aligner         aligner
	onAlignComplete func(id string)
```

- [ ] **Step 2: Write the failing handler tests**

Create `backend/internal/httpapi/alignment_test.go`. These construct a `songHandlers` in-package with a fake aligner, so the async path is deterministic (no real sidecar, no polling):
```go
package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trick77/music/internal/align"
	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/media"
	"github.com/trick77/music/internal/store"
)

// fakeAligner returns a canned result or an error.
type fakeAligner struct {
	res *align.Result
	err error
}

func (f fakeAligner) Align(_ context.Context, audio io.Reader, _ , _ string) (*align.Result, error) {
	_, _ = io.Copy(io.Discard, audio) // drain like the real client
	return f.res, f.err
}

// alignTestHandler builds an in-package handler with a seeded song and a fake aligner.
func alignTestHandler(t *testing.T, a aligner) (*songHandlers, string) {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/t.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	repo := library.NewRepo(st.DB())
	ms, err := media.New(t.TempDir())
	if err != nil {
		t.Fatalf("media.New: %v", err)
	}
	// Seed a song with a real (tiny) file so h.media.Open succeeds.
	f, _ := ms.Create("songs/x.mp3")
	io.WriteString(f, "AUDIO")
	f.Close()
	song, err := repo.Create(context.Background(), library.NewID(), library.CreateSongParams{
		Title: "T", ArtistName: "A", FilePath: "songs/x.mp3", ContentHash: "h", Lyrics: "hi there",
	})
	if err != nil {
		t.Fatalf("seed song: %v", err)
	}
	h := &songHandlers{cfg: config.Config{AuthMode: config.AuthModeDev}, repo: repo, media: ms, aligner: a}
	return h, song.ID
}

func TestPostAlign_disabledReturns404(t *testing.T) {
	h, id := alignTestHandler(t, nil) // nil aligner = disabled
	rr := httptest.NewRecorder()
	h.postAlign(rr, httptest.NewRequest("POST", "/api/songs/"+id+"/align", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("disabled POST = %d, want 404", rr.Code)
	}
}

func TestPostAlign_happyPathStoresTimings(t *testing.T) {
	done := make(chan string, 1)
	h, id := alignTestHandler(t, fakeAligner{res: &align.Result{
		Engine: "fake", Lines: []align.Line{{Text: "hi there", Start: 1, End: 2,
			Words: []align.Word{{W: "hi", Start: 1, End: 1.4, Conf: 0.9}}}},
	}})
	h.onAlignComplete = func(sid string) { done <- sid }

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/songs/"+id+"/align", nil)
	req.SetPathValue("id", id)
	h.postAlign(rr, req)
	if rr.Code != http.StatusAccepted {
		t.Fatalf("POST = %d, want 202; body=%s", rr.Code, rr.Body.String())
	}
	<-done // wait for the detached goroutine

	a, _ := h.repo.GetAlignment(context.Background(), id)
	if a == nil || a.Status != "ready" || a.Engine != "fake" {
		t.Fatalf("alignment not ready: %+v", a)
	}
	var lines []align.Line
	if err := json.Unmarshal([]byte(a.Data), &lines); err != nil || len(lines) != 1 || lines[0].Words[0].W != "hi" {
		t.Fatalf("stored data wrong: %q err=%v", a.Data, err)
	}
}

func TestPostAlign_sidecarErrorMarksFailed(t *testing.T) {
	done := make(chan string, 1)
	h, id := alignTestHandler(t, fakeAligner{err: io.ErrUnexpectedEOF})
	h.onAlignComplete = func(sid string) { done <- sid }
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/songs/"+id+"/align", nil)
	req.SetPathValue("id", id)
	h.postAlign(rr, req)
	<-done
	a, _ := h.repo.GetAlignment(context.Background(), id)
	if a == nil || a.Status != "failed" {
		t.Fatalf("want failed, got %+v", a)
	}
}

func TestPostAlign_conflictWhileGenerating(t *testing.T) {
	h, id := alignTestHandler(t, fakeAligner{res: &align.Result{Engine: "fake"}})
	// Pre-seed a generating row.
	_ = h.repo.UpsertGeneratingAlignment(context.Background(), id)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/songs/"+id+"/align", nil)
	req.SetPathValue("id", id)
	h.postAlign(rr, req)
	if rr.Code != http.StatusConflict {
		t.Fatalf("re-POST while generating = %d, want 409", rr.Code)
	}
}

func TestGetAlign_reflectsStatus(t *testing.T) {
	h, id := alignTestHandler(t, fakeAligner{res: &align.Result{Engine: "fake"}})
	// Not requested yet -> 404.
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/songs/"+id+"/align", nil)
	req.SetPathValue("id", id)
	h.getAlign(rr, req)
	if rr.Code != http.StatusNotFound {
		t.Fatalf("absent GET = %d, want 404", rr.Code)
	}
	// Ready -> 200 with lines, no error field.
	_ = h.repo.MarkAlignmentReady(context.Background(), id, "fake", `[{"text":"hi","start":1,"end":2,"words":[]}]`)
	rr = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/api/songs/"+id+"/align", nil)
	req.SetPathValue("id", id)
	h.getAlign(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("ready GET = %d, want 200", rr.Code)
	}
	var body map[string]any
	json.Unmarshal(rr.Body.Bytes(), &body)
	if body["status"] != "ready" || body["lines"] == nil {
		t.Fatalf("ready body wrong: %v", body)
	}
	if _, hasErr := body["error"]; hasErr {
		t.Fatalf("error must never be serialized: %v", body)
	}
}
```

> Note: `media.New(root)` and `config.AuthModeDev` are the correct names (verified). If a shared in-package test helper already builds a `songHandlers`, prefer reusing it.

- [ ] **Step 3: Run to verify failure**

Run: `cd backend && go test ./internal/httpapi/ -run TestPostAlign -v`
Expected: FAIL — `postAlign`/`getAlign`/`aligner` undefined.

- [ ] **Step 4: Implement handlers + orchestration**

Create `backend/internal/httpapi/alignment.go`:
```go
package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"time"

	"github.com/trick77/music/internal/align"
)

// aligner is the alignment sidecar seam; *align.Client satisfies it, tests stub it.
type aligner interface {
	Align(ctx context.Context, audio io.Reader, filename, lyrics string) (*align.Result, error)
}

// postAlign kicks off word-timing alignment for a song. Auth-gated; 404 when the
// aligner is unconfigured; 409 if an alignment is already generating for the song.
func (h *songHandlers) postAlign(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	if h.aligner == nil {
		httpError(w, http.StatusNotFound, "alignment is not configured")
		return
	}
	song, err := h.repo.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		serverError(w, "get song", err)
		return
	}
	if song == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	if song.Lyrics == "" {
		httpError(w, http.StatusBadRequest, "song has no lyrics to align")
		return
	}
	if existing, err := h.repo.GetAlignment(r.Context(), song.ID); err != nil {
		serverError(w, "get alignment", err)
		return
	} else if existing != nil && existing.Status == "generating" {
		httpError(w, http.StatusConflict, "alignment already in progress")
		return
	}
	if err := h.repo.UpsertGeneratingAlignment(r.Context(), song.ID); err != nil {
		serverError(w, "start alignment", err)
		return
	}
	go h.runAlignment(song.ID, song.FilePath, song.Lyrics)
	w.WriteHeader(http.StatusAccepted)
	writeJSON(w, map[string]any{"status": "generating"})
}

// runAlignment drives one alignment to completion on a detached context and records
// the terminal state (fanart pattern). Audio streams from the stored file.
func (h *songHandlers) runAlignment(songID, relPath, lyrics string) {
	if h.onAlignComplete != nil {
		defer h.onAlignComplete(songID)
	}
	slog.Info("alignment started", "song", songID)
	f, err := h.media.Open(relPath)
	if err != nil {
		h.failAlignment(songID, "open audio: "+err.Error())
		return
	}
	defer f.Close()

	genCtx, cancel := context.WithTimeout(context.Background(), h.cfg.AlignTimeout+30*time.Second)
	defer cancel()
	res, err := h.aligner.Align(genCtx, f, filepath.Base(relPath), lyrics)
	if err != nil {
		h.failAlignment(songID, err.Error())
		return
	}
	data, err := json.Marshal(res.Lines)
	if err != nil {
		h.failAlignment(songID, "encode timings: "+err.Error())
		return
	}
	// Persist on a fresh context so an expired genCtx can't strand the row.
	persistCtx, pcancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer pcancel()
	if err := h.repo.MarkAlignmentReady(persistCtx, songID, res.Engine, string(data)); err != nil {
		slog.Error("alignment: record failed", "song", songID, "err", err)
		return
	}
	slog.Info("alignment completed", "song", songID, "lines", len(res.Lines))
}

func (h *songHandlers) failAlignment(songID, reason string) {
	slog.Error("alignment failed", "song", songID, "reason", reason)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = h.repo.MarkAlignmentFailed(ctx, songID, reason)
}

// getAlign returns the song's alignment status and, when ready, its line timings.
// The server-only failure reason is never included.
func (h *songHandlers) getAlign(w http.ResponseWriter, r *http.Request) {
	if !identify(h.cfg, r).Authenticated {
		httpError(w, http.StatusForbidden, "authentication required")
		return
	}
	a, err := h.repo.GetAlignment(r.Context(), r.PathValue("id"))
	if err != nil {
		serverError(w, "get alignment", err)
		return
	}
	if a == nil {
		httpError(w, http.StatusNotFound, "not found")
		return
	}
	out := map[string]any{"status": a.Status}
	if a.Status == "ready" {
		out["engine"] = a.Engine
		out["lines"] = json.RawMessage(a.Data) // already-encoded []Line
	}
	writeJSON(w, out)
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd backend && go test ./internal/httpapi/ -run 'TestPostAlign|TestGetAlign' -v`
Expected: PASS.

- [ ] **Step 6: Wire construction, routes, and the boot reaper**

In `backend/internal/httpapi/server.go`, inside `build(...)` where the `songHandlers` is constructed (~line 124-132), add after `onGenComplete: onGenComplete,`:
```go
				aligner: func() aligner {
					if cfg.AlignmentEnabled() {
						return align.New(cfg.AlignURL, cfg.AlignTimeout)
					}
					return nil // nil interface => feature off
				}(),
```
(Import `github.com/trick77/music/internal/align`.)

Register routes next to the other `/api/songs/{id}` routes (~line 150):
```go
			mux.HandleFunc("POST /api/songs/{id}/align", h.postAlign)
			mux.HandleFunc("GET /api/songs/{id}/align", h.getAlign)
```

Add the reaper next to `FailOrphanedGenerating` (~line 137):
```go
			_, _ = h.repo.FailOrphanedAlignments(context.Background())
```

> Gotcha: the aligner constructor returns a typed nil issue — assigning a nil `*align.Client` to the interface makes `h.aligner == nil` false. The IIFE above returns the untyped-nil interface value directly, so the `h.aligner == nil` check works. Do not assign a `*align.Client` variable that may be nil.

- [ ] **Step 7: Full backend verify + commit**

Run: `cd backend && go build ./... && go test ./...`
Expected: build OK, all packages PASS.
```bash
git add backend/internal/httpapi/alignment.go backend/internal/httpapi/alignment_test.go backend/internal/httpapi/songs.go backend/internal/httpapi/server.go
git commit -m "feat(align): alignment endpoints + async orchestration + wiring"
```

---

## Task 5: Alignment sidecar (Python)

**Files:**
- Create: `sidecar/align/grouping.py`
- Test: `sidecar/align/test_grouping.py`
- Create: `sidecar/align/app.py`
- Create: `sidecar/align/requirements.txt`
- Create: `sidecar/align/Containerfile`

**Interfaces:**
- HTTP contract (consumed by Task 3's client): `POST /align` multipart (`audio` file, `lyrics` text) → `{engine, lines:[{text,start,end,words:[{w,start,end,conf}]}]}`; `GET /health` → `{"status":"ok"}`.

The ML alignment itself requires the sidecar's runtime (torch/WhisperX/ffmpeg) and cannot run in CI, so the **testable seam is the pure word→line regrouping**, unit-tested without ML.

- [ ] **Step 1: Write the failing grouping test**

Create `sidecar/align/test_grouping.py`:
```python
from grouping import group_words_into_lines

def test_regroups_flat_words_by_line_word_counts():
    lines = ["hi there", "sing along now"]
    flat = [
        {"w": "hi", "start": 1.0, "end": 1.4, "conf": 0.9},
        {"w": "there", "start": 1.5, "end": 2.0, "conf": 0.8},
        {"w": "sing", "start": 3.0, "end": 3.3, "conf": 0.7},
        {"w": "along", "start": 3.4, "end": 3.8, "conf": 0.6},
        {"w": "now", "start": 3.9, "end": 4.2, "conf": 0.5},
    ]
    out = group_words_into_lines(lines, flat)
    assert len(out) == 2
    assert out[0]["text"] == "hi there"
    assert out[0]["start"] == 1.0 and out[0]["end"] == 2.0
    assert len(out[0]["words"]) == 2
    assert out[1]["text"] == "sing along now"
    assert out[1]["start"] == 3.0 and out[1]["end"] == 4.2
    assert len(out[1]["words"]) == 3

def test_handles_word_count_mismatch_without_crashing():
    # Fewer aligned words than expected: the last line simply gets what's left.
    lines = ["one two", "three four"]
    flat = [{"w": "one", "start": 0.0, "end": 0.5, "conf": 1.0}]
    out = group_words_into_lines(lines, flat)
    assert out[0]["words"][0]["w"] == "one"
    assert out[1]["words"] == []  # nothing left; empty, not an exception
```

- [ ] **Step 2: Run to verify failure**

Run: `cd sidecar/align && python -m pytest test_grouping.py -v`
Expected: FAIL — `grouping` module / function missing.

- [ ] **Step 3: Implement the pure grouping**

Create `sidecar/align/grouping.py`:
```python
"""Regroup a flat, time-ordered word list back into the original lyric lines.

The aligner is fed the whole lyric as one text and returns a flat word list. We
know each line's word count from the input lyrics, so we slice the flat list back
into lines deterministically. If the aligner produced fewer words than expected
(dropped an unalignable word), later lines get whatever remains (possibly empty)
rather than raising.
"""


def group_words_into_lines(lines, flat_words):
    out = []
    idx = 0
    for line in lines:
        n = len(line.split())
        chunk = flat_words[idx:idx + n]
        idx += n
        start = chunk[0]["start"] if chunk else None
        end = chunk[-1]["end"] if chunk else None
        out.append({"text": line, "start": start, "end": end, "words": chunk})
    return out
```

- [ ] **Step 4: Run to verify pass**

Run: `cd sidecar/align && python -m pytest test_grouping.py -v`
Expected: PASS.

- [ ] **Step 5: Write the FastAPI app (no unit test — needs the ML runtime)**

Create `sidecar/align/app.py`:
```python
"""Word-timing alignment sidecar.

POST /align  (multipart: audio file + lyrics text)  -> {engine, lines:[...]}
GET  /health -> {"status":"ok"}

Pipeline: Demucs isolates the vocal stem, then WhisperX's wav2vec2 alignment stage
force-aligns the KNOWN lyrics (fed as one whole-track segment) to the audio. We use
the known words, never ASR output, so wrong-word transcription can't happen — only
timing is inferred. The flat aligned word list is regrouped into the original lines.
"""
import os
import tempfile

import torch
import whisperx
from demucs.separate import main as demucs_main
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

from grouping import group_words_into_lines

app = FastAPI()
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
COMPUTE = "float16" if DEVICE == "cuda" else "int8"
ENGINE = "whisperx+demucs"

# Align model is language-specific; load lazily and cache per language.
_align_cache = {}


def _get_align_model(language):
    if language not in _align_cache:
        _align_cache[language] = whisperx.load_align_model(language_code=language, device=DEVICE)
    return _align_cache[language]


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/align")
async def align(audio: UploadFile = File(...), lyrics: str = Form(...), language: str = Form("en")):
    lines = [ln for ln in (l.strip() for l in lyrics.splitlines()) if ln]
    if not lines:
        return JSONResponse(status_code=400, content={"error": "no lyrics provided"})

    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in.mp3")
        with open(src, "wb") as fh:
            fh.write(await audio.read())

        # 1) Vocal isolation (Demucs) -> a cleaner signal for alignment.
        try:
            demucs_main(["--two-stems", "vocals", "-n", "htdemucs", "-o", tmp, src])
            vocal = os.path.join(tmp, "htdemucs", "in", "vocals.wav")
            target = vocal if os.path.exists(vocal) else src
        except Exception:
            target = src  # fall back to the full mix if separation fails

        # 2) Forced alignment of the KNOWN lyrics as one whole-track segment.
        try:
            wav = whisperx.load_audio(target)
            duration = len(wav) / 16000.0
            model, meta = _get_align_model(language)
            segments = [{"text": " ".join(lines), "start": 0.0, "end": duration}]
            aligned = whisperx.align(segments, model, meta, wav, DEVICE, return_char_alignments=False)
        except Exception as e:
            return JSONResponse(status_code=500, content={"error": f"alignment failed: {e}"})

    flat = [
        {"w": w.get("word", ""), "start": w.get("start"), "end": w.get("end"), "conf": w.get("score", 0.0)}
        for w in aligned.get("word_segments", [])
        if w.get("start") is not None and w.get("end") is not None
    ]
    return {"engine": ENGINE, "lines": group_words_into_lines(lines, flat)}
```

> Implementation note (from the spec's open questions): the single whole-track segment approach relies on wav2vec2 aligning a long segment. If quality is poor on long tracks, the fallback is to chunk the lyrics into a few multi-line segments with rough even time splits and align each — but ship the simple version first and evaluate.

- [ ] **Step 6: Write requirements + Containerfile**

Create `sidecar/align/requirements.txt`:
```
fastapi
uvicorn[standard]
python-multipart
whisperx
demucs
torch
```

Create `sidecar/align/Containerfile`:
```dockerfile
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY grouping.py app.py ./

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
```

- [ ] **Step 7: Commit**

```bash
git add sidecar/align/
git commit -m "feat(align): WhisperX+Demucs alignment sidecar"
```

- [ ] **Step 8: Manual smoke test (run in the sidecar container, documented not automated)**

```bash
# Build + run the sidecar:
docker build -t music-align sidecar/align
docker run --rm -p 8000:8000 music-align
# In another shell, align a short clip with known lyrics:
curl -s -F audio=@some-song.mp3 -F lyrics=$'first line\nsecond line' http://localhost:8000/align | jq .
```
Expected: JSON with `lines[].words[].start/end` monotonic non-decreasing and within the clip duration; every input word present.

---

## Task 6: Compose wiring + roadmap update

**Files:**
- Modify: `compose.yaml`
- Modify: `docs/karaoke-roadmap.md`

- [ ] **Step 1: Add the sidecar service to compose**

In `compose.yaml`, add an `align` service and point the app at it (`BACKEND_ALIGN_URL`). Add to the app service's environment:
```yaml
      - BACKEND_ALIGN_URL=http://align:8000
```
Add the service:
```yaml
  align:
    build: ./sidecar/align       # or image: ghcr.io/trick77/music-align:latest once published
    restart: unless-stopped
    # GPU (optional, ~10x faster). Uncomment with the NVIDIA container toolkit installed:
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: 1
    #           capabilities: [gpu]
```

- [ ] **Step 2: Flip the roadmap status**

In `docs/karaoke-roadmap.md`, change the Phase 2 row status from `🔨 In design` to `✅ Done (PR #NN)` once merged (leave a placeholder until the PR number exists).

- [ ] **Step 3: Commit**

```bash
git add compose.yaml docs/karaoke-roadmap.md
git commit -m "chore(align): compose sidecar service + roadmap update"
```

---

## Verification (whole feature)

- `cd backend && go build ./... && go test ./...` — all Go packages green (async orchestration, client, persistence, config, gating all covered without any ML).
- `cd sidecar/align && python -m pytest -v` — grouping logic green.
- Manual end-to-end (needs the sidecar running with `BACKEND_ALIGN_URL` set): log in, `POST /api/songs/:id/align` on a song that has lyrics → `202`; poll `GET /api/songs/:id/align` → eventually `{status:"ready", lines:[...]}` with per-word start/end. Clear-audio/absent cases: no lyrics → `400`; alignment disabled → `404`; anon → `403`; second POST while generating → `409`.

## Self-review notes

- **Spec coverage:** data flow (Task 4), sidecar contract (Tasks 3+5), data model (Task 1), API (Task 4), config/gating (Task 2), deployment (Task 6), testing (each task). Session flag (Task 2) is the only UI touch this phase — matches "engine only, no player."
- **Type consistency:** `align.{Word,Line,Result}` JSON tags (`w,start,end,conf` / `text,start,end,words` / `engine,lines`) are identical across the Go client (Task 3), the handler storage (Task 4 stores `res.Lines`), and the sidecar output (Task 5). The `aligner` interface signature matches `*align.Client.Align` exactly.
- **Deferred to implementer judgement:** the `store_test.go` migration-count constant in Task 1 (bump to the new count when the test fails). `media.New` / `config.AuthModeDev` names are verified against the codebase.
