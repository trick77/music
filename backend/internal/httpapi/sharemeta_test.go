package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/library"
)

// patchSongTitle edits a song's title via the API so we can inject a hostile
// value and assert it is escaped in the meta output.
func patchSongTitle(t *testing.T, h http.Handler, id, title string) {
	t.Helper()
	payload, _ := json.Marshal(map[string]any{
		"title": title, "artistName": "Test Artist", "album": "", "year": 0, "trackNo": 0, "genres": []string{},
	})
	rr := doJSON(t, h, "PATCH", "/api/songs/"+id, string(payload))
	if rr.Code != http.StatusOK {
		t.Fatalf("patch title = %d, body=%s", rr.Code, rr.Body.String())
	}
}

func TestShareMeta_songEmitsOGTags(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	sid := uploadSongID(t, h)
	doJSON(t, h, "POST", "/api/songs/"+sid+"/publish", "") // share preview only surfaces published songs

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/song/"+sid, nil)
	req.Host = "music.example.com"
	req.Header.Set("X-Forwarded-Proto", "https")
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("song route = %d", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("content-type = %q, want text/html", ct)
	}
	body := rr.Body.String()
	for _, want := range []string{
		`property="og:title"`,
		`property="og:type"`,
		`name="twitter:card"`,
		`Test Song`, // the fixture's title
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("meta missing %q in:\n%s", want, body)
		}
	}
}

func TestShareMeta_escapesHostileTitle(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	sid := uploadSongID(t, h)
	patchSongTitle(t, h, sid, `Broken " <script>alert(1)</script>`)
	doJSON(t, h, "POST", "/api/songs/"+sid+"/publish", "") // meta only emitted for published songs

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/song/"+sid, nil))
	body := rr.Body.String()

	if strings.Contains(body, "<script>alert(1)</script>") {
		t.Fatalf("hostile title not escaped:\n%s", body)
	}
	if !strings.Contains(body, "&lt;script&gt;") {
		t.Fatalf("expected escaped script tag in:\n%s", body)
	}
	if !strings.Contains(body, "&#34;") { // escaped double-quote
		t.Fatalf("expected escaped quote in:\n%s", body)
	}
}

func TestShareMeta_unpublishedSongOmitsOGTags(t *testing.T) {
	// A freshly uploaded (unpublished) song must not leak its title/artist/cover
	// into the public share-preview meta — it should fall through to the plain SPA
	// shell, just like get/stream 404 for anonymous callers.
	h := testServer(t, config.AuthModeDev)
	sid := uploadSongID(t, h) // lands unpublished

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/song/"+sid, nil)
	req.Host = "music.example.com"
	h.ServeHTTP(rr, req)

	if rr.Code == http.StatusInternalServerError {
		t.Fatalf("unpublished song share should not 500")
	}
	body := rr.Body.String()
	if strings.Contains(body, "og:title") || strings.Contains(body, "Test Song") {
		t.Fatalf("unpublished song must not emit share meta:\n%s", body)
	}
}

func TestShareMeta_missingIdServesPlainSPA(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/song/does-not-exist", nil))
	if rr.Code == http.StatusInternalServerError {
		t.Fatalf("missing id should not 500")
	}
	if strings.Contains(rr.Body.String(), "og:title") {
		t.Fatalf("missing id should not inject og tags")
	}
}

func TestShareMeta_rootEmitsDefaultCard(t *testing.T) {
	// A bare app link (the root, and any non-asset navigation route) must preview a
	// branded default card so WhatsApp/iMessage show something. The og:image is a
	// static card at an ABSOLUTE URL (relative URLs don't preview in chat apps).
	h := testServer(t, config.AuthModeDev)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/", nil)
	req.Host = "music.example.com"
	req.Header.Set("X-Forwarded-Proto", "https")
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("root route = %d", rr.Code)
	}
	body := rr.Body.String()
	for _, want := range []string{
		`property="og:type" content="website"`,
		`property="og:title" content="Music"`,
		`name="twitter:card" content="summary_large_image"`,
		`property="og:image" content="https://music.example.com/og-card.png"`,
		`property="og:image:width" content="1200"`,
		`property="og:image:height" content="630"`,
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("default card missing %q in:\n%s", want, body)
		}
	}
	// Exactly one og:image — no duplicate from a static tag racing the injected one.
	if n := strings.Count(body, `property="og:image"`); n != 1 {
		t.Fatalf("want exactly one og:image, got %d:\n%s", n, body)
	}
}

func TestShareMeta_staticFileNotWrapped(t *testing.T) {
	// A request that resolves to a real embedded asset (icon, manifest, hashed
	// bundle) must be served untouched by the static/SPA handler — never wrapped in
	// the HTML shell with a default share card. This drives withShareMeta directly
	// with hasFile stubbed to report the asset present: the backend test binary
	// embeds only index.html (manifest and bundles are built by the UI job in CI),
	// so a request through the real embed FS could not exercise this branch.
	const assetBody = `{"name":"Music"}`
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(assetBody))
	})
	// repo is only nil-checked on the static-file branch, never dereferenced.
	h := withShareMeta(library.NewRepo(nil), []byte("<html><head></head></html>"),
		spa, func(p string) bool { return p == "/manifest.webmanifest" })

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/manifest.webmanifest", nil))

	body := rr.Body.String()
	if body != assetBody {
		t.Fatalf("static asset must be served untouched by the SPA handler, got:\n%s", body)
	}
	if strings.Contains(body, "og:image") || strings.Contains(body, "og:title") || strings.Contains(body, "<title>") {
		t.Fatalf("static asset must not get injected share meta:\n%s", body)
	}
}

func TestShareMeta_playlistFallsBackToFirstSongCover(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	pid := createPlaylist(t, h, "Late Night Drive", "")
	sid := uploadSongID(t, h)
	// Give the song a cover so the playlist (no own cover) can fall back to it.
	body, contentType := pngMultipart(t)
	req := httptest.NewRequest("PUT", "/api/songs/"+sid+"/cover", body)
	req.Header.Set("Content-Type", contentType)
	cr := httptest.NewRecorder()
	h.ServeHTTP(cr, req)
	if cr.Code != http.StatusOK {
		t.Fatalf("song cover = %d, body=%s", cr.Code, cr.Body.String())
	}
	// Publish both: the share preview is public and only surfaces published
	// playlists and their published tracks.
	doJSON(t, h, "POST", "/api/songs/"+sid+"/publish", "")
	doJSON(t, h, "POST", "/api/playlists/"+pid+"/publish", "")
	doJSON(t, h, "POST", "/api/playlists/"+pid+"/songs", `{"songId":"`+sid+`"}`)

	rr := httptest.NewRecorder()
	req2 := httptest.NewRequest("GET", "/playlist/"+pid, nil)
	req2.Host = "music.example.com"
	h.ServeHTTP(rr, req2)
	b := rr.Body.String()
	if !strings.Contains(b, `property="og:title"`) || !strings.Contains(b, "Late Night Drive") {
		t.Fatalf("playlist meta missing title:\n%s", b)
	}
	if !strings.Contains(b, `property="og:image"`) || !strings.Contains(b, "/api/cover/") {
		t.Fatalf("playlist should fall back to first song cover:\n%s", b)
	}
	// og:image must request the sized card variant so chat apps don't reject an
	// oversized original.
	if !strings.Contains(b, "?size=card") {
		t.Fatalf("playlist cover should use ?size=card:\n%s", b)
	}
	// The subtitle is the track count (one published track), not a description.
	if !strings.Contains(b, "Playlist · 1 song") {
		t.Fatalf("playlist meta should show track count:\n%s", b)
	}
}

func TestShareMeta_playlistDescriptionNotLeaked(t *testing.T) {
	// A published playlist's preview must advertise the track count, never the
	// description text (which may be private/internal).
	h := testServer(t, config.AuthModeDev)
	pid := createPlaylist(t, h, "Road Trip", "a secret description that must not leak")
	sid := uploadSongID(t, h)
	doJSON(t, h, "POST", "/api/songs/"+sid+"/publish", "")
	doJSON(t, h, "POST", "/api/playlists/"+pid+"/publish", "")
	doJSON(t, h, "POST", "/api/playlists/"+pid+"/songs", `{"songId":"`+sid+`"}`)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/playlist/"+pid, nil)
	req.Host = "music.example.com"
	h.ServeHTTP(rr, req)

	body := rr.Body.String()
	if !strings.Contains(body, "Playlist · 1 song") {
		t.Fatalf("playlist meta should show the track count:\n%s", body)
	}
	if strings.Contains(body, "secret description") {
		t.Fatalf("playlist description must not leak into preview:\n%s", body)
	}
}
