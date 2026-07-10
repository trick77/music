package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
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
}
