package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/store"
)

// alignEnabledServer builds a real server (through build()) with the alignment
// sidecar pointed at stubURL, so route registration + the typed-nil IIFE gating +
// the real align.Client are all exercised end-to-end.
func alignEnabledServer(t *testing.T, stubURL string) http.Handler {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := config.Config{
		AuthMode:     config.AuthModeDev,
		DevUser:      config.DevUserConfig{Username: "dev"},
		MediaDir:     t.TempDir(),
		MaxUploadMB:  50,
		AlignURL:     stubURL,
		AlignTimeout: 30 * time.Second,
	}
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	return New(cfg, st, spa)
}

func stubSidecar(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"engine":"stub","lines":[{"text":"la la","start":0.1,"end":0.9,"words":[{"w":"la","start":0.1,"end":0.4,"conf":0.9},{"w":"la","start":0.5,"end":0.9,"conf":0.8}]}]}`)
	}))
}

func TestAlignRoutes_anonForbidden(t *testing.T) {
	h := testServer(t, config.AuthModeOIDC) // anonymous
	for _, m := range []string{"POST", "GET"} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest(m, "/api/songs/whatever/align", nil))
		if rr.Code != http.StatusForbidden {
			t.Fatalf("anon %s /align = %d, want 403", m, rr.Code)
		}
	}
}

func TestAlignRoute_disabledReturns404(t *testing.T) {
	h := testServer(t, config.AuthModeDev) // authed, but no AlignURL => aligner nil
	up := uploadFixture(t, h)
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("POST", "/api/songs/"+song.ID+"/align", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("disabled POST /align = %d, want 404 (typed-nil gating)", rr.Code)
	}
}

func TestSession_alignmentFlag(t *testing.T) {
	// Disabled server.
	off := testServer(t, config.AuthModeDev)
	rr := httptest.NewRecorder()
	off.ServeHTTP(rr, httptest.NewRequest("GET", "/api/auth/session", nil))
	var body map[string]any
	json.Unmarshal(rr.Body.Bytes(), &body)
	if body["alignmentEnabled"] != false {
		t.Fatalf("alignmentEnabled = %v, want false when disabled", body["alignmentEnabled"])
	}
	// Enabled server.
	on := alignEnabledServer(t, "http://align:8000")
	rr = httptest.NewRecorder()
	on.ServeHTTP(rr, httptest.NewRequest("GET", "/api/auth/session", nil))
	json.Unmarshal(rr.Body.Bytes(), &body)
	if body["alignmentEnabled"] != true {
		t.Fatalf("alignmentEnabled = %v, want true when enabled+authed", body["alignmentEnabled"])
	}
}

func TestAlign_fullWiringThroughServer(t *testing.T) {
	stub := stubSidecar(t)
	defer stub.Close()
	h := alignEnabledServer(t, stub.URL)

	up := uploadFixture(t, h)
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)

	// Give the song lyrics (the sample fixture has none). Saving changed, non-empty
	// lyrics AUTO-STARTS alignment (Phase 3 save trigger), so the row may already be
	// generating by the time we POST /align explicitly below.
	if pr := patch(t, h, song.ID, `{"title":"T","artistName":"Test Artist","genres":[],"lyrics":"la la"}`); pr.Code != http.StatusOK {
		t.Fatalf("PATCH lyrics = %d", pr.Code)
	}
	// The explicit POST exercises the route wiring; it returns 202 when it claims the
	// slot, or 409 when the save trigger already claimed it — both are valid here.
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("POST", "/api/songs/"+song.ID+"/align", nil))
	if rr.Code != http.StatusAccepted && rr.Code != http.StatusConflict {
		t.Fatalf("POST /align = %d, want 202 or 409; body=%s", rr.Code, rr.Body.String())
	}

	// Poll until the detached goroutine finishes (stub responds immediately).
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		gr := httptest.NewRecorder()
		h.ServeHTTP(gr, httptest.NewRequest("GET", "/api/songs/"+song.ID+"/align", nil))
		var body map[string]any
		json.Unmarshal(gr.Body.Bytes(), &body)
		if body["status"] == "ready" {
			if body["engine"] != "stub" || body["lines"] == nil {
				t.Fatalf("ready body missing timings: %v", body)
			}
			return // success
		}
		time.Sleep(15 * time.Millisecond)
	}
	t.Fatal("alignment did not reach 'ready' within deadline")
}
