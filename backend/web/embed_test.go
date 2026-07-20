package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
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

// IndexHTML feeds the share-meta layer, which injects Open Graph tags into the
// shell for crawlers. It must return the real embedded shell, not an empty body.
func TestIndexHTML_returnsEmbeddedShell(t *testing.T) {
	got, err := IndexHTML()
	if err != nil {
		t.Fatalf("IndexHTML error: %v", err)
	}
	if len(got) == 0 {
		t.Fatal("IndexHTML returned no bytes")
	}
	// The shell must be an HTML document with a head to inject meta tags into.
	body := string(got)
	if !strings.Contains(strings.ToLower(body), "<html") || !strings.Contains(strings.ToLower(body), "</head>") {
		t.Fatalf("IndexHTML does not look like the SPA shell: %.200q", body)
	}
}

// HasFile decides whether the share-meta layer may wrap a path in HTML. It must
// mirror SPAHandler's fallback test: real embedded files are true, SPA routes
// (and the root) are false — otherwise a real asset like /favicon.ico would be
// served as an HTML document.
//
// Only dist/index.html is committed; the hashed bundles and icons are built in
// CI, so this asserts nothing about them.
func TestHasFile_distinguishesAssetsFromSPARoutes(t *testing.T) {
	cases := map[string]bool{
		"/index.html":               true,
		"index.html":                true, // callers may pass an untrimmed path
		"/":                         false,
		"/library":                  false,
		"/song/abc":                 false,
		"/assets/index-DEADBEEF.js": false,
		"":                          false,
	}
	for path, want := range cases {
		if got := HasFile(path); got != want {
			t.Errorf("HasFile(%q) = %v, want %v", path, got, want)
		}
	}
}

// A path HasFile reports false for is an SPA route, and SPAHandler must answer
// it with the shell bytes — the same bytes IndexHTML hands the share-meta layer.
func TestSPAHandler_fallbackServesTheIndexHTMLBytes(t *testing.T) {
	shell, err := IndexHTML()
	if err != nil {
		t.Fatalf("IndexHTML error: %v", err)
	}
	for _, path := range []string{"/library", "/song/abc"} {
		if HasFile(path) {
			t.Fatalf("%s should not be an embedded file", path)
		}
		rr := httptest.NewRecorder()
		SPAHandler().ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
		if rr.Body.String() != string(shell) {
			t.Errorf("%s did not serve the index.html shell", path)
		}
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
