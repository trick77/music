// Package web embeds the built frontend (web/dist) and serves it as a SPA.
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:dist
var distFS embed.FS

// AssetsPrefix is the path Vite emits content-hashed bundles under. A file there
// is immutable by construction: its name changes whenever its bytes do. Static
// files from ui/public/ (sw.js, manifest, icons) land at the dist ROOT, not here,
// and so stay revalidated — do not add an unhashed ui/public/assets/, as anything
// under this prefix is cached for a year and cannot be recalled.
const AssetsPrefix = "/assets/"

// CacheControl returns the Cache-Control value for an embedded asset path.
//
// Files served from embed.FS carry a ZERO ModTime, so http.ServeContent emits no
// Last-Modified, and net/http never generates an ETag. With no validator and no
// Cache-Control, a browser is free to apply *heuristic* caching and re-use a
// response for an unbounded time — Safari does, which pins clients to a stale
// index.html and therefore a stale bundle long after a deploy. Being explicit is
// what stops a shipped fix from silently never reaching anyone.
func CacheControl(path string) string {
	if strings.HasPrefix(path, AssetsPrefix) {
		// Content-hashed: a changed build yields a new URL, so this can never go
		// stale and is safe to keep out of revalidation entirely.
		return "public, max-age=31536000, immutable"
	}
	// index.html (and the SPA fallback, sw.js, manifest) name the hashed bundles,
	// so they must be revalidated on every load or the new hashes are never seen.
	// "no-cache" still permits storing — it forces revalidation, not refetching.
	return "no-cache"
}

// IsDeliberate404 reports whether path is one the app ships no file for ON
// PURPOSE and must answer with 404 rather than the SPA shell.
//
// Only /favicon.ico qualifies. Music declares an SVG icon in <head>; the clients
// that probe for a bare /favicon.ico are RSS readers, Windows bookmark
// thumbnails and old IE, none of which this targets. Left alone, that probe
// falls through to the SPA fallback and gets index.html with a 200 — an icon
// request answered with HTML, which is worse than no icon. Every browser handles
// a 404 by falling back to the declared icon.
//
// This is exported because the SPA fallback is not the only thing in front of
// it: httpapi wraps the handler with the share-meta layer, whose own catch-all
// would otherwise answer the probe with an Open-Graph-injected shell before
// SPAHandler ever ran. Both must agree, so both ask here.
func IsDeliberate404(path string) bool {
	return path == "/favicon.ico"
}

// SPAHandler serves the embedded dist directory; unknown paths fall back to
// index.html so client-side routing works.
func SPAHandler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err) // dist is embedded at build time; a failure is a programmer error
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if IsDeliberate404(r.URL.Path) {
			http.NotFound(w, r)
			return
		}
		if _, err := fs.Stat(sub, trimLeadingSlash(r.URL.Path)); err != nil && r.URL.Path != "/" {
			r = r.Clone(r.Context())
			r.URL.Path = "/"
		}
		// Keyed on the (possibly rewritten) path: an unknown route now serves the
		// index shell and must get the shell's no-cache, not an asset's immutable.
		w.Header().Set("Cache-Control", CacheControl(r.URL.Path))
		fileServer.ServeHTTP(w, r)
	})
}

// IndexHTML returns the embedded index.html shell bytes. Used by the server to
// inject per-route Open Graph tags for shared-link previews (crawlers do not
// run JS), while humans still receive the same shell and boot the SPA.
func IndexHTML() ([]byte, error) {
	return distFS.ReadFile("dist/index.html")
}

// HasFile reports whether path resolves to an embedded static file (icon,
// manifest, hashed bundle, …) rather than an SPA route. It mirrors SPAHandler's
// own fallback test, so the share-meta layer can inject default Open Graph tags
// for navigation routes only and never wrap a real asset (e.g. /favicon.svg) in
// HTML. The root path "/" is not a file and yields false, as intended.
//
// /favicon.ico is not among them — nothing ships at that path, so this reports
// false for it and SPAHandler 404s it before the question arises.
func HasFile(path string) bool {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return false
	}
	_, err = fs.Stat(sub, trimLeadingSlash(path))
	return err == nil
}

func trimLeadingSlash(p string) string {
	if len(p) > 0 && p[0] == '/' {
		return p[1:]
	}
	return p
}
