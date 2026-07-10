package httpapi

import (
	"context"
	"html"
	"net/http"
	"strings"

	"github.com/trick77/music/internal/library"
)

// withShareMeta serves crawler-friendly Open Graph/Twitter meta for the two
// public share routes (/song/{id}, /playlist/{id}) by injecting escaped tags
// into the embedded SPA shell. Every other request — and any unknown id, empty
// shell, or non-GET method — is delegated to the SPA handler unchanged, so
// humans always boot the app and a stale link yields the in-app not-found.
func withShareMeta(repo *library.Repo, shell []byte, spa http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && len(shell) > 0 && repo != nil {
			if id, ok := shareID(r.URL.Path, "/song/"); ok {
				if tags, ok := songMeta(r.Context(), repo, r, id); ok {
					serveShell(w, shell, tags)
					return
				}
			} else if id, ok := shareID(r.URL.Path, "/playlist/"); ok {
				if tags, ok := playlistMeta(r.Context(), repo, r, id); ok {
					serveShell(w, shell, tags)
					return
				}
			}
		}
		spa.ServeHTTP(w, r)
	})
}

// shareID returns the id for an exact "/prefix/{id}" path (no further segments).
func shareID(path, prefix string) (string, bool) {
	if !strings.HasPrefix(path, prefix) {
		return "", false
	}
	rest := strings.TrimPrefix(path, prefix)
	if rest == "" || strings.Contains(rest, "/") {
		return "", false
	}
	return rest, true
}

func songMeta(ctx context.Context, repo *library.Repo, r *http.Request, id string) (string, bool) {
	song, err := repo.Get(ctx, id)
	if err != nil || song == nil {
		return "", false
	}
	img := ""
	if song.CoverArtID != "" {
		img = baseURL(r) + "/api/cover/" + song.CoverArtID
	}
	return buildMeta("music.song", song.Title, song.ArtistName, img, baseURL(r)+r.URL.Path), true
}

func playlistMeta(ctx context.Context, repo *library.Repo, r *http.Request, id string) (string, bool) {
	pl, err := repo.GetPlaylist(ctx, id)
	if err != nil || pl == nil {
		return "", false
	}
	desc := pl.Description
	if desc == "" {
		desc = "Playlist"
	}
	coverID := pl.CoverArtID
	if coverID == "" && len(pl.Songs) > 0 {
		coverID = pl.Songs[0].CoverArtID // fallback to first track's cover
	}
	img := ""
	if coverID != "" {
		img = baseURL(r) + "/api/cover/" + coverID
	}
	return buildMeta("music.playlist", pl.Name, desc, img, baseURL(r)+r.URL.Path), true
}

// buildMeta renders the OG/Twitter block. All dynamic strings are HTML-escaped
// for safe use inside double-quoted attribute values. og:image is omitted when
// empty so no broken image URL is ever advertised.
func buildMeta(ogType, title, desc, img, url string) string {
	var b strings.Builder
	meta := func(attr, key, val string) {
		b.WriteString(`<meta ` + attr + `="` + key + `" content="` + html.EscapeString(val) + "\">\n")
	}
	meta("property", "og:type", ogType)
	meta("property", "og:title", title)
	meta("property", "og:description", desc)
	meta("property", "og:url", url)
	meta("name", "twitter:card", pick(img, "summary_large_image", "summary"))
	meta("name", "twitter:title", title)
	meta("name", "twitter:description", desc)
	if img != "" {
		meta("property", "og:image", img)
		meta("name", "twitter:image", img)
	}
	return b.String()
}

func pick(cond, a, b string) string {
	if cond != "" {
		return a
	}
	return b
}

// baseURL reconstructs the external origin, honoring a reverse proxy's
// X-Forwarded-Proto (loom deploys behind one).
func baseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		scheme = p
	}
	return scheme + "://" + r.Host
}

// serveShell injects the meta block into the shell and writes it as HTML. The
// block goes right after </title> (present in both the placeholder and a real
// Vite build); failing that, before </head>; failing that, at the very front.
func serveShell(w http.ResponseWriter, shell []byte, tags string) {
	s := string(shell)
	lower := strings.ToLower(s)
	inject := "\n" + tags
	var out string
	if i := strings.Index(lower, "</title>"); i >= 0 {
		pos := i + len("</title>")
		out = s[:pos] + inject + s[pos:]
	} else if i := strings.Index(lower, "</head>"); i >= 0 {
		out = s[:i] + inject + s[i:]
	} else {
		out = tags + s
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Write([]byte(out))
}
