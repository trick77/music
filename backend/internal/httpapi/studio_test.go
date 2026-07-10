package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/studio"
)

type fakeStudio struct {
	result studio.GenerateResult
	lyrics string
	err    error
}

func (f fakeStudio) Generate(_ context.Context, req studio.GenerateRequest, onProgress studio.ProgressFunc) (studio.GenerateResult, error) {
	if onProgress != nil {
		onProgress(studio.Progress{Phase: "researching", Detail: "Searching the web for " + req.Reference})
	}
	if f.err != nil {
		return studio.GenerateResult{}, f.err
	}
	return f.result, nil
}

func (f fakeStudio) Refine(_ context.Context, _ studio.RefineRequest, onProgress studio.ProgressFunc) (string, error) {
	if onProgress != nil {
		onProgress(studio.Progress{Phase: "composing", Detail: "Rewriting the lyrics"})
	}
	if f.err != nil {
		return "", f.err
	}
	return f.lyrics, nil
}

func studioSPA() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
}

func TestStudioGenerate_streamsProgressThenResult(t *testing.T) {
	fake := fakeStudio{result: studio.GenerateResult{
		StylePrompt: "1990s,heavy metal", Lyrics: "[Verse]\nfresh", CoverArtPrompt: "1991 thrash cover",
	}}
	cfg := config.Config{AuthMode: config.AuthModeDev, DevUser: config.DevUserConfig{Username: "dev"}}
	h := NewWithStudioProvider(cfg, nil, studioSPA(), fake)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/studio/generate", strings.NewReader(`{"reference":"Metallica, Enter Sandman"}`))
	h.ServeHTTP(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status = %d", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Fatalf("content-type = %q", ct)
	}
	body := rr.Body.String()
	if !strings.Contains(body, "event: progress") || !strings.Contains(body, "Searching the web for Metallica, Enter Sandman") {
		t.Fatalf("missing progress event: %s", body)
	}
	if !strings.Contains(body, "event: result") || !strings.Contains(body, "1990s,heavy metal") || !strings.Contains(body, "1991 thrash cover") {
		t.Fatalf("missing result event: %s", body)
	}
}

func TestStudioGenerate_403WhenAnonymous(t *testing.T) {
	cfg := config.Config{AuthMode: config.AuthModeOIDC}
	h := NewWithStudioProvider(cfg, nil, studioSPA(), fakeStudio{})
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("POST", "/api/studio/generate", strings.NewReader(`{"reference":"x"}`)))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", rr.Code)
	}
}

func TestStudioGenerate_404WhenNotConfigured(t *testing.T) {
	// New() with no chat/tavily keys => provider nil => disabled => 404.
	cfg := config.Config{AuthMode: config.AuthModeDev, DevUser: config.DevUserConfig{Username: "dev"}}
	h := New(cfg, nil, studioSPA())
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("POST", "/api/studio/generate", strings.NewReader(`{"reference":"x"}`)))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rr.Code)
	}
}

func TestStudioGenerate_400WhenReferenceMissing(t *testing.T) {
	cfg := config.Config{AuthMode: config.AuthModeDev, DevUser: config.DevUserConfig{Username: "dev"}}
	h := NewWithStudioProvider(cfg, nil, studioSPA(), fakeStudio{})
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("POST", "/api/studio/generate", strings.NewReader(`{"reference":""}`)))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
}

func TestStudioGenerate_400WhenReferenceTooLong(t *testing.T) {
	cfg := config.Config{AuthMode: config.AuthModeDev, DevUser: config.DevUserConfig{Username: "dev"}}
	h := NewWithStudioProvider(cfg, nil, studioSPA(), fakeStudio{})
	long := strings.Repeat("a", 400)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("POST", "/api/studio/generate", strings.NewReader(`{"reference":"`+long+`"}`)))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
}

func TestStudioRefine_streamsUpdatedLyrics(t *testing.T) {
	fake := fakeStudio{lyrics: "[Verse]\nno forbidden word"}
	cfg := config.Config{AuthMode: config.AuthModeDev, DevUser: config.DevUserConfig{Username: "dev"}}
	h := NewWithStudioProvider(cfg, nil, studioSPA(), fake)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/studio/refine",
		strings.NewReader(`{"reference":"Metallica, Enter Sandman","lyrics":"[Verse]\nold","instruction":"do not say lullaby"}`))
	h.ServeHTTP(rr, req)

	if rr.Code != 200 {
		t.Fatalf("status = %d", rr.Code)
	}
	body := rr.Body.String()
	if !strings.Contains(body, "event: result") || !strings.Contains(body, "no forbidden word") {
		t.Fatalf("missing refine result: %s", body)
	}
}
