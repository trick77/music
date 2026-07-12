package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/store"
)

// devAndAnon builds a dev (authenticated) and an oidc (anonymous) handler over
// ONE shared store + media dir, so a song uploaded via dev is visible to the
// anonymous handler.
func devAndAnon(t *testing.T) (dev http.Handler, anon http.Handler) {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	media := t.TempDir()
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	mk := func(mode config.AuthMode) http.Handler {
		cfg := config.Config{AuthMode: mode, DevUser: config.DevUserConfig{Username: "dev"}, MediaDir: media, MaxUploadMB: 50}
		return New(cfg, st, spa)
	}
	return mk(config.AuthModeDev), mk(config.AuthModeOIDC)
}

// uploadedSongID uploads the fixture and returns the created song id.
func uploadedSongID(t *testing.T, h http.Handler) string {
	t.Helper()
	rr := uploadFixture(t, h)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var song struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &song); err != nil || song.ID == "" {
		t.Fatalf("decode song id: %v (%s)", err, rr.Body.String())
	}
	return song.ID
}

// postPlayFrom posts a play for id from a given client address.
func postPlayFrom(t *testing.T, h http.Handler, id, remoteAddr string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/songs/"+id+"/play", nil)
	req.RemoteAddr = remoteAddr
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

// postPlayFromProxy posts a play as Traefik would forward it: RemoteAddr is
// the proxy's own address, and X-Forwarded-For carries the real client IP.
func postPlayFromProxy(t *testing.T, h http.Handler, id, proxyAddr, forwardedFor string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/songs/"+id+"/play", nil)
	req.RemoteAddr = proxyAddr
	req.Header.Set("X-Forwarded-For", forwardedFor)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func topTenCount(t *testing.T, h http.Handler) map[string]int {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/top-ten", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("top-ten status = %d", rr.Code)
	}
	var body struct {
		Songs []struct {
			ID    string `json:"id"`
			Plays int    `json:"plays"`
		} `json:"songs"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode top-ten: %v (%s)", err, rr.Body.String())
	}
	out := map[string]int{}
	for _, s := range body.Songs {
		out[s.ID] = s.Plays
	}
	return out
}

func TestPlay_recordsAndCounts(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	id := uploadedSongID(t, h)
	if rr := postPlayFrom(t, h, id, "1.2.3.4:5000"); rr.Code != http.StatusNoContent {
		t.Fatalf("play status = %d, body = %s", rr.Code, rr.Body.String())
	}
	if got := topTenCount(t, h)[id]; got != 1 {
		t.Fatalf("play count = %d, want 1", got)
	}
}

func TestPlay_isPublicButOtherWritesAreNot(t *testing.T) {
	// Anonymous (oidc, no session) may record a play — the one documented
	// public write.
	dev, anon := devAndAnon(t)
	id := uploadedSongID(t, dev) // upload needs auth; do it in dev, then hit /play anon.

	if rr := postPlayFrom(t, anon, id, "9.9.9.9:1000"); rr.Code != http.StatusNoContent {
		t.Fatalf("anonymous /play = %d, want 204 (public exception)", rr.Code)
	}
	// A different write stays gated for anonymous.
	req := httptest.NewRequest("PATCH", "/api/songs/"+id, nil)
	rr := httptest.NewRecorder()
	anon.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("anonymous PATCH /songs = %d, want 403 (writes gated)", rr.Code)
	}
}

func TestPlay_throttlesReplayPerClient(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	id := uploadedSongID(t, h)
	// Two plays, same client, within the cooldown => exactly one recorded.
	postPlayFrom(t, h, id, "5.5.5.5:1")
	postPlayFrom(t, h, id, "5.5.5.5:2") // same host, different ephemeral port
	if got := topTenCount(t, h)[id]; got != 1 {
		t.Fatalf("same-client replay count = %d, want 1 (throttled)", got)
	}
	// A different client counts independently.
	postPlayFrom(t, h, id, "6.6.6.6:1")
	if got := topTenCount(t, h)[id]; got != 2 {
		t.Fatalf("count after second client = %d, want 2", got)
	}
}

func TestPlay_throttlesPerForwardedClientBehindProxy(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	id := uploadedSongID(t, h)
	// Same proxy RemoteAddr for every request (as Traefik would present), but
	// distinct X-Forwarded-For clients must still be throttled independently.
	const proxyAddr = "10.0.0.1:443"
	postPlayFromProxy(t, h, id, proxyAddr, "1.2.3.4")
	postPlayFromProxy(t, h, id, proxyAddr, "1.2.3.4") // same forwarded client, replay => throttled
	if got := topTenCount(t, h)[id]; got != 1 {
		t.Fatalf("same-forwarded-client replay count = %d, want 1 (throttled)", got)
	}
	postPlayFromProxy(t, h, id, proxyAddr, "5.6.7.8") // distinct forwarded client
	if got := topTenCount(t, h)[id]; got != 2 {
		t.Fatalf("count after second forwarded client = %d, want 2", got)
	}
}

func TestPlay_forwardedForUsesLeftmostHopAsClient(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	id := uploadedSongID(t, h)
	const proxyAddr = "10.0.0.1:443"
	// A multi-hop chain: leftmost entry is the original client.
	postPlayFromProxy(t, h, id, proxyAddr, "1.2.3.4, 10.0.0.9")
	postPlayFromProxy(t, h, id, proxyAddr, "1.2.3.4,10.0.0.9") // same client, no space => still throttled
	if got := topTenCount(t, h)[id]; got != 1 {
		t.Fatalf("play count = %d, want 1 (throttled on leftmost XFF entry)", got)
	}
}

func TestPlay_unknownSong404(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	if rr := postPlayFrom(t, h, "nope", "1.1.1.1:1"); rr.Code != http.StatusNotFound {
		t.Fatalf("unknown song /play = %d, want 404", rr.Code)
	}
}

func TestTopTen_emptyIsEmptyArray(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/top-ten", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d", rr.Code)
	}
	if body := rr.Body.String(); !containsJSONEmptySongs(body) {
		t.Fatalf("empty top-ten body = %s, want songs:[]", body)
	}
}

func containsJSONEmptySongs(body string) bool {
	var v struct {
		Songs []any `json:"songs"`
	}
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		return false
	}
	return v.Songs != nil && len(v.Songs) == 0
}

func TestPlayThrottle_allowCooldownWithInjectedTime(t *testing.T) {
	th := newPlayThrottle()
	base := time.Unix(1_000_000, 0)
	key := "ip|song"
	if !th.allow(key, base) {
		t.Fatal("first play should be allowed")
	}
	if th.allow(key, base.Add(playCooldown-time.Millisecond)) {
		t.Fatal("replay within cooldown should be blocked")
	}
	if !th.allow(key, base.Add(playCooldown)) {
		t.Fatal("play at exactly cooldown boundary should be allowed again")
	}
	// A different key is independent.
	if !th.allow("ip|other", base) {
		t.Fatal("distinct key should be allowed")
	}
}
