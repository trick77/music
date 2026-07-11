package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/store"
)

// deleteTestServer builds a handler over a fresh store and returns the media dir
// so tests can assert on-disk file removal.
func deleteTestServer(t *testing.T, mode config.AuthMode) (http.Handler, string) {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	mediaDir := t.TempDir()
	cfg := config.Config{AuthMode: mode, DevUser: config.DevUserConfig{Username: "dev"}, MediaDir: mediaDir, MaxUploadMB: 50}
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	return New(cfg, st, spa), mediaDir
}

func TestDeleteSong_removesRowAndFile(t *testing.T) {
	h, mediaDir := deleteTestServer(t, config.AuthModeDev)
	rr := uploadFixture(t, h)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", rr.Code, rr.Body)
	}
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(rr.Body.Bytes(), &song)
	filePath := filepath.Join(mediaDir, "songs", song.ID+".mp3")
	if _, err := os.Stat(filePath); err != nil {
		t.Fatalf("expected audio file present: %v", err)
	}

	del := httptest.NewRecorder()
	h.ServeHTTP(del, httptest.NewRequest("DELETE", "/api/songs/"+song.ID, nil))
	if del.Code != http.StatusNoContent {
		t.Fatalf("delete code = %d, want 204 (body %s)", del.Code, del.Body)
	}
	if _, err := os.Stat(filePath); !os.IsNotExist(err) {
		t.Fatalf("audio file not removed: %v", err)
	}
	get := httptest.NewRecorder()
	h.ServeHTTP(get, httptest.NewRequest("GET", "/api/songs/"+song.ID, nil))
	if get.Code != http.StatusNotFound {
		t.Fatalf("song still present after delete: %d", get.Code)
	}
}

func TestDeleteSong_missingReturns404(t *testing.T) {
	h, _ := deleteTestServer(t, config.AuthModeDev)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("DELETE", "/api/songs/does-not-exist", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", rr.Code)
	}
}

func TestDeleteSong_anonymousForbidden(t *testing.T) {
	h, _ := deleteTestServer(t, config.AuthModeOIDC)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("DELETE", "/api/songs/whatever", nil))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", rr.Code)
	}
}
