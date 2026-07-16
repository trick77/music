package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/store"
	"github.com/trick77/music/web"
)

// The SPA shell must be revalidated on every load through the ASSEMBLED server —
// the real mux plus the real embedded SPA handler, not web.SPAHandler() alone.
// Shell responses name the content-hashed bundles, and embed.FS supplies no
// Last-Modified (zero ModTime) and net/http no ETag, so without an explicit
// Cache-Control a browser may heuristically cache the shell indefinitely and keep
// booting a stale bundle after a deploy.
func TestAssembledServer_shellIsRevalidated(t *testing.T) {
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := config.Config{
		AuthMode: config.AuthModeDev,
		DevUser:  config.DevUserConfig{Username: "dev"},
		MediaDir: t.TempDir(),
	}
	h := New(cfg, st, web.SPAHandler())

	// "/index.html" is canonicalised to "/" by http.FileServer (301); the header
	// still has to be right on the redirect, since a cached 301 is just as sticky.
	for _, tc := range []struct {
		path string
		want int
	}{
		{"/", http.StatusOK},
		{"/index.html", http.StatusMovedPermanently},
		{"/library", http.StatusOK},
	} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest("GET", tc.path, nil))
		if rr.Code != tc.want {
			t.Fatalf("GET %s = %d, want %d", tc.path, rr.Code, tc.want)
		}
		if got := rr.Header().Get("Cache-Control"); got != "no-cache" {
			t.Errorf("GET %s Cache-Control = %q, want %q", tc.path, got, "no-cache")
		}
	}
}

// The share-meta path writes the shell ITSELF via serveShell, bypassing the SPA
// handler, so it needs its own no-cache. This only proves anything if routing
// actually reaches serveShell: that requires a PUBLISHED song and its real id —
// an unknown id falls through to the SPA handler and would pass on that header
// alone, testing nothing. The og:title assertion pins that serveShell ran.
func TestAssembledServer_shareRouteShellIsRevalidated(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	sid := uploadSongID(t, h)
	doJSON(t, h, "POST", "/api/songs/"+sid+"/publish", "") // meta only for published songs

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/song/"+sid, nil)
	req.Host = "music.example.com"
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("GET /song/{id} = %d", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), `og:title`) {
		t.Fatalf("share route did not reach serveShell (no og:title); test would prove nothing:\n%s",
			rr.Body.String())
	}
	if got := rr.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("share shell Cache-Control = %q, want %q", got, "no-cache")
	}
}
