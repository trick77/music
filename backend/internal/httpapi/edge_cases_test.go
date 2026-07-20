package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// --- alignment request edges ---

func TestPostAlign_unknownSongAndMissingLyrics(t *testing.T) {
	stub := stubSidecar(t)
	defer stub.Close()
	h := alignEnabledServer(t, stub.URL)

	if rr := postJSON(t, h, "/api/songs/ghost/align", nil); rr.Code != http.StatusNotFound {
		t.Fatalf("unknown song = %d, want 404 (body %s)", rr.Code, rr.Body)
	}

	sid := uploadSongID(t, h)
	// Clear whatever lyrics the fixture carried; alignment is meaningless without
	// words and must be refused up front rather than queued.
	if rr := doJSON(t, h, "PATCH", "/api/songs/"+sid, `{"title":"Test Song","lyrics":""}`); rr.Code != http.StatusOK {
		t.Fatalf("patch = %d, body %s", rr.Code, rr.Body)
	}
	if rr := postJSON(t, h, "/api/songs/"+sid+"/align", nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("lyric-less align = %d, want 400 (body %s)", rr.Code, rr.Body)
	}
}

func TestGetAlign_unknownSongAndNoAlignmentRow(t *testing.T) {
	stub := stubSidecar(t)
	defer stub.Close()
	h := alignEnabledServer(t, stub.URL)

	if rr := getRec(t, h, "/api/songs/ghost/align"); rr.Code != http.StatusNotFound {
		t.Fatalf("unknown song = %d, want 404", rr.Code)
	}
	sid := uploadSongID(t, h)
	if rr := doJSON(t, h, "PATCH", "/api/songs/"+sid, `{"title":"Test Song","lyrics":""}`); rr.Code != http.StatusOK {
		t.Fatalf("patch = %d, body %s", rr.Code, rr.Body)
	}
	// A never-aligned song has no row at all: 404, not an empty status object.
	if rr := getRec(t, h, "/api/songs/"+sid+"/align"); rr.Code != http.StatusNotFound {
		t.Fatalf("un-aligned song = %d, want 404 (body %s)", rr.Code, rr.Body)
	}
}

// --- images whose files vanished from the volume ---

// A cover_art row can outlive its file (manual volume surgery, a failed
// restore). Both the original and the sized variant must 404 rather than 500.
func TestGetCover_rowWithoutFileIs404(t *testing.T) {
	ts := newServeServer(t, 50)
	sid := uploadSongID(t, ts.dev)
	up := uploadCover(t, ts.dev, sid)
	var song struct {
		CoverArtID string `json:"coverArtId"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)

	relPath, err := ts.repo.GetCoverPath(t.Context(), song.CoverArtID)
	if err != nil || relPath == "" {
		t.Fatalf("cover path: %q (%v)", relPath, err)
	}
	if err := os.Remove(filepath.Join(ts.mediaDir, filepath.FromSlash(relPath))); err != nil {
		t.Fatalf("remove cover file: %v", err)
	}

	for _, path := range []string{
		"/api/cover/" + song.CoverArtID,
		"/api/cover/" + song.CoverArtID + "?size=thumb",
		"/api/songs/" + sid + "/cover/download",
	} {
		if rr := getRec(t, ts.dev, path); rr.Code != http.StatusNotFound {
			t.Fatalf("GET %s = %d, want 404", path, rr.Code)
		}
	}

	// The share card still renders — it falls back to a text-only layout rather
	// than failing the unfurl.
	if rr := postJSON(t, ts.dev, "/api/songs/"+sid+"/publish", nil); rr.Code != http.StatusOK {
		t.Fatalf("publish = %d", rr.Code)
	}
	card := getRec(t, ts.dev, "/api/share/song/"+sid+"/card.jpg")
	if card.Code != http.StatusOK || card.Body.Len() == 0 {
		t.Fatalf("share card = %d, %d bytes", card.Code, card.Body.Len())
	}
	if ct := card.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("share card Content-Type = %q, want image/jpeg", ct)
	}
}

// Identical cover bytes uploaded to two songs are stored once and share a
// cover_art id (dedupe by content hash).
func TestCoverUpload_dedupesIdenticalBytes(t *testing.T) {
	ts := newServeServer(t, 50)
	first := uploadSongID(t, ts.dev)
	second := ts.repo // second song is seeded directly to keep distinct content hashes
	other := mkAlbumSong(t, second, "Two", "Other Album", "h-other", "songs/other.mp3")

	coverID := func(rr *httptest.ResponseRecorder) string {
		t.Helper()
		var out struct {
			CoverArtID string `json:"coverArtId"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatalf("decode: %v (body %s)", err, rr.Body)
		}
		return out.CoverArtID
	}

	a := coverID(uploadCover(t, ts.dev, first))
	b := coverID(uploadCover(t, ts.dev, other.ID))
	if a == "" || a != b {
		t.Fatalf("cover ids = %q / %q, want one deduped id", a, b)
	}
}

// --- play throttle internals ---

// The throttle sweeps expired keys once the map grows past its cap, so a
// long-running server cannot accumulate them without bound. Driven with an
// injected clock so it never depends on wall time.
func TestPlayThrottle_sweepsExpiredKeysOverCap(t *testing.T) {
	p := newPlayThrottle()
	base := time.Unix(1_700_000_000, 0)

	for i := 0; i < 5000; i++ {
		if !p.allow("song-"+strconv.Itoa(i), base) {
			t.Fatalf("first play of key %d was rejected", i)
		}
	}
	// Nothing has expired yet, so the sweep could not shrink the map.
	if len(p.seen) != 5000 {
		t.Fatalf("tracked %d keys, want 5000 before anything expires", len(p.seen))
	}

	// One more play past the cooldown makes every earlier key sweepable.
	if !p.allow("late", base.Add(playCooldown)) {
		t.Fatal("a fresh key past the cooldown must be allowed")
	}
	if len(p.seen) != 1 {
		t.Fatalf("tracked %d keys after the sweep, want only the fresh one", len(p.seen))
	}
	// The swept key is treated as unseen again.
	if !p.allow("song-0", base.Add(playCooldown)) {
		t.Fatal("a swept key must be allowed again")
	}
}

func TestClientIP_fallsBackToRemoteAddr(t *testing.T) {
	for _, tc := range []struct {
		name, remote, xff, want string
	}{
		{"host:port is split", "203.0.113.7:54321", "", "203.0.113.7"},
		{"bare address is used as-is", "203.0.113.9", "", "203.0.113.9"},
		{"forwarded header wins", "10.0.0.1:80", "198.51.100.4, 10.0.0.1", "198.51.100.4"},
		{"blank forwarded entry falls through", "10.0.0.1:80", " ", "10.0.0.1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/songs/x/play", nil)
			r.RemoteAddr = tc.remote
			if tc.xff != "" {
				r.Header.Set("X-Forwarded-For", tc.xff)
			}
			if got := clientIP(r); got != tc.want {
				t.Fatalf("clientIP = %q, want %q", got, tc.want)
			}
		})
	}
}

// --- share cards ---

func TestPlaylistCard_countsPublishedSongsAndFallsBackToTrackArt(t *testing.T) {
	ts := newServeServer(t, 50)
	pid := createPlaylist(t, ts.dev, "Drive", "")
	// The card mirrors the anonymous view, so an unpublished playlist has no
	// card at all.
	if unpub := getRec(t, ts.dev, "/api/share/playlist/"+pid+"/card.jpg"); unpub.Code != http.StatusNotFound {
		t.Fatalf("unpublished playlist card = %d, want 404", unpub.Code)
	}
	if rr := postJSON(t, ts.dev, "/api/playlists/"+pid+"/publish", nil); rr.Code != http.StatusOK {
		t.Fatalf("publish playlist = %d, body %s", rr.Code, rr.Body)
	}

	// Empty playlist: still renders, subtitle pluralization is exercised by the
	// count below.
	empty := getRec(t, ts.dev, "/api/share/playlist/"+pid+"/card.jpg")
	if empty.Code != http.StatusOK || empty.Body.Len() == 0 {
		t.Fatalf("empty playlist card = %d, %d bytes", empty.Code, empty.Body.Len())
	}

	sid := uploadSongID(t, ts.dev)
	if rr := uploadCover(t, ts.dev, sid); rr.Code != http.StatusOK {
		t.Fatalf("cover upload = %d", rr.Code)
	}
	if rr := postJSON(t, ts.dev, "/api/songs/"+sid+"/publish", nil); rr.Code != http.StatusOK {
		t.Fatalf("publish = %d", rr.Code)
	}
	if rr := doJSON(t, ts.dev, "POST", "/api/playlists/"+pid+"/songs", fmt.Sprintf(`{"songId":%q}`, sid)); rr.Code != http.StatusOK {
		t.Fatalf("add song = %d, body %s", rr.Code, rr.Body)
	}

	// The playlist has no cover of its own, so the card falls back to the first
	// published track's art.
	withTrack := getRec(t, ts.dev, "/api/share/playlist/"+pid+"/card.jpg")
	if withTrack.Code != http.StatusOK || withTrack.Body.Len() == 0 {
		t.Fatalf("playlist card = %d, %d bytes", withTrack.Code, withTrack.Body.Len())
	}
	if withTrack.Body.Len() == empty.Body.Len() {
		t.Fatal("card is unchanged after adding a covered track; the cover fallback did not apply")
	}

	if unknown := getRec(t, ts.dev, "/api/share/playlist/ghost/card.jpg"); unknown.Code != http.StatusNotFound {
		t.Fatalf("unknown playlist card = %d, want 404", unknown.Code)
	}
}
