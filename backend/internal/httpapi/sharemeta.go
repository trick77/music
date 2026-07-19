package httpapi

import (
	"context"
	"fmt"
	"html"
	"net/http"
	"strings"

	"github.com/trick77/music/internal/library"
)

// withShareMeta serves crawler-friendly Open Graph/Twitter meta by injecting
// escaped tags into the embedded SPA shell. The two public share routes
// (/song/{id}, /playlist/{id}) get per-item previews from the library; every
// other navigation route gets a branded default card so a bare app link still
// previews on WhatsApp/iMessage. Requests for real static files (icons, manifest,
// hashed bundles), unknown/unpublished share ids, an empty shell, or non-GET
// methods are delegated to the SPA handler unchanged — humans always boot the
// app, a stale share link yields the in-app not-found (no card, no data leak),
// and asset bytes are never wrapped in HTML. hasFile reports whether a path
// resolves to an embedded static file (web.HasFile).
func withShareMeta(repo *library.Repo, shell []byte, spa http.Handler, hasFile func(string) bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && len(shell) > 0 && repo != nil {
			switch {
			case strings.HasPrefix(r.URL.Path, "/song/"):
				if id, ok := shareID(r.URL.Path, "/song/"); ok {
					if tags, ok := songMeta(r.Context(), repo, r, id); ok {
						serveShell(w, shell, tags)
						return
					}
				}
				// Unresolved/unpublished song: fall through to the plain shell below.
			case strings.HasPrefix(r.URL.Path, "/playlist/"):
				if id, ok := shareID(r.URL.Path, "/playlist/"); ok {
					if tags, ok := playlistMeta(r.Context(), repo, r, id); ok {
						serveShell(w, shell, tags)
						return
					}
				}
			default:
				// Any other navigation route (the app root, /library, …) that isn't a
				// real asset gets the default site card.
				if !hasFile(r.URL.Path) {
					serveShell(w, shell, defaultMeta(r))
					return
				}
			}
		}
		spa.ServeHTTP(w, r)
	})
}

// defaultMeta is the site-wide Open Graph/Twitter block for navigation routes
// with no song/playlist of their own, so a bare link pasted into WhatsApp or
// iMessage still previews a branded card. The image is a static share card at an
// absolute URL (relative URLs don't preview in chat apps); its dimensions are
// advertised so clients lay out the card without fetching the image first.
func defaultMeta(r *http.Request) string {
	base := baseURL(r)
	// The default card is the static 1.91:1 og-card.png (unchanged); song/playlist
	// cards are the 1200x1200 rendered cards.
	return buildMeta("website", "Music", "Stream your music library.", base+"/og-card.png", base+r.URL.Path, 1200, 630)
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
	// The share preview is public and not auth-aware, so an unpublished song must
	// not leak its title/artist/cover here — fall through to the plain SPA shell,
	// mirroring the 404 the get/stream handlers give anonymous callers.
	if err != nil || song == nil || !song.Published {
		return "", false
	}
	img := baseURL(r) + "/api/share/song/" + id + "/card.jpg"
	return buildMeta("music.song", song.Title, song.ArtistName, img, baseURL(r)+r.URL.Path, 1200, 1200), true
}

func playlistMeta(ctx context.Context, repo *library.Repo, r *http.Request, id string) (string, bool) {
	pl, err := repo.GetPlaylist(ctx, id, false) // share preview is public; only published tracks
	if err != nil || pl == nil {
		return "", false
	}
	// Show the track count instead of the description: the preview subtitle
	// stays useful even for playlists with no description. len(pl.Songs) is the
	// published-track count, since GetPlaylist(..., false) loads only those.
	n := len(pl.Songs)
	noun := "songs"
	if n == 1 {
		noun = "song"
	}
	desc := fmt.Sprintf("Playlist · %d %s", n, noun)
	img := baseURL(r) + "/api/share/playlist/" + id + "/card.jpg"
	return buildMeta("music.playlist", pl.Name, desc, img, baseURL(r)+r.URL.Path, 1200, 1200), true
}

// buildMeta renders the OG/Twitter block. All dynamic strings are HTML-escaped
// for safe use inside double-quoted attribute values. og:image (and its
// advertised dimensions) is omitted when img is empty so no broken image URL is
// ever advertised. imgW/imgH let clients (notably iMessage) lay out the card
// without first downloading the image.
func buildMeta(ogType, title, desc, img, url string, imgW, imgH int) string {
	var b strings.Builder
	meta := func(attr, key, val string) {
		b.WriteString(`<meta ` + attr + `="` + key + `" content="` + html.EscapeString(val) + "\">\n")
	}
	meta("property", "og:site_name", "Music")
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
		meta("property", "og:image:width", fmt.Sprintf("%d", imgW))
		meta("property", "og:image:height", fmt.Sprintf("%d", imgH))
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
	// Same shell, same rule as the SPA handler: this response names the hashed
	// bundles, so it must be revalidated or a client keeps booting an old build.
	w.Header().Set("Cache-Control", "no-cache")
	w.Write([]byte(out))
}
