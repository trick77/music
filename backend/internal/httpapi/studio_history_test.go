package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
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

func seedRuns(t *testing.T, repo *library.Repo, n int) {
	t.Helper()
	ctx := httptest.NewRequest("GET", "/", nil).Context()
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("run%02d", i)
		if err := repo.CreateStudioRun(ctx, library.StudioRun{
			ID: id, Reference: "ref " + id, StylePrompt: "s", Lyrics: "l", CoverArtPrompt: "c",
		}); err != nil {
			t.Fatalf("seed %s: %v", id, err)
		}
	}
}

// P1: the list is capped and pages with an explicit cursor, and it reports the
// total so the drawer can render "25 of N".
func TestStudioHistoryList_pagesAndReportsTotal(t *testing.T) {
	ts := newStudioHistoryServer(t, fakeStudio{})
	seedRuns(t, ts.repo, 30)

	rr := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr, httptest.NewRequest("GET", "/api/studio/history", nil))
	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	var page struct {
		Runs       []library.StudioRun `json:"runs"`
		Total      int                 `json:"total"`
		NextBefore int64               `json:"nextBefore"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(page.Runs) != 25 {
		t.Fatalf("returned %d runs, want the 25 cap", len(page.Runs))
	}
	if page.Total != 30 {
		t.Fatalf("total = %d, want 30", page.Total)
	}
	if page.Runs[0].ID != "run29" {
		t.Fatalf("first run = %s, want run29 (newest first)", page.Runs[0].ID)
	}
	if page.NextBefore == 0 {
		t.Fatalf("nextBefore must be set while more runs remain")
	}

	// Page two continues from the cursor and reports no further page.
	rr2 := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr2, httptest.NewRequest("GET",
		fmt.Sprintf("/api/studio/history?before=%d", page.NextBefore), nil))
	var page2 struct {
		Runs       []library.StudioRun `json:"runs"`
		NextBefore int64               `json:"nextBefore"`
	}
	if err := json.Unmarshal(rr2.Body.Bytes(), &page2); err != nil {
		t.Fatalf("decode page 2: %v", err)
	}
	if len(page2.Runs) != 5 {
		t.Fatalf("page 2 returned %d runs, want 5", len(page2.Runs))
	}
	if page2.NextBefore != 0 {
		t.Fatalf("nextBefore = %d on the last page, want 0", page2.NextBefore)
	}
	// No row may appear on both pages — the whole reason paging is keyset.
	if page2.Runs[0].ID == page.Runs[24].ID {
		t.Fatalf("page 2 repeats the last row of page 1 (%s)", page2.Runs[0].ID)
	}
	if page2.Runs[0].ID != "run04" {
		t.Fatalf("page 2 starts at %s, want run04", page2.Runs[0].ID)
	}
}

// An empty history is an empty array, never null: the drawer maps over it.
func TestStudioHistoryList_emptyIsAnArray(t *testing.T) {
	ts := newStudioHistoryServer(t, fakeStudio{})
	rr := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr, httptest.NewRequest("GET", "/api/studio/history", nil))
	if !strings.Contains(rr.Body.String(), `"runs":[]`) {
		t.Fatalf("body = %s, want an empty runs array", rr.Body)
	}
}

// A limit above the cap is clamped: the drawer must never be able to ask for the
// whole table.
func TestStudioHistoryList_clampsLimit(t *testing.T) {
	ts := newStudioHistoryServer(t, fakeStudio{})
	seedRuns(t, ts.repo, 60)
	rr := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr, httptest.NewRequest("GET", "/api/studio/history?limit=500", nil))
	var page struct {
		Runs []library.StudioRun `json:"runs"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(page.Runs) != maxHistoryLimit {
		t.Fatalf("returned %d runs, want the %d hard cap", len(page.Runs), maxHistoryLimit)
	}
}

// A junk or non-positive limit falls back to the default rather than erroring or
// returning nothing.
func TestStudioHistoryList_ignoresAJunkLimit(t *testing.T) {
	ts := newStudioHistoryServer(t, fakeStudio{})
	seedRuns(t, ts.repo, 30)
	for _, q := range []string{"?limit=abc", "?limit=0", "?limit=-5", "?before=nonsense"} {
		rr := httptest.NewRecorder()
		ts.dev.ServeHTTP(rr, httptest.NewRequest("GET", "/api/studio/history"+q, nil))
		var page struct {
			Runs []library.StudioRun `json:"runs"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &page); err != nil {
			t.Fatalf("%s decode: %v", q, err)
		}
		if len(page.Runs) != defaultHistoryLimit {
			t.Fatalf("%s returned %d runs, want the %d default", q, len(page.Runs), defaultHistoryLimit)
		}
	}
}

func TestStudioHistoryGet_returnsEverythingTheRunProduced(t *testing.T) {
	ts := newStudioHistoryServer(t, fakeStudio{})
	ctx := httptest.NewRequest("GET", "/", nil).Context()
	if err := ts.repo.CreateStudioRun(ctx, library.StudioRun{
		ID: "r1", Reference: "Metallica, Enter Sandman", ReferenceArtist: "Metallica",
		ReferenceTitle: "Enter Sandman", StylePrompt: "1991,thrash metal",
		Lyrics: "[Verse]\nx", CoverArtPrompt: "a door",
		Genres: []string{"thrash metal"},
		Bands:  []string{"Hollow Sabbath", "Ashen Verdict", "Grey Litany"},
		Titles: []string{"A", "B", "C"}, Albums: []string{"D", "E", "F"},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	rr := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr, httptest.NewRequest("GET", "/api/studio/history/r1", nil))
	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	var got library.StudioRun
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// All three of each — the detail view shows every idea, not just the first.
	if len(got.Bands) != 3 || len(got.Titles) != 3 || len(got.Albums) != 3 {
		t.Fatalf("idea lists truncated: %#v", got)
	}
	if got.ReferenceArtist != "Metallica" {
		t.Fatalf("ReferenceArtist = %q", got.ReferenceArtist)
	}
	if got.Lyrics != "[Verse]\nx" || got.StylePrompt != "1991,thrash metal" || got.CoverArtPrompt != "a door" {
		t.Fatalf("prompt parts missing: %#v", got)
	}
	// RowID is the server's paging cursor and must not leak into the payload.
	if strings.Contains(rr.Body.String(), "RowID") || strings.Contains(rr.Body.String(), "rowId") {
		t.Fatalf("the keyset cursor leaked into the run payload: %s", rr.Body)
	}
}

func TestStudioHistoryGet_404WhenMissing(t *testing.T) {
	ts := newStudioHistoryServer(t, fakeStudio{})
	rr := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr, httptest.NewRequest("GET", "/api/studio/history/nope", nil))
	if rr.Code != 404 {
		t.Fatalf("status = %d, want 404", rr.Code)
	}
}

// A hand edit in the lyrics textarea updates the saved copy without counting as
// a refine.
func TestStudioHistoryPatch_updatesLyricsWithoutCountingARefine(t *testing.T) {
	ts := newStudioHistoryServer(t, fakeStudio{})
	ctx := httptest.NewRequest("GET", "/", nil).Context()
	if err := ts.repo.CreateStudioRun(ctx, library.StudioRun{ID: "r1", Reference: "x", StylePrompt: "s", Lyrics: "old", CoverArtPrompt: "c"}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	rr := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr, httptest.NewRequest("PATCH", "/api/studio/history/r1",
		strings.NewReader(`{"lyrics":"hand edited"}`)))
	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	got, _ := ts.repo.GetStudioRun(ctx, "r1")
	if got.Lyrics != "hand edited" {
		t.Fatalf("Lyrics = %q", got.Lyrics)
	}
	if got.RefineCount != 0 {
		t.Fatalf("RefineCount = %d, want 0 — a hand edit is not a refine", got.RefineCount)
	}
}

func TestStudioHistoryPatch_attachesCoverArt(t *testing.T) {
	ts := newStudioHistoryServer(t, fakeStudio{})
	ctx := httptest.NewRequest("GET", "/", nil).Context()
	if err := ts.repo.CreateStudioRun(ctx, library.StudioRun{ID: "r1", Reference: "x", StylePrompt: "s", Lyrics: "l", CoverArtPrompt: "c"}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	rr := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr, httptest.NewRequest("PATCH", "/api/studio/history/r1",
		strings.NewReader(`{"coverArtId":"img1"}`)))
	if rr.Code != 200 {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	got, _ := ts.repo.GetStudioRun(ctx, "r1")
	if got.CoverArtID != "img1" {
		t.Fatalf("CoverArtID = %q, want img1", got.CoverArtID)
	}
	// A later lyrics-only patch must not clear the image it just attached.
	rr2 := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr2, httptest.NewRequest("PATCH", "/api/studio/history/r1",
		strings.NewReader(`{"lyrics":"edited"}`)))
	got, _ = ts.repo.GetStudioRun(ctx, "r1")
	if got.CoverArtID != "img1" {
		t.Fatalf("CoverArtID = %q after a lyrics patch, want img1 kept", got.CoverArtID)
	}
}

func TestStudioHistoryPatch_rejectsBadRequests(t *testing.T) {
	ts := newStudioHistoryServer(t, fakeStudio{})
	ctx := httptest.NewRequest("GET", "/", nil).Context()
	if err := ts.repo.CreateStudioRun(ctx, library.StudioRun{ID: "r1", Reference: "x", StylePrompt: "s", Lyrics: "l", CoverArtPrompt: "c"}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	for _, tc := range []struct {
		name, id, body string
		want           int
	}{
		{"malformed JSON", "r1", `{`, http.StatusBadRequest},
		{"lyrics too long", "r1", `{"lyrics":"` + strings.Repeat("a", maxLyricsLen+1) + `"}`, http.StatusBadRequest},
		{"unknown run", "nope", `{"lyrics":"x"}`, http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rr := httptest.NewRecorder()
			ts.dev.ServeHTTP(rr, httptest.NewRequest("PATCH", "/api/studio/history/"+tc.id, strings.NewReader(tc.body)))
			if rr.Code != tc.want {
				t.Fatalf("status = %d, want %d (body %s)", rr.Code, tc.want, rr.Body)
			}
		})
	}
}

// Deleting a run leaves its cover-art row alone: the image may be referenced
// elsewhere, and a dangling reference is worse than an unreferenced file.
func TestStudioHistoryDelete_removesRunButKeepsCoverArt(t *testing.T) {
	ts := newStudioHistoryServer(t, fakeStudio{})
	ctx := httptest.NewRequest("GET", "/", nil).Context()
	if err := ts.repo.CreateStudioCoverArt(ctx, "img1", "coverart/img1.png", "p", "m", nil, 1024, 1024); err != nil {
		t.Fatalf("CreateStudioCoverArt: %v", err)
	}
	if err := ts.repo.CreateStudioRun(ctx, library.StudioRun{ID: "r1", Reference: "x", StylePrompt: "s", Lyrics: "l", CoverArtPrompt: "c"}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := ts.repo.UpdateStudioRunCoverArt(ctx, "r1", "img1"); err != nil {
		t.Fatalf("UpdateStudioRunCoverArt: %v", err)
	}

	rr := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr, httptest.NewRequest("DELETE", "/api/studio/history/r1", nil))
	if rr.Code != 204 {
		t.Fatalf("status = %d, want 204", rr.Code)
	}
	if got, _ := ts.repo.GetStudioRun(ctx, "r1"); got != nil {
		t.Fatalf("run survived the delete")
	}
	img, _ := ts.repo.GetStudioCoverArt(ctx, "img1")
	if img == nil {
		t.Fatalf("cover art was deleted with the run")
	}
	// Deleting it again is still a 204 — the drawer may fire twice.
	rr2 := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr2, httptest.NewRequest("DELETE", "/api/studio/history/r1", nil))
	if rr2.Code != 204 {
		t.Fatalf("second delete = %d, want 204", rr2.Code)
	}
}

// Gating, per endpoint — the house requires this to be exhaustive.
func TestStudioHistory_403WhenAnonymous(t *testing.T) {
	ts := newStudioHistoryServer(t, fakeStudio{})
	for _, tc := range []struct{ method, path string }{
		{"GET", "/api/studio/history"},
		{"GET", "/api/studio/history/r1"},
		{"PATCH", "/api/studio/history/r1"},
		{"DELETE", "/api/studio/history/r1"},
	} {
		rr := httptest.NewRecorder()
		ts.anon.ServeHTTP(rr, httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`)))
		if rr.Code != 403 {
			t.Fatalf("%s %s = %d, want 403", tc.method, tc.path, rr.Code)
		}
	}
}

// The session flag must track the routes exactly: it is what hides the history
// icon on an install that has no history to show.
func TestSession_historyEnabledTracksTheRoutes(t *testing.T) {
	ts := newStudioHistoryServer(t, fakeStudio{})
	sessionFlag := func(h http.Handler) bool {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/auth/session", nil))
		var s struct {
			HistoryEnabled bool `json:"historyEnabled"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &s); err != nil {
			t.Fatalf("decode session: %v", err)
		}
		return s.HistoryEnabled
	}
	if !sessionFlag(ts.dev) {
		t.Fatalf("historyEnabled = false with a store, want true")
	}
	// Anonymous callers cannot use the routes, so the flag is false for them too.
	if sessionFlag(ts.anon) {
		t.Fatalf("historyEnabled = true for an anonymous caller, want false")
	}

	// No store, no history.
	cfg := config.Config{AuthMode: config.AuthModeDev, DevUser: config.DevUserConfig{Username: "dev"},
		ChatAPIKey: "chat-key", TavilyAPIKey: "tavily-key"}
	if sessionFlag(NewWithStudioProvider(cfg, nil, studioSPA(), fakeStudio{})) {
		t.Fatalf("historyEnabled = true with no store, want false")
	}
}
