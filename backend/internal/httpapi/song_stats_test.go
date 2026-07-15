package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// These drive the assembled handler from New(), so they cover the route table and
// the auth gate, not just the handler function.

func TestGetSongStats_ReportsPlaysForAuthenticated(t *testing.T) {
	dev, _ := devAndAnon(t)
	id := uploadedSongID(t, dev)

	// Record a play through the public endpoint — the only way plays are created.
	rr := httptest.NewRecorder()
	dev.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/api/songs/"+id+"/play", nil))
	if rr.Code != http.StatusNoContent {
		t.Fatalf("post play status = %d", rr.Code)
	}

	rr = httptest.NewRecorder()
	dev.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/songs/"+id+"/stats", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var got struct {
		Plays        int    `json:"plays"`
		LastPlayedAt string `json:"lastPlayedAt"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Plays != 1 {
		t.Errorf("plays = %d, want 1", got.Plays)
	}
	if got.LastPlayedAt == "" {
		t.Error("lastPlayedAt is empty, want the play we just recorded")
	}
}

func TestGetSongStats_ZeroForNeverPlayed(t *testing.T) {
	dev, _ := devAndAnon(t)
	id := uploadedSongID(t, dev)

	rr := httptest.NewRecorder()
	dev.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/songs/"+id+"/stats", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var got struct {
		Plays        int    `json:"plays"`
		LastPlayedAt string `json:"lastPlayedAt"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Plays != 0 || got.LastPlayedAt != "" {
		t.Errorf("got %+v, want zero plays and no timestamp", got)
	}
}

// Stats are editor-only. Plays are a public WRITE (the one documented anonymous
// write), but reading a song's counts is not public — and the app deliberately
// shows play counts nowhere but this tab.
func TestGetSongStats_ForbiddenForAnonymous(t *testing.T) {
	dev, anon := devAndAnon(t)
	id := uploadedSongID(t, dev)

	rr := httptest.NewRecorder()
	anon.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/songs/"+id+"/stats", nil))
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for an anonymous reader", rr.Code)
	}
}

func TestGetSongStats_NotFoundForUnknownSong(t *testing.T) {
	dev, _ := devAndAnon(t)

	rr := httptest.NewRecorder()
	dev.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/songs/nope/stats", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rr.Code)
	}
}
