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

// getJSON issues a GET and unmarshals the JSON body into v.
func getJSON(t *testing.T, h http.Handler, path string, v any) {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
	if err := json.Unmarshal(rr.Body.Bytes(), v); err != nil {
		t.Fatalf("decode %s: %v (body=%s)", path, err, rr.Body.String())
	}
}

func TestBrowse_anonymousHidesUnpublishedOnlyArtistAndGenre(t *testing.T) {
	dev, anon := devAndAnon(t)
	uploadedSongID(t, dev) // fixture lands unpublished ("Test Artist", genres Synthwave/Dream Pop)

	// Resolve the artist + a genre id as the authenticated viewer.
	var songs struct {
		Songs []struct {
			ArtistID string `json:"artistId"`
		} `json:"songs"`
	}
	getJSON(t, dev, "/api/songs", &songs)
	if len(songs.Songs) != 1 {
		t.Fatalf("dev songs = %d, want 1", len(songs.Songs))
	}
	artistID := songs.Songs[0].ArtistID
	var genres struct {
		Genres []struct {
			ID string `json:"id"`
		} `json:"genres"`
	}
	getJSON(t, dev, "/api/genres", &genres)
	if len(genres.Genres) == 0 {
		t.Fatalf("dev genres empty")
	}
	genreID := genres.Genres[0].ID

	// Anonymous: the artist and genres are hidden entirely and their pages 404.
	var anonArtists struct {
		Artists []json.RawMessage `json:"artists"`
	}
	getJSON(t, anon, "/api/artists", &anonArtists)
	if len(anonArtists.Artists) != 0 {
		t.Fatalf("anon artist list = %d, want 0", len(anonArtists.Artists))
	}
	var anonGenres struct {
		Genres []json.RawMessage `json:"genres"`
	}
	getJSON(t, anon, "/api/genres", &anonGenres)
	if len(anonGenres.Genres) != 0 {
		t.Fatalf("anon genre list = %d, want 0", len(anonGenres.Genres))
	}
	if code := getStatus(t, anon, "/api/artists/"+artistID); code != http.StatusNotFound {
		t.Fatalf("anon artist page = %d, want 404", code)
	}
	if code := getStatus(t, anon, "/api/genres/"+genreID); code != http.StatusNotFound {
		t.Fatalf("anon genre page = %d, want 404", code)
	}

	// Publishing the song surfaces the artist + genre for anonymous.
	if rr := doJSON(t, dev, "POST", "/api/songs/"+listSongIDs(t, dev)[0]+"/publish", ""); rr.Code != http.StatusOK {
		t.Fatalf("publish = %d", rr.Code)
	}
	getJSON(t, anon, "/api/artists", &anonArtists)
	if len(anonArtists.Artists) != 1 {
		t.Fatalf("after publish, anon artist list = %d, want 1", len(anonArtists.Artists))
	}
	if code := getStatus(t, anon, "/api/artists/"+artistID); code != http.StatusOK {
		t.Fatalf("after publish, anon artist page = %d, want 200", code)
	}
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
