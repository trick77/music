package httpapi

import (
	"bytes"
	"encoding/json"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/store"
	"github.com/trick77/music/web"
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

func TestShareCard_songMetaPointsAtCard(t *testing.T) {
	// A published song's og:image is the rendered 1200x1200 card (absolute URL),
	// with summary_large_image and advertised square dimensions — the Apple-safe
	// shape that renders a titled card in iMessage instead of an oversized cover.
	h := testServer(t, config.AuthModeDev)
	sid := uploadSongID(t, h)
	body, ct := pngMultipart(t)
	cover := httptest.NewRequest("PUT", "/api/songs/"+sid+"/cover", body)
	cover.Header.Set("Content-Type", ct)
	cr := httptest.NewRecorder()
	h.ServeHTTP(cr, cover)
	if cr.Code != http.StatusOK {
		t.Fatalf("set cover = %d, body=%s", cr.Code, cr.Body.String())
	}
	doJSON(t, h, "POST", "/api/songs/"+sid+"/publish", "")

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/song/"+sid, nil)
	req.Host = "music.example.com"
	req.Header.Set("X-Forwarded-Proto", "https")
	h.ServeHTTP(rr, req)
	b := rr.Body.String()

	cardURL := "https://music.example.com/api/share/song/" + sid + "/card.jpg"
	if !strings.Contains(b, `property="og:image" content="`+cardURL+`"`) {
		t.Fatalf("song og:image should be the card URL %q:\n%s", cardURL, b)
	}
	if !strings.Contains(b, `name="twitter:card" content="summary_large_image"`) {
		t.Fatalf("song card should be summary_large_image:\n%s", b)
	}
	if !strings.Contains(b, `property="og:image:width" content="1200"`) || !strings.Contains(b, `property="og:image:height" content="1200"`) {
		t.Fatalf("song card should advertise 1200x1200:\n%s", b)
	}
	// And the card renders as a real 1200x1200 JPEG.
	assertCard(t, h, "/api/share/song/"+sid+"/card.jpg")
}

func TestShareCard_rendersWithoutCover(t *testing.T) {
	// A published song with no cover art still renders a valid (text-only) card.
	h := testServer(t, config.AuthModeDev)
	sid := uploadSongID(t, h)
	doJSON(t, h, "POST", "/api/songs/"+sid+"/publish", "")
	assertCard(t, h, "/api/share/song/"+sid+"/card.jpg")
}

func TestShareCard_unpublishedOrUnknown404(t *testing.T) {
	// The card endpoint is public and not auth-aware, so it must 404 for an
	// unpublished or unknown song rather than leak/render its metadata.
	h := testServer(t, config.AuthModeDev)
	sid := uploadSongID(t, h) // unpublished
	for _, path := range []string{
		"/api/share/song/" + sid + "/card.jpg",
		"/api/share/song/does-not-exist/card.jpg",
	} {
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
		if rr.Code != http.StatusNotFound {
			t.Fatalf("GET %s = %d, want 404", path, rr.Code)
		}
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

// The app ships no favicon.ico, and the probe for one must 404 through the FULLY
// ASSEMBLED handler — not merely through web.SPAHandler in isolation.
//
// That distinction is the whole point of this test. web.SPAHandler 404s the path
// itself and has its own unit test proving it, but httpapi wraps it in the
// share-meta layer, whose catch-all serves the Open-Graph shell to anything that
// is not a real file — and a file that does not exist is not a real file. So the
// handler-level test passed while the running server answered the icon probe
// with 200 and a page of HTML. Only a request through testServer sees that.
func TestShareMeta_faviconICOIs404NotTheShell(t *testing.T) {
	// Built with the REAL web.SPAHandler rather than testServer's stub, because
	// the stub answers everything with 200 "SPA" and would hide the very status
	// under test. This is the production wiring from server.go.
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
	h := New(cfg, st, web.SPAHandler())
	if s, ok := h.(*server); ok {
		t.Cleanup(s.Wait)
	}

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/favicon.ico", nil))

	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body:\n%s", rr.Code, rr.Body.String())
	}
	if body := rr.Body.String(); strings.Contains(body, "og:image") || strings.Contains(body, "<div id=\"root\">") {
		t.Fatalf("favicon.ico was answered with the SPA shell:\n%s", body)
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
		spa, func(p string) bool { return p == "/manifest.webmanifest" },
		web.IsDeliberate404)

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
	req2.Header.Set("X-Forwarded-Proto", "https")
	h.ServeHTTP(rr, req2)
	b := rr.Body.String()
	if !strings.Contains(b, `property="og:title"`) || !strings.Contains(b, "Late Night Drive") {
		t.Fatalf("playlist meta missing title:\n%s", b)
	}
	// og:image points at the rendered 1200x1200 share card (absolute URL), not the
	// raw cover. The first-song cover fallback now happens inside the card handler.
	cardURL := "https://music.example.com/api/share/playlist/" + pid + "/card.jpg"
	if !strings.Contains(b, `property="og:image" content="`+cardURL+`"`) {
		t.Fatalf("playlist og:image should be the card URL %q:\n%s", cardURL, b)
	}
	if !strings.Contains(b, `property="og:image:width" content="1200"`) || !strings.Contains(b, `property="og:image:height" content="1200"`) {
		t.Fatalf("playlist card should advertise 1200x1200:\n%s", b)
	}
	// The subtitle is the track count (one published track), not a description.
	if !strings.Contains(b, "Playlist · 1 song") {
		t.Fatalf("playlist meta should show track count:\n%s", b)
	}
	// Fetch the card itself: it must render (falling back to the first song's cover)
	// as a 1200x1200 JPEG.
	assertCard(t, h, "/api/share/playlist/"+pid+"/card.jpg")
}

// assertCard fetches a share-card URL and asserts it is a 1200x1200 JPEG.
func assertCard(t *testing.T, h http.Handler, path string) {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("GET %s = %d, body=%s", path, rr.Code, rr.Body.String())
	}
	if ct := rr.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("card content-type = %q, want image/jpeg", ct)
	}
	cfg, err := jpeg.DecodeConfig(bytes.NewReader(rr.Body.Bytes()))
	if err != nil {
		t.Fatalf("card is not a decodable JPEG: %v", err)
	}
	if cfg.Width != 1200 || cfg.Height != 1200 {
		t.Fatalf("card dims = %dx%d, want 1200x1200", cfg.Width, cfg.Height)
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
