package httpapi

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/store"
)

// Cover art is content-addressed (a cover id is looked up by content hash), so
// its URL can never serve different bytes and is safe to keep forever. Asserted
// through the ASSEMBLED server, since the ETag wrapper now sits in front of the
// mux and must leave image responses alone.
func TestAssembledServer_coverIsImmutable(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	songID := uploadSongID(t, h)
	rr := uploadCover(t, h, songID)
	if rr.Code != http.StatusOK {
		t.Fatalf("PUT cover = %d, body=%s", rr.Code, rr.Body.String())
	}
	var updated struct {
		CoverArtID string `json:"coverArtId"`
	}
	json.Unmarshal(rr.Body.Bytes(), &updated)

	for _, path := range []string{
		"/api/cover/" + updated.CoverArtID,
		"/api/cover/" + updated.CoverArtID + "?size=thumb",
	} {
		cr := httptest.NewRecorder()
		h.ServeHTTP(cr, httptest.NewRequest("GET", path, nil))
		if cr.Code != http.StatusOK {
			t.Fatalf("GET %s = %d", path, cr.Code)
		}
		if got := cr.Header().Get("Cache-Control"); got != immutableCache {
			t.Errorf("GET %s Cache-Control = %q, want %q", path, got, immutableCache)
		}
		if cr.Header().Get("ETag") != "" {
			t.Errorf("GET %s got a JSON ETag; the image path must pass through untouched", path)
		}
	}
}

// A fanart row exists before its image does. The "image not ready" 404 must be
// no-store: a bare 404 is heuristically cacheable, so a client could keep serving
// itself the miss long after generation finished and hide the image for good.
func TestAssembledServer_notReadyImageIsNotStored(t *testing.T) {
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := config.Config{
		AuthMode:    config.AuthModeDev,
		DevUser:     config.DevUserConfig{Username: "dev"},
		MediaDir:    t.TempDir(),
		MaxUploadMB: 50,
	}
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	h := New(cfg, st, spa)
	if s, ok := h.(*server); ok {
		t.Cleanup(s.Wait)
	}

	repo := library.NewRepo(st.DB())
	id, err := repo.CreateFanart(t.Context(), library.FanartParams{Kind: "hero", Status: "generating"})
	if err != nil {
		t.Fatalf("CreateFanart: %v", err)
	}

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/fanart/"+id, nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("GET in-flight fanart = %d, want 404 (test proves nothing otherwise)", rr.Code)
	}
	if got := rr.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("not-ready fanart Cache-Control = %q, want no-store", got)
	}
}

// A JSON read a client already has must come back as a 304 with no body. This is
// the whole point of the ETag: the second visit pays headers, not the payload.
func TestAssembledServer_jsonReadRevalidatesTo304(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	uploadSongID(t, h)

	first := httptest.NewRecorder()
	h.ServeHTTP(first, httptest.NewRequest("GET", "/api/home", nil))
	if first.Code != http.StatusOK {
		t.Fatalf("GET /api/home = %d", first.Code)
	}
	etag := first.Header().Get("ETag")
	if etag == "" {
		t.Fatal("GET /api/home has no ETag")
	}
	if got := first.Header().Get("Cache-Control"); got != revalidateCache {
		t.Errorf("Cache-Control = %q, want %q", got, revalidateCache)
	}
	if got := first.Header().Get("Vary"); !strings.Contains(got, "Cookie") {
		t.Errorf("Vary = %q, want it to include Cookie", got)
	}
	if first.Body.Len() == 0 {
		t.Fatal("first response has no body")
	}

	second := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/home", nil)
	// Sent the way a browser sends it: a list, with a weak-prefixed decoy first.
	req.Header.Set("If-None-Match", `W/"stale", `+etag)
	h.ServeHTTP(second, req)
	if second.Code != http.StatusNotModified {
		t.Fatalf("revalidated GET /api/home = %d, want 304", second.Code)
	}
	if second.Body.Len() != 0 {
		t.Errorf("304 carried a body of %d bytes", second.Body.Len())
	}

	// A changed library must break the ETag, or the 304 above would be a bug that
	// pins clients to stale data.
	uploadCover(t, h, uploadSongID(t, h))
	third := httptest.NewRecorder()
	req3 := httptest.NewRequest("GET", "/api/home", nil)
	req3.Header.Set("If-None-Match", etag)
	h.ServeHTTP(third, req3)
	if third.Code != http.StatusOK {
		t.Fatalf("GET /api/home after a change = %d, want 200 with fresh data", third.Code)
	}
}

// Range requests are what makes seeking in a track cheap. The wrapper must not
// break them, and the stream needs a validator of its own so a replay revalidates
// instead of refetching.
func TestAssembledServer_streamRangeAndValidator(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	songID := uploadSongID(t, h)

	full := httptest.NewRecorder()
	h.ServeHTTP(full, httptest.NewRequest("GET", "/api/songs/"+songID+"/stream", nil))
	if full.Code != http.StatusOK {
		t.Fatalf("GET stream = %d", full.Code)
	}
	etag := full.Header().Get("ETag")
	if etag == "" {
		t.Fatal("stream has no ETag")
	}
	if got := full.Header().Get("Cache-Control"); got != revalidateCache {
		t.Errorf("stream Cache-Control = %q, want %q", got, revalidateCache)
	}

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/songs/"+songID+"/stream", nil)
	req.Header.Set("Range", "bytes=0-9")
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusPartialContent {
		t.Fatalf("ranged GET stream = %d, want 206", rr.Code)
	}
	if got := rr.Header().Get("Content-Range"); !strings.HasPrefix(got, "bytes 0-9/") {
		t.Errorf("Content-Range = %q, want it to start with %q", got, "bytes 0-9/")
	}
	if n := rr.Body.Len(); n != 10 {
		t.Errorf("ranged body = %d bytes, want 10", n)
	}

	cond := httptest.NewRecorder()
	creq := httptest.NewRequest("GET", "/api/songs/"+songID+"/stream", nil)
	creq.Header.Set("If-None-Match", etag)
	h.ServeHTTP(cond, creq)
	if cond.Code != http.StatusNotModified {
		t.Errorf("replayed stream = %d, want 304", cond.Code)
	}
}

// Writes must never be answered from a cache, and must not grow an ETag that a
// client could later revalidate against.
func TestAssembledServer_writeGetsNoETag(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	songID := uploadSongID(t, h)
	rr := doJSON(t, h, "POST", "/api/songs/"+songID+"/publish", "")
	if rr.Code != http.StatusOK {
		t.Fatalf("publish = %d, body=%s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("ETag"); got != "" {
		t.Errorf("write response carries ETag %q", got)
	}
}

// The cover DOWNLOAD url is song-scoped, not content-addressed: it resolves the
// song's *current* cover. Marking it immutable would keep handing the user the
// artwork they just replaced, for a year.
func TestAssembledServer_coverDownloadRevalidates(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	songID := uploadSongID(t, h)
	if rr := uploadCover(t, h, songID); rr.Code != http.StatusOK {
		t.Fatalf("PUT cover = %d, body=%s", rr.Code, rr.Body.String())
	}

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/songs/"+songID+"/cover/download", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("GET cover download = %d, body=%s", rr.Code, rr.Body.String())
	}
	if got := rr.Header().Get("Cache-Control"); got != revalidateCache {
		t.Errorf("cover download Cache-Control = %q, want %q", got, revalidateCache)
	}
}

// Every other assembled test drives httptest.NewRecorder, which happily takes two
// WriteHeader calls. A real server logs "superfluous response.WriteHeader call"
// for each one, so a wrapper that writes the header twice would put a line in the
// log for every image, stream and error the API serves. Asserted over the whole
// assembled chain (logging → recovery → withJSONETag → handlers), since that is
// where the extra writer wrappers actually live.
func TestAssembledServer_noSuperfluousWriteHeader(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	songID := uploadSongID(t, h)
	cr := uploadCover(t, h, songID)
	if cr.Code != http.StatusOK {
		t.Fatalf("PUT cover = %d, body=%s", cr.Code, cr.Body.String())
	}
	var updated struct {
		CoverArtID string `json:"coverArtId"`
	}
	json.Unmarshal(cr.Body.Bytes(), &updated)

	var logged bytes.Buffer
	srv := httptest.NewUnstartedServer(h)
	srv.Config.ErrorLog = log.New(&logged, "", 0)
	srv.Start()
	defer srv.Close()

	for _, path := range []string{
		"/api/home",                        // buffered JSON 200
		"/api/cover/" + updated.CoverArtID, // image, passthrough
		"/api/cover/" + updated.CoverArtID + "?size=thumb", // scaled image
		"/api/songs/" + songID + "/stream",                 // audio, ReadFrom
		"/api/songs/does-not-exist/stream",                 // JSON error, non-200
	} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		resp.Body.Close()
	}
	if logged.Len() != 0 {
		t.Errorf("server logged %q", logged.String())
	}
}
