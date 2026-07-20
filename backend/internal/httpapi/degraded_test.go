package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/store"
)

// TestRoutes_databaseUnavailableIs5xx pulls the database out from under a live
// server and replays the read/write surface. Every route must answer with a
// server error (never panic, never a bogus 200/404 that would look like "no such
// song" to the client) and must not leak the driver's message.
func TestRoutes_databaseUnavailableIs5xx(t *testing.T) {
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	mediaDir := t.TempDir()
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	cfg := config.Config{
		AuthMode: config.AuthModeDev, DevUser: config.DevUserConfig{Username: "dev"},
		MediaDir: mediaDir, MaxUploadMB: 50,
	}
	h := New(cfg, st, spa)
	if s, ok := h.(*server); ok {
		t.Cleanup(s.Wait)
	}

	// Seed real ids so the routes get past their path parsing.
	repo := library.NewRepo(st.DB())
	song := mkAlbumSong(t, repo, "One", "Neon Nights", "h1", "songs/a.mp3")
	pid := createPlaylist(t, h, "Drive", "")

	if err := st.Close(); err != nil {
		t.Fatalf("close store: %v", err)
	}

	for _, tc := range []struct{ method, path, body string }{
		{"GET", "/api/songs", ""},
		{"GET", "/api/songs/" + song.ID, ""},
		{"GET", "/api/songs/" + song.ID + "/stream", ""},
		{"GET", "/api/songs/" + song.ID + "/download", ""},
		{"GET", "/api/songs/" + song.ID + "/stats", ""},
		{"GET", "/api/songs/" + song.ID + "/align", ""},
		{"GET", "/api/songs/" + song.ID + "/cover/download", ""},
		{"GET", "/api/cover/any", ""},
		{"GET", "/api/artists", ""},
		{"GET", "/api/artists/" + song.ArtistID, ""},
		{"GET", "/api/genres", ""},
		{"GET", "/api/genres/g-any", ""},
		{"GET", "/api/home", ""},
		{"GET", "/api/search?q=a", ""},
		{"GET", "/api/suggest?field=artist&q=a", ""},
		{"GET", "/api/top-ten", ""},
		{"GET", "/api/albums", ""},
		{"GET", "/api/favorites", ""},
		{"GET", "/api/playlists", ""},
		{"GET", "/api/playlists/" + pid, ""},
		{"GET", "/api/fanart/any", ""},
		{"GET", "/api/share/song/" + song.ID + "/card.jpg", ""},
		{"GET", "/api/share/playlist/" + pid + "/card.jpg", ""},
		{"POST", "/api/songs/" + song.ID + "/play", ""},
		{"POST", "/api/songs/" + song.ID + "/publish", ""},
		{"POST", "/api/songs/" + song.ID + "/unpublish", ""},
		{"POST", "/api/playlists", `{"name":"X"}`},
		{"PATCH", "/api/playlists/" + pid, `{"name":"X"}`},
		{"DELETE", "/api/playlists/" + pid, ""},
		{"PUT", "/api/playlists/" + pid + "/reorder", `{"songIds":[]}`},
		{"PATCH", "/api/songs/" + song.ID, `{"title":"T"}`},
		{"PATCH", "/api/genres/g-any", `{"name":"X"}`},
		{"DELETE", "/api/songs/" + song.ID, ""},
		{"DELETE", "/api/songs/" + song.ID + "/cover", ""},
		{"PUT", "/api/favorites/" + song.ID, ""},
		{"DELETE", "/api/favorites/" + song.ID, ""},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			rr := httptest.NewRecorder()
			h.ServeHTTP(rr, req)
			if rr.Code < 500 {
				t.Fatalf("code = %d, want a 5xx when the database is gone (body %s)", rr.Code, rr.Body)
			}
			if strings.Contains(strings.ToLower(rr.Body.String()), "sql") {
				t.Fatalf("leaked driver detail: %s", rr.Body)
			}
		})
	}
}
