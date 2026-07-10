package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/imagegen"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/store"
)

// fanartTS is a two-handler test rig over one shared store: the dev handler is
// always authenticated, the anon handler always anonymous — letting a single
// seeded DB be read from both perspectives (auth is server-global, not per-request).
type fanartTS struct {
	t    *testing.T
	st   *store.Store
	dev  http.Handler
	anon http.Handler
	repo *library.Repo
}

func newFanartServer(t *testing.T, gen imagegen.Provider, onGen func(string)) *fanartTS {
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
			BFLPollTimeout: 1_000_000_000, // 1s; overridden per test where needed
		}
		if gen != nil {
			cfg.BFLAPIKey = "test-key"
		}
		return NewWithProvider(cfg, st, spa, gen, onGen)
	}
	return &fanartTS{t: t, st: st, dev: mk(config.AuthModeDev), anon: mk(config.AuthModeOIDC), repo: library.NewRepo(st.DB())}
}

func newFanartTestServer(t *testing.T) *fanartTS     { return newFanartServer(t, nil, nil) }
func newFanartTestServerAnon(t *testing.T) *fanartTS { return newFanartServer(t, nil, nil) }

func (ts *fanartTS) handler(authed bool) http.Handler {
	if authed {
		return ts.dev
	}
	return ts.anon
}

func (ts *fanartTS) seedGenre(t *testing.T, name string) string {
	t.Helper()
	id := "genre-" + name
	if _, err := ts.st.DB().ExecContext(context.Background(),
		`INSERT INTO genres(id,name) VALUES(?,?)`, id, name); err != nil {
		t.Fatalf("seed genre: %v", err)
	}
	return id
}

func (ts *fanartTS) uploadFanart(t *testing.T, kind, genreID string, img []byte) *httptest.ResponseRecorder {
	return ts.uploadFanartAs(t, true, kind, genreID, img)
}

func (ts *fanartTS) uploadFanartAs(t *testing.T, authed bool, kind, genreID string, img []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "art.png")
	fw.Write(img)
	mw.WriteField("kind", kind)
	mw.WriteField("genreId", genreID)
	mw.Close()
	req := httptest.NewRequest("POST", "/api/fanart", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	ts.handler(authed).ServeHTTP(rr, req)
	return rr
}

func (ts *fanartTS) getJSON(t *testing.T, path string, authed bool) string {
	t.Helper()
	rr := httptest.NewRecorder()
	ts.handler(authed).ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
	return rr.Body.String()
}

func (ts *fanartTS) idFromResponse(t *testing.T, rr *httptest.ResponseRecorder) string {
	t.Helper()
	var out struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode id: %v (body %s)", err, rr.Body)
	}
	return out.ID
}

func (ts *fanartTS) seedFailedGeneratedFanart(t *testing.T, genreID, prompt, reason string) string {
	t.Helper()
	id, err := ts.repo.CreateGeneratingFanart(context.Background(), "genre", genreID, prompt, "flux-2-klein-4b", nil)
	if err != nil {
		t.Fatalf("seed generating: %v", err)
	}
	if err := ts.repo.MarkFanartFailed(context.Background(), id, reason); err != nil {
		t.Fatalf("mark failed: %v", err)
	}
	return id
}

// --- image fixtures ---

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x % 256), uint8(y % 256), 128, 255})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func solidPngBytes(t *testing.T, w, h int, r, g, bl uint8) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{r, g, bl, 255})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// --- Task 9 tests ---

func TestPostFanart_uploadAndAssignGenre(t *testing.T) {
	ts := newFanartTestServer(t)
	genreID := ts.seedGenre(t, "Jazz")
	rec := ts.uploadFanart(t, "genre", genreID, pngBytes(t, 8, 8))
	if rec.Code != http.StatusCreated {
		t.Fatalf("code = %d, body %s", rec.Code, rec.Body)
	}
	if s := rec.Body.String(); strings.Contains(s, "image_path") || strings.Contains(s, "\"prompt\"") || strings.Contains(s, "imagePath") {
		t.Fatalf("upload response leaked server-only fields: %s", s)
	}
}

func TestPostFanart_anonymousForbidden(t *testing.T) {
	ts := newFanartTestServerAnon(t)
	genreID := ts.seedGenre(t, "Jazz")
	rec := ts.uploadFanartAs(t, false, "genre", genreID, pngBytes(t, 8, 8))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("anonymous upload code = %d, want 403", rec.Code)
	}
}

func TestGetFanartMeta_scrubbedForAnonymous(t *testing.T) {
	ts := newFanartTestServer(t)
	genreID := ts.seedGenre(t, "Jazz")
	id := ts.seedFailedGeneratedFanart(t, genreID, "smoky club prompt", "request moderated")
	// Anonymous meta: no error text, no prompt.
	body := ts.getJSON(t, "/api/fanart/"+id+"?meta=1", false)
	if strings.Contains(body, "smoky club") || strings.Contains(body, "moderated") {
		t.Fatalf("anonymous meta leaked AI/error text: %s", body)
	}
	// Authenticated meta: error surfaced (for the editor), still no prompt.
	abody := ts.getJSON(t, "/api/fanart/"+id+"?meta=1", true)
	if !strings.Contains(abody, "moderated") {
		t.Fatalf("authenticated meta should include error: %s", abody)
	}
	if strings.Contains(abody, "smoky club") {
		t.Fatalf("meta must never include the prompt: %s", abody)
	}
}

func TestGetGenreExtended_hidesNonReadyFromAnonymous(t *testing.T) {
	ts := newFanartTestServer(t)
	genreID := ts.seedGenre(t, "Jazz")
	ts.seedFailedGeneratedFanart(t, genreID, "p", "boom")
	// Anonymous sees zero fanart (the only row is failed).
	var anon struct {
		Fanart []map[string]any `json:"fanart"`
	}
	json.Unmarshal([]byte(ts.getJSON(t, "/api/genres/"+genreID, false)), &anon)
	if len(anon.Fanart) != 0 {
		t.Fatalf("anonymous should see no non-ready fanart, got %d", len(anon.Fanart))
	}
	// Authenticated sees the failed tile.
	var authed struct {
		Fanart []map[string]any `json:"fanart"`
	}
	json.Unmarshal([]byte(ts.getJSON(t, "/api/genres/"+genreID, true)), &authed)
	if len(authed.Fanart) != 1 {
		t.Fatalf("authenticated should see the failed tile, got %d", len(authed.Fanart))
	}
}
