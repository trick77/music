package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

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

func (f fakeAligner) Align(_ context.Context, audio io.Reader, _, _ string) (*align.Result, error) {
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
	h.initAlignQueue() // Phase 3: single serial worker drains the queue
	return h, song.ID
}

// seedAlignableSong adds another song backed by a real tiny file to h's repo and
// returns its id, for tests that need multiple concurrent enqueues.
func seedAlignableSong(t *testing.T, h *songHandlers, n int) string {
	t.Helper()
	rel := "songs/x" + string(rune('0'+n)) + ".mp3"
	f, err := h.media.Create(rel)
	if err != nil {
		t.Fatalf("media.Create: %v", err)
	}
	io.WriteString(f, "AUDIO")
	f.Close()
	song, err := h.repo.Create(context.Background(), library.NewID(), library.CreateSongParams{
		Title: "T" + rel, ArtistName: "A", FilePath: rel, ContentHash: "h" + rel, Lyrics: "hi there",
	})
	if err != nil {
		t.Fatalf("seed song: %v", err)
	}
	return song.ID
}

// waitFor polls cond up to ~2s, failing the test if it never becomes true.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("condition not met within timeout")
}

// serialSpyAligner records the max concurrent Align calls and blocks each call
// until released, proving the worker runs jobs strictly one at a time.
type serialSpyAligner struct {
	mu       sync.Mutex
	inFlight int
	maxSeen  int
	release  chan struct{}
}

func (s *serialSpyAligner) Align(_ context.Context, audio io.Reader, _, _ string) (*align.Result, error) {
	_, _ = io.Copy(io.Discard, audio)
	s.mu.Lock()
	s.inFlight++
	if s.inFlight > s.maxSeen {
		s.maxSeen = s.inFlight
	}
	s.mu.Unlock()
	<-s.release
	s.mu.Lock()
	s.inFlight--
	s.mu.Unlock()
	return &align.Result{Engine: "stub", Lines: []align.Line{}}, nil
}

func TestAlignQueue_RunsOneAtATime(t *testing.T) {
	spy := &serialSpyAligner{release: make(chan struct{})}
	h, id0 := alignTestHandler(t, spy)
	ctx := context.Background()
	ids := []string{id0, seedAlignableSong(t, h, 1), seedAlignableSong(t, h, 2)}

	for _, id := range ids {
		song, _ := h.repo.Get(ctx, id)
		started, err := h.enqueueAlignment(ctx, song.ID, song.FilePath, song.Lyrics)
		if err != nil || !started {
			t.Fatalf("enqueue %s: started=%v err=%v", id, started, err)
		}
	}

	// Only ONE job may be in flight at a time.
	waitFor(t, func() bool { spy.mu.Lock(); defer spy.mu.Unlock(); return spy.inFlight == 1 })
	spy.mu.Lock()
	if spy.maxSeen != 1 {
		spy.mu.Unlock()
		t.Fatalf("expected serial execution, maxSeen=%d", spy.maxSeen)
	}
	spy.mu.Unlock()

	close(spy.release) // let all three drain
	waitFor(t, func() bool {
		a, _ := h.repo.GetAlignment(ctx, ids[2])
		return a != nil && a.Status == "ready"
	})
	spy.mu.Lock()
	defer spy.mu.Unlock()
	if spy.maxSeen != 1 {
		t.Fatalf("serialization violated, maxSeen=%d", spy.maxSeen)
	}
}

func alignReq(t *testing.T, method, id string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, "/api/songs/"+id+"/align", nil)
	req.SetPathValue("id", id)
	return req
}

func TestPostAlign_disabledReturns404(t *testing.T) {
	h, id := alignTestHandler(t, nil) // nil aligner = disabled
	rr := httptest.NewRecorder()
	h.postAlign(rr, alignReq(t, "POST", id))
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
	h.postAlign(rr, alignReq(t, "POST", id))
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
	h.postAlign(rr, alignReq(t, "POST", id))
	<-done
	a, _ := h.repo.GetAlignment(context.Background(), id)
	if a == nil || a.Status != "failed" {
		t.Fatalf("want failed, got %+v", a)
	}
}

func TestPostAlign_conflictWhileGenerating(t *testing.T) {
	h, id := alignTestHandler(t, fakeAligner{res: &align.Result{Engine: "fake"}})
	// Pre-seed a generating row.
	_, _ = h.repo.StartAlignment(context.Background(), id)
	rr := httptest.NewRecorder()
	h.postAlign(rr, alignReq(t, "POST", id))
	if rr.Code != http.StatusConflict {
		t.Fatalf("re-POST while generating = %d, want 409", rr.Code)
	}
}

func TestGetAlign_reflectsStatus(t *testing.T) {
	h, id := alignTestHandler(t, fakeAligner{res: &align.Result{Engine: "fake"}})
	// Not requested yet -> 404.
	rr := httptest.NewRecorder()
	h.getAlign(rr, alignReq(t, "GET", id))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("absent GET = %d, want 404", rr.Code)
	}
	// Ready -> 200 with lines, no error field. Seed the row first (the real flow
	// always upserts 'generating' before the goroutine marks it ready).
	_, _ = h.repo.StartAlignment(context.Background(), id)
	_ = h.repo.MarkAlignmentReady(context.Background(), id, "fake", `[{"text":"hi","start":1,"end":2,"words":[]}]`)
	rr = httptest.NewRecorder()
	h.getAlign(rr, alignReq(t, "GET", id))
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
