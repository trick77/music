package httpapi

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/store"
	"github.com/trick77/music/internal/studio"
)

// errFakeStudio is the canned provider failure these tests drive the error paths
// with. fakeStudio returns it verbatim; the handler must never leak it.
var errFakeStudio = errors.New("mimo exploded")

// studioHistTS is an authed and an anonymous handler over one shared store, plus
// a repo handle so a test can reach past HTTP and assert what was written.
type studioHistTS struct {
	dev  http.Handler
	anon http.Handler
	repo *library.Repo
}

// newStudioHistoryServer mirrors newStudioCoverServer: one store, two handlers,
// a fake studio provider so no live LLM call is made. The chat/Tavily keys make
// studio "configured" so the generate and refine routes answer.
func newStudioHistoryServer(t *testing.T, provider studio.Provider) *studioHistTS {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	mediaDir := t.TempDir()
	mk := func(mode config.AuthMode) http.Handler {
		cfg := config.Config{
			AuthMode: mode, DevUser: config.DevUserConfig{Username: "dev"},
			MediaDir: mediaDir, MaxUploadMB: 50,
			ChatAPIKey: "chat-key", TavilyAPIKey: "tavily-key",
		}
		h := NewWithStudioProvider(cfg, st, studioSPA(), provider)
		// The audio-info backfill runs on a goroutine that must not outlive the
		// temp dirs it reads from (see server.Wait).
		if s, ok := h.(*server); ok {
			t.Cleanup(s.Wait)
		}
		return h
	}
	return &studioHistTS{
		dev:  mk(config.AuthModeDev),
		anon: mk(config.AuthModeOIDC),
		repo: library.NewRepo(st.DB()),
	}
}

// A completed generate writes exactly one row, carrying every field the run
// produced, and tells the client its id so a later refine can update it.
func TestStudioGenerate_persistsTheRun(t *testing.T) {
	ts := newStudioHistoryServer(t, fakeStudio{result: studio.GenerateResult{
		StylePrompt: "1991,thrash metal", Lyrics: "[Verse]\nx", CoverArtPrompt: "a door",
		Genres: []string{"thrash metal"}, Bands: []string{"Hollow Sabbath"},
		Titles: []string{"Sleep Is a Door"}, Albums: []string{"Nightfall Sessions"},
		ReferenceArtist: "Metallica", ReferenceTitle: "Enter Sandman",
	}})
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/studio/generate",
		strings.NewReader(`{"reference":"Metallica, Enter Sandman"}`))
	ts.dev.ServeHTTP(rr, req)

	if !strings.Contains(rr.Body.String(), "event: saved") {
		t.Fatalf("no saved event in stream: %q", rr.Body.String())
	}
	// The saved event must come after the result: the client threads the id into
	// the run it already has on screen.
	if strings.Index(rr.Body.String(), "event: result") > strings.Index(rr.Body.String(), "event: saved") {
		t.Fatalf("saved event precedes result: %q", rr.Body.String())
	}
	runs, err := ts.repo.ListStudioRuns(req.Context(), 25, 0)
	if err != nil {
		t.Fatalf("ListStudioRuns: %v", err)
	}
	if len(runs) != 1 {
		t.Fatalf("stored %d runs, want 1", len(runs))
	}
	got := runs[0]
	if got.Reference != "Metallica, Enter Sandman" {
		t.Fatalf("Reference = %q", got.Reference)
	}
	if got.ReferenceTitle != "Enter Sandman" || got.ReferenceArtist != "Metallica" {
		t.Fatalf("reference metadata not stored: %#v", got)
	}
	if len(got.Bands) != 1 || got.Bands[0] != "Hollow Sabbath" {
		t.Fatalf("Bands = %#v", got.Bands)
	}
	if got.StylePrompt != "1991,thrash metal" || got.Lyrics != "[Verse]\nx" || got.CoverArtPrompt != "a door" {
		t.Fatalf("prompt parts not stored: %#v", got)
	}
	// The saved event must carry the id of the row that was actually written.
	if !strings.Contains(rr.Body.String(), got.ID) {
		t.Fatalf("saved event does not carry the row id %q", got.ID)
	}
}

// A failed run leaves nothing behind — history holds finished runs only.
func TestStudioGenerate_failedRunIsNotPersisted(t *testing.T) {
	ts := newStudioHistoryServer(t, fakeStudio{err: errFakeStudio})
	rr := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr, httptest.NewRequest("POST", "/api/studio/generate",
		strings.NewReader(`{"reference":"x"}`)))
	runs, _ := ts.repo.ListStudioRuns(httptest.NewRequest("GET", "/", nil).Context(), 25, 0)
	if len(runs) != 0 {
		t.Fatalf("stored %d runs after a failure, want 0", len(runs))
	}
}

// A refine overwrites the run's saved lyrics rather than adding a second entry.
func TestStudioRefine_overwritesTheSavedRun(t *testing.T) {
	ts := newStudioHistoryServer(t, fakeStudio{lyrics: "[Verse]\nrewritten"})
	ctx := httptest.NewRequest("GET", "/", nil).Context()
	if err := ts.repo.CreateStudioRun(ctx, library.StudioRun{
		ID: "run1", Reference: "x", StylePrompt: "s", Lyrics: "[Verse]\nold", CoverArtPrompt: "c",
	}); err != nil {
		t.Fatalf("CreateStudioRun: %v", err)
	}
	rr := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr, httptest.NewRequest("POST", "/api/studio/refine",
		strings.NewReader(`{"reference":"x","lyrics":"[Verse]\nold","instruction":"darker","historyId":"run1"}`)))

	got, _ := ts.repo.GetStudioRun(ctx, "run1")
	if got.Lyrics != "[Verse]\nrewritten" {
		t.Fatalf("saved lyrics = %q, want the rewritten ones", got.Lyrics)
	}
	if got.RefineCount != 1 {
		t.Fatalf("RefineCount = %d, want 1", got.RefineCount)
	}
	runs, _ := ts.repo.ListStudioRuns(ctx, 25, 0)
	if len(runs) != 1 {
		t.Fatalf("refine created %d rows, want the original 1", len(runs))
	}
}

// historyId is optional: refining a run that was never saved (no store, or a
// deleted row) must still return the rewrite.
func TestStudioRefine_withoutAHistoryIDStillWorks(t *testing.T) {
	ts := newStudioHistoryServer(t, fakeStudio{lyrics: "[Verse]\nrewritten"})
	rr := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr, httptest.NewRequest("POST", "/api/studio/refine",
		strings.NewReader(`{"reference":"x","lyrics":"[Verse]\nold","instruction":"darker"}`)))
	if !strings.Contains(rr.Body.String(), "event: result") {
		t.Fatalf("refine without a history id broke: %q", rr.Body.String())
	}
	runs, _ := ts.repo.ListStudioRuns(httptest.NewRequest("GET", "/", nil).Context(), 25, 0)
	if len(runs) != 0 {
		t.Fatalf("a refine invented %d history rows, want 0", len(runs))
	}
}

// Studio must still work with no library configured — the write is simply skipped.
func TestStudioGenerate_worksWithoutAStore(t *testing.T) {
	cfg := config.Config{AuthMode: config.AuthModeDev, DevUser: config.DevUserConfig{Username: "dev"},
		ChatAPIKey: "chat-key", TavilyAPIKey: "tavily-key"}
	h := NewWithStudioProvider(cfg, nil, studioSPA(), fakeStudio{result: studio.GenerateResult{
		StylePrompt: "s", Lyrics: "l", CoverArtPrompt: "c"}})
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("POST", "/api/studio/generate", strings.NewReader(`{"reference":"x"}`)))
	if !strings.Contains(rr.Body.String(), "event: result") {
		t.Fatalf("generate broke without a store: %q", rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), "event: saved") {
		t.Fatalf("emitted a saved event with no store to save to")
	}
}
