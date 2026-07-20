package httpapi

import (
	"net/http"
	"testing"

	"github.com/trick77/music/internal/config"
)

// Adding a song to a playlist that does not exist is a bad id, not a server
// fault. AddSong trips a foreign-key violation for an unknown playlist, which
// used to surface as a 500 while every sibling route answered 404 for the very
// same id — this pins them to the same answer.
func TestAddSong_unknownPlaylistIs404(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	songID := uploadSongID(t, h)

	rr := doJSON(t, h, "POST", "/api/playlists/no-such-playlist/songs", `{"songId":"`+songID+`"}`)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("add song to unknown playlist = %d, want 404; body=%s", rr.Code, rr.Body.String())
	}
	// The sibling routes must agree, since the id is equally unknown to all of them.
	for _, tc := range []struct{ method, path, body string }{
		{"PATCH", "/api/playlists/no-such-playlist", `{"name":"x"}`},
		{"DELETE", "/api/playlists/no-such-playlist/songs/" + songID, ""},
		{"PUT", "/api/playlists/no-such-playlist/order", `{"songIds":[]}`},
	} {
		if got := doJSON(t, h, tc.method, tc.path, tc.body); got.Code != http.StatusNotFound {
			t.Errorf("%s %s = %d, want 404 (must match addSong); body=%s", tc.method, tc.path, got.Code, got.Body.String())
		}
	}
}

// The happy path must keep working — the 404 branch only opens on an error from
// AddSong, so a real playlist is unaffected.
func TestAddSong_existingPlaylistStillSucceeds(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	songID := uploadSongID(t, h)
	playlistID := createPlaylist(t, h, "Night Drive", "")

	rr := doJSON(t, h, "POST", "/api/playlists/"+playlistID+"/songs", `{"songId":"`+songID+`"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("add song = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
}
