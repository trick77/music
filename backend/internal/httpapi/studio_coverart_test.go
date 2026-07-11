package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/imagegen"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/store"
)

type studioCoverTS struct {
	dev  http.Handler
	anon http.Handler
	repo *library.Repo
}

// newStudioCoverServer builds an authed (dev) and anonymous (oidc) handler over a
// shared store. gen != nil sets the BFL key (ImageGenEnabled); studioConfigured
// sets the chat+Tavily keys (StudioEnabled). The real studio provider is built
// but never invoked by these tests (construction does no network I/O).
func newStudioCoverServer(t *testing.T, gen imagegen.Provider, studioConfigured bool) *studioCoverTS {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	mediaDir := t.TempDir()
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	mk := func(mode config.AuthMode) http.Handler {
		cfg := config.Config{
			AuthMode: mode, DevUser: config.DevUserConfig{Username: "dev"},
			MediaDir: mediaDir, MaxUploadMB: 50, BFLModel: "flux-2-klein-4b",
			BFLPollTimeout: 1_000_000_000,
		}
		if gen != nil {
			cfg.BFLAPIKey = "test-key"
		}
		if studioConfigured {
			cfg.ChatAPIKey = "chat-key"
			cfg.TavilyAPIKey = "tavily-key"
		}
		return NewWithProvider(cfg, st, spa, gen, nil)
	}
	return &studioCoverTS{
		dev:  mk(config.AuthModeDev),
		anon: mk(config.AuthModeOIDC),
		repo: library.NewRepo(st.DB()),
	}
}

func (ts *studioCoverTS) postCover(t *testing.T, h http.Handler, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/api/studio/coverart", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func okProvider(t *testing.T) fakeProvider {
	return fakeProvider{result: imagegen.GenerateResult{Bytes: pngBytes(t, 1024, 1024), MIMEType: "image/png", Extension: "png"}}
}

// capturingProvider records the request passed to Generate so tests can assert
// what the handler actually sent to the image API (not merely what it stored).
type capturingProvider struct {
	last   imagegen.GenerateRequest
	result imagegen.GenerateResult
}

func (c *capturingProvider) Generate(_ context.Context, req imagegen.GenerateRequest) (imagegen.GenerateResult, error) {
	c.last = req
	return c.result, nil
}

func TestStudioCoverArt_generatesAndPersists(t *testing.T) {
	prov := &capturingProvider{result: imagegen.GenerateResult{Bytes: pngBytes(t, 1024, 1024), MIMEType: "image/png", Extension: "png"}}
	ts := newStudioCoverServer(t, prov, true)
	rec := ts.postCover(t, ts.dev, map[string]any{"prompt": "  a neon skyline album cover  ", "model": "flux-2-pro"})
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d body %s", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), "neon skyline") {
		t.Fatalf("response leaked prompt: %s", rec.Body)
	}
	var out struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.Status != "ready" || out.ID == "" {
		t.Fatalf("bad response %s (err %v)", rec.Body, err)
	}
	// The handler must generate with the requested model, square dimensions, a
	// seed, and the trimmed prompt.
	if prov.last.Model != "flux-2-pro" || prov.last.Width != 1024 || prov.last.Height != 1024 || prov.last.Seed == nil {
		t.Fatalf("wrong request to provider: %#v", prov.last)
	}
	if prov.last.Prompt != "a neon skyline album cover" {
		t.Fatalf("prompt not trimmed before generation: %q", prov.last.Prompt)
	}
	row, err := ts.repo.GetStudioCoverArt(context.Background(), out.ID)
	if err != nil || row == nil {
		t.Fatalf("row not persisted: %v", err)
	}
	if row.Prompt != "a neon skyline album cover" || row.Model != "flux-2-pro" || row.Seed == nil {
		t.Fatalf("server-only fields not recorded: %#v", row)
	}
}

func TestStudioCoverArt_defaultsToConfiguredModelWhenOmitted(t *testing.T) {
	prov := &capturingProvider{result: imagegen.GenerateResult{Bytes: pngBytes(t, 1024, 1024), MIMEType: "image/png", Extension: "png"}}
	ts := newStudioCoverServer(t, prov, true)
	rec := ts.postCover(t, ts.dev, map[string]any{"prompt": "x"}) // no model
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d body %s", rec.Code, rec.Body)
	}
	if prov.last.Model != "flux-2-klein-4b" { // cfg.BFLModel in the harness
		t.Fatalf("omitted model should fall back to cfg.BFLModel, got %q", prov.last.Model)
	}
}

func TestStudioCoverArt_getMissingReturns404(t *testing.T) {
	ts := newStudioCoverServer(t, okProvider(t), true)
	rr := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr, httptest.NewRequest("GET", "/api/studio/coverart/does-not-exist", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404 for missing id", rr.Code)
	}
}

func TestStudioCoverArt_serveReturnsImageAndAnonForbidden(t *testing.T) {
	ts := newStudioCoverServer(t, okProvider(t), true)
	rec := ts.postCover(t, ts.dev, map[string]any{"prompt": "x", "model": "flux-2-klein-4b"})
	var out struct {
		ID string `json:"id"`
	}
	json.Unmarshal(rec.Body.Bytes(), &out)

	got := httptest.NewRecorder()
	ts.dev.ServeHTTP(got, httptest.NewRequest("GET", "/api/studio/coverart/"+out.ID, nil))
	if got.Code != http.StatusOK || got.Body.Len() == 0 {
		t.Fatalf("serve: code=%d len=%d", got.Code, got.Body.Len())
	}
	anon := httptest.NewRecorder()
	ts.anon.ServeHTTP(anon, httptest.NewRequest("GET", "/api/studio/coverart/"+out.ID, nil))
	if anon.Code != http.StatusForbidden {
		t.Fatalf("anon serve code = %d, want 403", anon.Code)
	}
}

func TestStudioCoverArt_disabledWhenNoImageGen(t *testing.T) {
	ts := newStudioCoverServer(t, nil, true) // studio configured, image gen not
	rec := ts.postCover(t, ts.dev, map[string]any{"prompt": "x"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", rec.Code)
	}
}

func TestStudioCoverArt_disabledWhenStudioOff(t *testing.T) {
	ts := newStudioCoverServer(t, okProvider(t), false) // image gen on, studio off
	rec := ts.postCover(t, ts.dev, map[string]any{"prompt": "x", "model": "flux-2-pro"})
	if rec.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", rec.Code)
	}
}

func TestStudioCoverArt_rejectsUnknownModel(t *testing.T) {
	ts := newStudioCoverServer(t, okProvider(t), true)
	rec := ts.postCover(t, ts.dev, map[string]any{"prompt": "x", "model": "evil/../path"})
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400", rec.Code)
	}
}

func TestStudioCoverArt_anonymousForbidden(t *testing.T) {
	ts := newStudioCoverServer(t, okProvider(t), true)
	rec := ts.postCover(t, ts.anon, map[string]any{"prompt": "x", "model": "flux-2-pro"})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", rec.Code)
	}
}

func TestStudioCoverArt_generationErrorIs502(t *testing.T) {
	ts := newStudioCoverServer(t, fakeProvider{err: errors.New("BFL blocked the prompt (request moderated)")}, true)
	rec := ts.postCover(t, ts.dev, map[string]any{"prompt": "x", "model": "flux-2-pro"})
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("code = %d, want 502", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "moderated") {
		t.Fatalf("leaked upstream detail: %s", rec.Body)
	}
}
