package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/imagegen"
	"github.com/trick77/music/internal/studio"
)

// --- POST /api/fanart (upload) ---

func TestPostFanart_rejectsBadKindAndGenre(t *testing.T) {
	ts := newFanartTestServer(t)
	img := pngBytes(t, 32, 32)

	for _, tc := range []struct {
		name, kind, genreID string
	}{
		{"unknown kind", "sticker", ""},
		{"empty kind", "", ""},
		{"genre kind without an id", "genre", ""},
		{"genre kind with an unknown id", "genre", "no-such-genre"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rr := ts.uploadFanart(t, tc.kind, tc.genreID, img)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("code = %d, want 400 (body %s)", rr.Code, rr.Body)
			}
		})
	}
}

// A hero upload is genre-less by definition: any genreId sent along is dropped.
func TestPostFanart_heroDropsGenreID(t *testing.T) {
	ts := newFanartTestServer(t)
	genreID := ts.seedGenre(t, "Jazz")
	rr := ts.uploadFanart(t, "hero", genreID, pngBytes(t, 32, 32))
	if rr.Code != http.StatusCreated {
		t.Fatalf("code = %d, want 201 (body %s)", rr.Code, rr.Body)
	}
	var fa struct {
		ID      string `json:"id"`
		Kind    string `json:"kind"`
		GenreID string `json:"genreId"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &fa); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if fa.Kind != "hero" || fa.GenreID != "" {
		t.Fatalf("hero fanart = %+v, want an empty genreId", fa)
	}
}

func TestPostFanart_nonImageIs415(t *testing.T) {
	ts := newFanartTestServer(t)
	genreID := ts.seedGenre(t, "Jazz")
	rr := ts.uploadFanart(t, "genre", genreID, []byte("not an image at all"))
	if rr.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("code = %d, want 415 (body %s)", rr.Code, rr.Body)
	}
}

func TestPostFanart_missingFileFieldIs400(t *testing.T) {
	ts := newFanartTestServer(t)
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	mw.WriteField("kind", "hero")
	mw.Close()
	req := httptest.NewRequest("POST", "/api/fanart", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400 (body %s)", rr.Code, rr.Body)
	}
}

// --- GET /api/fanart/{id} ---

func TestGetFanart_servesImageAndSizedVariant(t *testing.T) {
	ts := newFanartTestServer(t)
	genreID := ts.seedGenre(t, "Jazz")
	id := ts.idFromResponse(t, ts.uploadFanart(t, "genre", genreID, pngBytes(t, 64, 48)))

	full := httptest.NewRecorder()
	ts.dev.ServeHTTP(full, httptest.NewRequest("GET", "/api/fanart/"+id, nil))
	if full.Code != http.StatusOK || full.Body.Len() == 0 {
		t.Fatalf("serve = %d, %d bytes", full.Code, full.Body.Len())
	}
	sized := httptest.NewRecorder()
	ts.dev.ServeHTTP(sized, httptest.NewRequest("GET", "/api/fanart/"+id+"?size=thumb", nil))
	if sized.Code != http.StatusOK {
		t.Fatalf("sized serve = %d", sized.Code)
	}
	if ct := sized.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("sized Content-Type = %q, want image/jpeg", ct)
	}
}

func TestGetFanart_unknownAndNotReady(t *testing.T) {
	ts := newFanartTestServer(t)
	genreID := ts.seedGenre(t, "Jazz")

	unknown := httptest.NewRecorder()
	ts.dev.ServeHTTP(unknown, httptest.NewRequest("GET", "/api/fanart/ghost", nil))
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("unknown fanart = %d, want 404", unknown.Code)
	}

	// A failed generation has no image; the bytes route 404s while ?meta= still
	// reports its status so the editor can render the failure.
	failed := ts.seedFailedGeneratedFanart(t, genreID, "a smoky club", "moderated")
	img := httptest.NewRecorder()
	ts.dev.ServeHTTP(img, httptest.NewRequest("GET", "/api/fanart/"+failed, nil))
	if img.Code != http.StatusNotFound {
		t.Fatalf("failed fanart image = %d, want 404", img.Code)
	}
	if meta := ts.getJSON(t, "/api/fanart/"+failed+"?meta=1", true); !strings.Contains(meta, `"status":"failed"`) {
		t.Fatalf("meta = %s, want a failed status", meta)
	}
}

// --- POST /api/fanart/generate validation ---

func TestFanartGenerate_rejectsBadRequests(t *testing.T) {
	ts := newFanartTestServerWithGen(t, fakeProvider{
		result: imagegen.GenerateResult{Bytes: pngBytes(t, 8, 8), MIMEType: "image/png", Extension: "png"},
	}, func(string) {})
	genreID := ts.seedGenre(t, "Jazz")

	t.Run("malformed JSON", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/api/fanart/generate", strings.NewReader(`{`))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		ts.dev.ServeHTTP(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("code = %d, want 400", rr.Code)
		}
	})
	for _, tc := range []struct {
		name string
		body map[string]any
	}{
		{"missing prompt", map[string]any{"kind": "hero"}},
		{"unknown kind", map[string]any{"prompt": "x", "kind": "sticker"}},
		{"genre kind without an id", map[string]any{"prompt": "x", "kind": "genre"}},
		{"genre kind with an unknown id", map[string]any{"prompt": "x", "kind": "genre", "genreId": "ghost"}},
		{"unknown model", map[string]any{"prompt": "x", "kind": "genre", "genreId": genreID, "model": "../evil"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rr := ts.generate(t, tc.body)
			if rr.Code != http.StatusBadRequest {
				t.Fatalf("code = %d, want 400 (body %s)", rr.Code, rr.Body)
			}
		})
	}
}

func TestFanartGenerate_anonymousForbidden(t *testing.T) {
	ts := newFanartTestServerWithGen(t, fakeProvider{
		result: imagegen.GenerateResult{Bytes: pngBytes(t, 8, 8), Extension: "png"},
	}, func(string) {})
	req := httptest.NewRequest("POST", "/api/fanart/generate", strings.NewReader(`{"prompt":"x","kind":"hero"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	ts.anon.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", rr.Code)
	}
}

// A hero generation needs no genre and completes into a ready row.
func TestFanartGenerate_heroCompletes(t *testing.T) {
	done := make(chan string, 1)
	ts := newFanartTestServerWithGen(t, fakeProvider{
		result: imagegen.GenerateResult{Bytes: pngBytes(t, 1344, 768), MIMEType: "image/png", Extension: "png"},
	}, func(id string) { done <- id })

	rec := ts.generate(t, map[string]any{"prompt": "a wide neon skyline", "kind": "hero", "genreId": "ignored"})
	if rec.Code != http.StatusAccepted {
		t.Fatalf("code = %d, body %s", rec.Code, rec.Body)
	}
	id := ts.idFromResponse(t, rec)
	<-done
	if meta := ts.getJSON(t, "/api/fanart/"+id+"?meta=1", true); !strings.Contains(meta, `"status":"ready"`) {
		t.Fatalf("meta = %s, want a ready status", meta)
	}
	if meta := ts.getJSON(t, "/api/fanart/"+id+"?meta=1", true); !strings.Contains(meta, `"genreId":""`) {
		t.Fatalf("hero generation kept a genre id: %s", meta)
	}
}

// --- PATCH /api/genres/{id} ---

func TestPatchGenre_rejectsBadRequests(t *testing.T) {
	ts := newFanartTestServer(t)
	genreID := ts.seedGenre(t, "Jazz")

	patch := func(id, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("PATCH", "/api/genres/"+id, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		ts.dev.ServeHTTP(rr, req)
		return rr
	}

	if rr := patch("ghost", `{"name":"X"}`); rr.Code != http.StatusNotFound {
		t.Fatalf("unknown genre = %d, want 404", rr.Code)
	}
	if rr := patch(genreID, `{"name":`); rr.Code != http.StatusBadRequest {
		t.Fatalf("malformed JSON = %d, want 400", rr.Code)
	}
	if rr := patch(genreID, `{"name":""}`); rr.Code != http.StatusBadRequest {
		t.Fatalf("blank name = %d, want 400", rr.Code)
	}
	if rr := patch(genreID, `{"heroFanartId":"no-such-fanart"}`); rr.Code != http.StatusBadRequest {
		t.Fatalf("unknown hero = %d, want 400", rr.Code)
	}
}

// Promoting a hero and clearing it again both round-trip through the genre's
// extended view.
func TestPatchGenre_setAndClearHero(t *testing.T) {
	ts := newFanartTestServer(t)
	genreID := ts.seedGenre(t, "Jazz")
	// Promote one of the genre's own images: heroId in the extended view is
	// drawn from that genre's gallery.
	heroID := ts.idFromResponse(t, ts.uploadFanart(t, "genre", genreID, pngBytes(t, 64, 32)))

	patch := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("PATCH", "/api/genres/"+genreID, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		ts.dev.ServeHTTP(rr, req)
		return rr
	}

	set := patch(`{"heroFanartId":"` + heroID + `"}`)
	if set.Code != http.StatusOK {
		t.Fatalf("set hero = %d, body %s", set.Code, set.Body)
	}
	var out struct {
		HeroID string `json:"heroId"`
	}
	json.Unmarshal(set.Body.Bytes(), &out)
	if out.HeroID != heroID {
		t.Fatalf("heroId = %q, want %q (body %s)", out.HeroID, heroID, set.Body)
	}

	cleared := patch(`{"clearHero":"` + heroID + `"}`)
	if cleared.Code != http.StatusOK {
		t.Fatalf("clear hero = %d, body %s", cleared.Code, cleared.Body)
	}
	json.Unmarshal(cleared.Body.Bytes(), &out)
	if out.HeroID != "" {
		t.Fatalf("heroId = %q after clear, want empty", out.HeroID)
	}
}

func TestGetGenreExtended_unknownIs404(t *testing.T) {
	ts := newFanartTestServer(t)
	rr := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr, httptest.NewRequest("GET", "/api/genres/ghost", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", rr.Code)
	}
}

// --- Studio refine validation ---

// studioServer builds the assembled handler with an injected Studio provider.
// A nil provider leaves studio unconfigured (404).
func studioServer(mode config.AuthMode, provider studio.Provider) http.Handler {
	cfg := config.Config{AuthMode: mode, DevUser: config.DevUserConfig{Username: "dev"}}
	if provider == nil {
		return New(cfg, nil, studioSPA())
	}
	return NewWithStudioProvider(cfg, nil, studioSPA(), provider)
}

func TestStudioRefine_rejectsBadRequests(t *testing.T) {
	ts := studioServer(config.AuthModeDev, fakeStudio{lyrics: "refined"})

	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/studio/refine", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		ts.ServeHTTP(rr, req)
		return rr
	}

	for _, tc := range []struct{ name, body string }{
		{"malformed JSON", `{`},
		{"missing reference", `{"lyrics":"la","instruction":"shorter"}`},
		{"missing lyrics", `{"reference":"Song","instruction":"shorter"}`},
		{"missing instruction", `{"reference":"Song","lyrics":"la"}`},
		{"reference too long", `{"reference":"` + strings.Repeat("a", maxReferenceLen+1) + `","lyrics":"la","instruction":"shorter"}`},
		{"instruction too long", `{"reference":"Song","lyrics":"la","instruction":"` + strings.Repeat("a", maxInstructionLen+1) + `"}`},
		{"lyrics too long", `{"reference":"Song","lyrics":"` + strings.Repeat("a", maxLyricsLen+1) + `","instruction":"shorter"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if rr := post(tc.body); rr.Code != http.StatusBadRequest {
				t.Fatalf("code = %d, want 400 (body %s)", rr.Code, rr.Body)
			}
		})
	}
}

// A provider failure is reported as an SSE `error` event on an already-200
// stream, not as an HTTP error status.
func TestStudioRefine_providerErrorStreamsErrorEvent(t *testing.T) {
	ts := studioServer(config.AuthModeDev, fakeStudio{err: errors.New("mimo exploded")})
	req := httptest.NewRequest("POST", "/api/studio/refine",
		strings.NewReader(`{"reference":"Song","lyrics":"la","instruction":"shorter"}`))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	ts.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200 (errors ride the stream)", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "event: error") {
		t.Fatalf("body = %s, want an error event", rr.Body)
	}
	if strings.Contains(rr.Body.String(), "exploded") {
		t.Fatalf("leaked upstream detail: %s", rr.Body)
	}
}

func TestStudioRefine_gating(t *testing.T) {
	body := `{"reference":"Song","lyrics":"la","instruction":"shorter"}`
	t.Run("anonymous is 403", func(t *testing.T) {
		ts := studioServer(config.AuthModeOIDC, fakeStudio{lyrics: "x"})
		req := httptest.NewRequest("POST", "/api/studio/refine", strings.NewReader(body))
		rr := httptest.NewRecorder()
		ts.ServeHTTP(rr, req)
		if rr.Code != http.StatusForbidden {
			t.Fatalf("code = %d, want 403", rr.Code)
		}
	})
	t.Run("unconfigured is 404", func(t *testing.T) {
		ts := studioServer(config.AuthModeDev, nil)
		req := httptest.NewRequest("POST", "/api/studio/refine", strings.NewReader(body))
		rr := httptest.NewRecorder()
		ts.ServeHTTP(rr, req)
		if rr.Code != http.StatusNotFound {
			t.Fatalf("code = %d, want 404", rr.Code)
		}
	})
}

// --- middleware ---

// A panicking handler must be converted into a 500 by the recovery wrapper
// rather than tearing down the server. Driven directly because the assembled
// mux has no route that panics on demand.
func TestRecovery_panicBecomes500(t *testing.T) {
	h := logging(recovery(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	})))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/explode", nil))
	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("code = %d, want 500", rr.Code)
	}
}

// The logging wrapper must stay transparent: it forwards Unwrap (for
// http.ResponseController), ReadFrom (the sendfile fast path used by the
// audio/image routes), and Flush (SSE), and records the real status.
func TestStatusRecorder_forwardsWriterCapabilities(t *testing.T) {
	var (
		gotUnwrap bool
		copied    int64
	)
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec, ok := w.(*statusRecorder)
		if !ok {
			t.Errorf("handler did not receive the recorder, got %T", w)
			return
		}
		if rec.Unwrap() == nil {
			t.Error("Unwrap returned nil")
			return
		}
		gotUnwrap = true

		n, err := rec.ReadFrom(strings.NewReader("streamed body"))
		if err != nil {
			t.Errorf("ReadFrom: %v", err)
			return
		}
		copied = n
		rec.Flush()
	})
	rr := httptest.NewRecorder()
	logging(inner).ServeHTTP(rr, httptest.NewRequest("GET", "/api/thing", nil))

	if !gotUnwrap {
		t.Fatal("Unwrap was never exercised")
	}
	if copied != int64(len("streamed body")) {
		t.Fatalf("ReadFrom copied %d bytes, want %d", copied, len("streamed body"))
	}
	if rr.Body.String() != "streamed body" {
		t.Fatalf("body = %q", rr.Body.String())
	}
	if rr.Code != http.StatusOK {
		t.Fatalf("code = %d, want 200 (an implicit write is a 200)", rr.Code)
	}
}

// /api/health is the one path the logger skips; it must still be served intact.
func TestLogging_healthIsPassedThrough(t *testing.T) {
	h := logging(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "pong")
	}))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/health", nil))
	if rr.Body.String() != "pong" {
		t.Fatalf("body = %q, want pong", rr.Body.String())
	}
}
