package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/store"
	"github.com/trick77/music/internal/studio"
)

type fakeGenrePrompter struct {
	prompt string
	err    error
	// gotShape records the PromptShape the handler passed to RefinePrompt. It is
	// a pointer so the fake can stay a value receiver while still recording.
	gotShape *studio.PromptShape
}

func (f fakeGenrePrompter) GenrePrompt(_ context.Context, _ string) (string, error) {
	return f.prompt, f.err
}

func (f fakeGenrePrompter) AlbumCoverPrompt(_ context.Context, _, _ string, _ []string, _ []library.SongLyric) (string, error) {
	return f.prompt, f.err
}

func (f fakeGenrePrompter) RefinePrompt(_ context.Context, _, _, _ string, shape studio.PromptShape) (string, error) {
	if f.gotShape != nil {
		*f.gotShape = shape
	}
	return f.prompt, f.err
}

// suggestServer builds a two-handler rig (dev + anon) over one store, wiring a
// fake genre prompter so no live LLM call is made.
func suggestServer(t *testing.T, gp *fakeGenrePrompter) (dev, anon http.Handler, genreID string) {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	if _, err := st.DB().ExecContext(context.Background(),
		`INSERT INTO genres(id,name) VALUES('g-jazz','Jazz')`); err != nil {
		t.Fatalf("seed genre: %v", err)
	}
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	mk := func(mode config.AuthMode) http.Handler {
		cfg := config.Config{AuthMode: mode, DevUser: config.DevUserConfig{Username: "dev"}, MediaDir: t.TempDir(), MaxUploadMB: 50}
		if gp != nil {
			return NewWithGenrePrompter(cfg, st, spa, nil, nil, gp)
		}
		return NewWithProvider(cfg, st, spa, nil, nil)
	}
	return mk(config.AuthModeDev), mk(config.AuthModeOIDC), "g-jazz"
}

func TestSuggestPrompt_returnsEditablePrompt(t *testing.T) {
	dev, _, genreID := suggestServer(t, &fakeGenrePrompter{prompt: "A smoky jazz club, warm lamplight, upright bass mid-solo. No text."})
	rr := httptest.NewRecorder()
	dev.ServeHTTP(rr, httptest.NewRequest("POST", "/api/genres/"+genreID+"/suggest-prompt", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d body %s", rr.Code, rr.Body)
	}
	if !strings.Contains(rr.Body.String(), "smoky jazz club") {
		t.Fatalf("missing prompt in body: %s", rr.Body)
	}
}

func TestSuggestPrompt_403WhenAnonymous(t *testing.T) {
	_, anon, genreID := suggestServer(t, &fakeGenrePrompter{prompt: "x"})
	rr := httptest.NewRecorder()
	anon.ServeHTTP(rr, httptest.NewRequest("POST", "/api/genres/"+genreID+"/suggest-prompt", nil))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rr.Code)
	}
}

func TestSuggestPrompt_404WhenChatDisabled(t *testing.T) {
	dev, _, genreID := suggestServer(t, nil) // no prompter wired => disabled
	rr := httptest.NewRecorder()
	dev.ServeHTTP(rr, httptest.NewRequest("POST", "/api/genres/"+genreID+"/suggest-prompt", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rr.Code)
	}
}

func TestSuggestPrompt_404WhenGenreUnknown(t *testing.T) {
	dev, _, _ := suggestServer(t, &fakeGenrePrompter{prompt: "x"})
	rr := httptest.NewRecorder()
	dev.ServeHTTP(rr, httptest.NewRequest("POST", "/api/genres/nope/suggest-prompt", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rr.Code)
	}
}
