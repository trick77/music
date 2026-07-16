package web

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSPAHandler_servesIndex(t *testing.T) {
	rr := httptest.NewRecorder()
	SPAHandler().ServeHTTP(rr, httptest.NewRequest("GET", "/", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
}

func TestSPAHandler_unknownFallsBackToIndex(t *testing.T) {
	rr := httptest.NewRecorder()
	SPAHandler().ServeHTTP(rr, httptest.NewRequest("GET", "/library", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("SPA route should serve index, status = %d", rr.Code)
	}
}

// The shell must always be revalidated. embed.FS has a zero ModTime, so without an
// explicit Cache-Control there is no validator at all and browsers heuristically
// cache the shell — pinning clients to a stale bundle after a deploy.
func TestSPAHandler_shellIsRevalidated(t *testing.T) {
	for _, path := range []string{"/", "/index.html", "/library", "/sw.js"} {
		rr := httptest.NewRecorder()
		SPAHandler().ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
		if got := rr.Header().Get("Cache-Control"); got != "no-cache" {
			t.Errorf("%s Cache-Control = %q, want %q", path, got, "no-cache")
		}
	}
}

// A missing /assets/ file is rewritten to the shell, so it must inherit the
// shell's no-cache — never the immutable of the asset URL it was requested as.
// (Only index.html is committed to dist; real hashed bundles are built in CI, so
// the immutable path itself is covered by TestCacheControl.)
func TestSPAHandler_missingAssetFallsBackToShellHeaders(t *testing.T) {
	rr := httptest.NewRecorder()
	SPAHandler().ServeHTTP(rr, httptest.NewRequest("GET", "/assets/index-DEADBEEF.js", nil))
	if got := rr.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("missing asset falls back to shell, Cache-Control = %q, want no-cache", got)
	}
}

func TestCacheControl(t *testing.T) {
	cases := map[string]string{
		"/assets/index-abc123.js":  "public, max-age=31536000, immutable",
		"/assets/index-abc123.css": "public, max-age=31536000, immutable",
		"/":                        "no-cache",
		"/index.html":              "no-cache",
		"/sw.js":                   "no-cache",
		"/manifest.webmanifest":    "no-cache",
		"/song/abc":                "no-cache",
	}
	for path, want := range cases {
		if got := CacheControl(path); got != want {
			t.Errorf("CacheControl(%q) = %q, want %q", path, got, want)
		}
	}
}
