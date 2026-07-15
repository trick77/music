package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/media"
	"github.com/trick77/music/internal/store"
)

// songAudio reads a song's audio fields off the API — the shape the Info tab sees.
func songAudio(t *testing.T, h http.Handler, id string) (sampleRate, channels, bitrate int) {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/songs/"+id, nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("get song status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var got struct {
		SampleRate  int `json:"sampleRate"`
		Channels    int `json:"channels"`
		BitrateKbps int `json:"bitrateKbps"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return got.SampleRate, got.Channels, got.BitrateKbps
}

// A newly uploaded song carries its audio info immediately — no backfill involved.
// Ground truth for the fixture is ffprobe's: 44100 Hz, 2ch, 128 kbps.
func TestUpload_RecordsAudioInfo(t *testing.T) {
	dev, _ := devAndAnon(t)
	id := uploadedSongID(t, dev)

	sr, ch, br := songAudio(t, dev, id)
	if sr != 44100 || ch != 2 {
		t.Errorf("got %d Hz / %dch, want 44100 / 2", sr, ch)
	}
	if br < 127 || br > 129 {
		t.Errorf("bitrate = %d kbps, want ~128", br)
	}
}

// The reason this PR exists: a row imported before migration 0006 has NULL audio
// info, and only re-reading the file can recover it. Simulate that by nulling the
// columns of a real upload, then run the backfill.
func TestBackfillAudioInfo_RecoversPre0006Rows(t *testing.T) {
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	media := t.TempDir()
	cfg := config.Config{AuthMode: config.AuthModeDev, DevUser: config.DevUserConfig{Username: "dev"}, MediaDir: media, MaxUploadMB: 50}
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	h := New(cfg, st, spa)

	id := uploadedSongID(t, h)

	// Back-date the row to its pre-migration shape.
	if _, err := st.DB().Exec(`UPDATE songs SET sample_rate = NULL, channels = NULL, bitrate_kbps = NULL WHERE id = ?`, id); err != nil {
		t.Fatalf("null out audio info: %v", err)
	}
	if sr, ch, br := songAudio(t, h, id); sr != 0 || ch != 0 || br != 0 {
		t.Fatalf("setup failed: got %d/%d/%d, want zeroes before the backfill", sr, ch, br)
	}

	repo := library.NewRepo(st.DB())
	missing, err := repo.SongsMissingAudioInfo(context.Background())
	if err != nil || len(missing) != 1 {
		t.Fatalf("SongsMissingAudioInfo = %v, %v; want exactly the back-dated row", missing, err)
	}

	// New() ran the backfill against an already-filled library, so drive it directly.
	handlers := &songHandlers{cfg: cfg, repo: repo, media: mustMedia(t, media)}
	handlers.backfillAudioInfo(context.Background())

	sr, ch, br := songAudio(t, h, id)
	if sr != 44100 || ch != 2 {
		t.Errorf("after backfill: got %d Hz / %dch, want 44100 / 2", sr, ch)
	}
	if br < 127 || br > 129 {
		t.Errorf("after backfill: bitrate = %d kbps, want ~128", br)
	}
}

// A row whose file is gone must settle at zeroes rather than being retried on
// every start.
func TestBackfillAudioInfo_SettlesAMissingFile(t *testing.T) {
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	media := t.TempDir()
	cfg := config.Config{AuthMode: config.AuthModeDev, DevUser: config.DevUserConfig{Username: "dev"}, MediaDir: media, MaxUploadMB: 50}
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	h := New(cfg, st, spa)
	id := uploadedSongID(t, h)

	if _, err := st.DB().Exec(`UPDATE songs SET sample_rate = NULL, file_path = 'gone/nope.mp3' WHERE id = ?`, id); err != nil {
		t.Fatalf("break the row: %v", err)
	}

	repo := library.NewRepo(st.DB())
	handlers := &songHandlers{cfg: cfg, repo: repo, media: mustMedia(t, media)}
	handlers.backfillAudioInfo(context.Background()) // must not panic

	missing, err := repo.SongsMissingAudioInfo(context.Background())
	if err != nil {
		t.Fatalf("SongsMissingAudioInfo: %v", err)
	}
	if len(missing) != 0 {
		t.Errorf("%d rows still pending — a dead file would be rescanned on every start", len(missing))
	}
}

func mustMedia(t *testing.T, root string) *media.Store {
	t.Helper()
	m, err := media.New(root)
	if err != nil {
		t.Fatalf("media.New: %v", err)
	}
	return m
}
