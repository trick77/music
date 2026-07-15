package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
	st, media, cfg, h := backfillEnv(t)
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

// A file we cannot OPEN must stay pending, not settle. "File not found" is exactly
// what a media volume that hasn't mounted yet looks like — settling those would
// zero the whole library on one unlucky boot, permanently, since a 0 row is never
// pending again.
func TestBackfillAudioInfo_RetriesAnUnreadableFile(t *testing.T) {
	st, media, cfg, h := backfillEnv(t)
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
	if len(missing) != 1 {
		t.Fatalf("%d rows pending, want 1 — an unopenable file must be retried, not written off", len(missing))
	}
}

// A file that opens but isn't decodable really is permanent, so it settles at
// zeroes and stops being rescanned on every start.
func TestBackfillAudioInfo_SettlesAnUndecodableFile(t *testing.T) {
	st, media, cfg, h := backfillEnv(t)
	id := uploadedSongID(t, h)

	// A real file, readable, that will never parse as an MP3.
	if err := os.MkdirAll(filepath.Join(media, "junk"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(media, "junk", "notmusic.mp3"), []byte("this is not an mp3"), 0o644); err != nil {
		t.Fatalf("write junk: %v", err)
	}
	if _, err := st.DB().Exec(`UPDATE songs SET sample_rate = NULL, file_path = 'junk/notmusic.mp3' WHERE id = ?`, id); err != nil {
		t.Fatalf("point at junk: %v", err)
	}

	repo := library.NewRepo(st.DB())
	handlers := &songHandlers{cfg: cfg, repo: repo, media: mustMedia(t, media)}
	handlers.backfillAudioInfo(context.Background())

	missing, err := repo.SongsMissingAudioInfo(context.Background())
	if err != nil {
		t.Fatalf("SongsMissingAudioInfo: %v", err)
	}
	if len(missing) != 0 {
		t.Errorf("%d rows still pending — an undecodable file would be rescanned forever", len(missing))
	}
	if sr, ch, br := songAudio(t, h, id); sr != 0 || ch != 0 || br != 0 {
		t.Errorf("got %d/%d/%d, want zeroes — the UI renders these as an em dash", sr, ch, br)
	}
}

// backfillEnv builds a real store + media dir + assembled handler, the shape the
// backfill tests all need.
func backfillEnv(t *testing.T) (*store.Store, string, config.Config, http.Handler) {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	mediaDir := t.TempDir()
	cfg := config.Config{AuthMode: config.AuthModeDev, DevUser: config.DevUserConfig{Username: "dev"}, MediaDir: mediaDir, MaxUploadMB: 50}
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	return st, mediaDir, cfg, New(cfg, st, spa)
}

func mustMedia(t *testing.T, root string) *media.Store {
	t.Helper()
	m, err := media.New(root)
	if err != nil {
		t.Fatalf("media.New: %v", err)
	}
	return m
}
