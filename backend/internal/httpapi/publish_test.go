package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trick77/music/internal/config"
)

// getStatus issues a GET and returns the status code.
func getStatus(t *testing.T, h http.Handler, path string) int {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
	return rr.Code
}

// listSongIDs returns the ids from GET /api/songs.
func listSongIDs(t *testing.T, h http.Handler) []string {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/songs", nil))
	var list struct {
		Songs []struct {
			ID string `json:"id"`
		} `json:"songs"`
	}
	json.Unmarshal(rr.Body.Bytes(), &list)
	ids := make([]string, 0, len(list.Songs))
	for _, s := range list.Songs {
		ids = append(ids, s.ID)
	}
	return ids
}

func TestUpload_landsUnpublished(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	rr := uploadFixture(t, h)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload = %d, body=%s", rr.Code, rr.Body.String())
	}
	var song struct {
		Published bool `json:"published"`
	}
	json.Unmarshal(rr.Body.Bytes(), &song)
	if song.Published {
		t.Fatalf("uploaded song should land unpublished")
	}
}

func TestPublish_hidesUnpublishedFromAnonymous(t *testing.T) {
	dev, anon := devAndAnon(t)
	id := uploadedSongID(t, dev)

	// Anonymous: the unpublished song is invisible everywhere.
	if ids := listSongIDs(t, anon); len(ids) != 0 {
		t.Fatalf("anonymous list = %v, want empty", ids)
	}
	if code := getStatus(t, anon, "/api/songs/"+id); code != http.StatusNotFound {
		t.Fatalf("anonymous get = %d, want 404", code)
	}
	if code := getStatus(t, anon, "/api/songs/"+id+"/stream"); code != http.StatusNotFound {
		t.Fatalf("anonymous stream = %d, want 404", code)
	}
	if code := getStatus(t, anon, "/api/songs/"+id+"/download"); code != http.StatusNotFound {
		t.Fatalf("anonymous download = %d, want 404", code)
	}
	// Authenticated (dev) sees it regardless.
	if ids := listSongIDs(t, dev); len(ids) != 1 {
		t.Fatalf("dev list = %v, want 1", ids)
	}

	// Publish, then the anonymous viewer can see and stream it.
	if rr := doJSON(t, dev, "POST", "/api/songs/"+id+"/publish", ""); rr.Code != http.StatusOK {
		t.Fatalf("publish = %d, body=%s", rr.Code, rr.Body.String())
	}
	if ids := listSongIDs(t, anon); len(ids) != 1 || ids[0] != id {
		t.Fatalf("after publish, anonymous list = %v, want [%s]", ids, id)
	}
	if code := getStatus(t, anon, "/api/songs/"+id); code != http.StatusOK {
		t.Fatalf("after publish, anonymous get = %d, want 200", code)
	}

	// Unpublish hides it again.
	if rr := doJSON(t, dev, "POST", "/api/songs/"+id+"/unpublish", ""); rr.Code != http.StatusOK {
		t.Fatalf("unpublish = %d, body=%s", rr.Code, rr.Body.String())
	}
	if ids := listSongIDs(t, anon); len(ids) != 0 {
		t.Fatalf("after unpublish, anonymous list = %v, want empty", ids)
	}
}

func TestPublish_anonymousForbidden(t *testing.T) {
	dev, anon := devAndAnon(t)
	id := uploadedSongID(t, dev)
	if rr := doJSON(t, anon, "POST", "/api/songs/"+id+"/publish", ""); rr.Code != http.StatusForbidden {
		t.Fatalf("anonymous publish = %d, want 403", rr.Code)
	}
	if rr := doJSON(t, anon, "POST", "/api/songs/"+id+"/unpublish", ""); rr.Code != http.StatusForbidden {
		t.Fatalf("anonymous unpublish = %d, want 403", rr.Code)
	}
}

func TestPublish_unknownID(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	if rr := doJSON(t, h, "POST", "/api/songs/nope/publish", ""); rr.Code != http.StatusNotFound {
		t.Fatalf("publish unknown id = %d, want 404", rr.Code)
	}
}
