package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// listPlaylistIDs returns the ids from GET /api/playlists.
func listPlaylistIDs(t *testing.T, h http.Handler) []string {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/playlists", nil))
	var list struct {
		Playlists []struct {
			ID string `json:"id"`
		} `json:"playlists"`
	}
	json.Unmarshal(rr.Body.Bytes(), &list)
	ids := make([]string, 0, len(list.Playlists))
	for _, p := range list.Playlists {
		ids = append(ids, p.ID)
	}
	return ids
}

func TestPlaylistPublish_createdUnpublishedAndHiddenFromAnonymous(t *testing.T) {
	dev, anon := devAndAnon(t)
	pid := createPlaylist(t, dev, "Late Night Drive", "")

	// Created unpublished: dev sees published=false in the detail.
	var detail struct {
		Published bool `json:"published"`
	}
	getJSON(t, dev, "/api/playlists/"+pid, &detail)
	if detail.Published {
		t.Fatalf("new playlist should be unpublished")
	}

	// Anonymous: invisible in the list and 404 directly.
	if ids := listPlaylistIDs(t, anon); len(ids) != 0 {
		t.Fatalf("anon playlist list = %v, want empty", ids)
	}
	if code := getStatus(t, anon, "/api/playlists/"+pid); code != http.StatusNotFound {
		t.Fatalf("anon playlist get = %d, want 404", code)
	}
	// Authenticated sees it.
	if ids := listPlaylistIDs(t, dev); len(ids) != 1 {
		t.Fatalf("dev playlist list = %v, want 1", ids)
	}

	// Anonymous cannot publish/unpublish.
	if rr := doJSON(t, anon, "POST", "/api/playlists/"+pid+"/publish", ""); rr.Code != http.StatusForbidden {
		t.Fatalf("anon publish = %d, want 403", rr.Code)
	}

	// Publish → visible to anonymous.
	if rr := doJSON(t, dev, "POST", "/api/playlists/"+pid+"/publish", ""); rr.Code != http.StatusOK {
		t.Fatalf("publish = %d, body=%s", rr.Code, rr.Body.String())
	}
	if ids := listPlaylistIDs(t, anon); len(ids) != 1 || ids[0] != pid {
		t.Fatalf("after publish, anon list = %v, want [%s]", ids, pid)
	}
	if code := getStatus(t, anon, "/api/playlists/"+pid); code != http.StatusOK {
		t.Fatalf("after publish, anon get = %d, want 200", code)
	}

	// Unpublish → hidden again.
	if rr := doJSON(t, dev, "POST", "/api/playlists/"+pid+"/unpublish", ""); rr.Code != http.StatusOK {
		t.Fatalf("unpublish = %d", rr.Code)
	}
	if code := getStatus(t, anon, "/api/playlists/"+pid); code != http.StatusNotFound {
		t.Fatalf("after unpublish, anon get = %d, want 404", code)
	}
}

func TestPlaylistPublish_unknownID(t *testing.T) {
	dev, _ := devAndAnon(t)
	if rr := doJSON(t, dev, "POST", "/api/playlists/nope/publish", ""); rr.Code != http.StatusNotFound {
		t.Fatalf("publish unknown playlist = %d, want 404", rr.Code)
	}
}
