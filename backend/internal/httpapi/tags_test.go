package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trick77/music/internal/config"
)

func patch(t *testing.T, h http.Handler, id string, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("PATCH", "/api/songs/"+id, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestPatchSong_editReflectedInDownload(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	up := uploadFixture(t, h)
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)

	rr := patch(t, h, song.ID, `{"title":"Renamed","artistName":"Test Artist","album":"Test Album","year":2020,"trackNo":3,"genres":["Ambient"]}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d, body=%s", rr.Code, rr.Body.String())
	}
	var updated struct {
		Title  string   `json:"title"`
		Genres []string `json:"genres"`
	}
	json.Unmarshal(rr.Body.Bytes(), &updated)
	if updated.Title != "Renamed" || len(updated.Genres) != 1 || updated.Genres[0] != "Ambient" {
		t.Fatalf("edit not reflected: %+v", updated)
	}

	// The DB is authoritative and the stored file is not rewritten on edit; the
	// current tags are stamped into the bytes at download time. Download and
	// confirm the edited ID3 title is present in the served copy.
	dl := httptest.NewRecorder()
	h.ServeHTTP(dl, httptest.NewRequest("GET", "/api/songs/"+song.ID+"/download", nil))
	if !bytes.Contains(dl.Body.Bytes(), []byte("Renamed")) {
		t.Fatal("edited title not found in downloaded file bytes")
	}
}

func TestPatchSong_lyricsSavedAndEmbeddedInDownload(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	up := uploadFixture(t, h)
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)

	// PATCH with lyrics: the JSON key contract (editSongRequest.lyrics) must reach
	// the DB and come back in the response.
	rr := patch(t, h, song.ID, `{"title":"T","artistName":"Test Artist","genres":[],"lyrics":"Sunlight on the wire"}`)
	if rr.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d, body=%s", rr.Code, rr.Body.String())
	}
	var updated struct {
		Lyrics string `json:"lyrics"`
	}
	json.Unmarshal(rr.Body.Bytes(), &updated)
	if updated.Lyrics != "Sunlight on the wire" {
		t.Fatalf("lyrics not returned by PATCH: %q", updated.Lyrics)
	}

	// Lyrics are stamped into the USLT frame at download time (songTags -> WriteTags).
	dl := httptest.NewRecorder()
	h.ServeHTTP(dl, httptest.NewRequest("GET", "/api/songs/"+song.ID+"/download", nil))
	if !bytes.Contains(dl.Body.Bytes(), []byte("Sunlight on the wire")) {
		t.Fatal("lyrics not embedded in downloaded file bytes")
	}

	// Clearing lyrics must drop them from the download, not leave them baked in.
	if c := patch(t, h, song.ID, `{"title":"T","artistName":"Test Artist","genres":[],"lyrics":""}`); c.Code != http.StatusOK {
		t.Fatalf("PATCH clear status = %d", c.Code)
	}
	dl2 := httptest.NewRecorder()
	h.ServeHTTP(dl2, httptest.NewRequest("GET", "/api/songs/"+song.ID+"/download", nil))
	if bytes.Contains(dl2.Body.Bytes(), []byte("Sunlight on the wire")) {
		t.Fatal("cleared lyrics still present in downloaded file bytes")
	}
}

func TestPatchSong_anonymousForbidden(t *testing.T) {
	h := testServer(t, config.AuthModeOIDC)
	// Anonymous PATCH to any id must be rejected before touching storage.
	rr := patch(t, h, "does-not-matter", `{"title":"x","artistName":"y","genres":[]}`)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("anonymous PATCH = %d, want 403", rr.Code)
	}
}

func TestSuggest_authOnly(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	uploadFixture(t, h)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/suggest?field=artist&q=test", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("suggest status = %d", rr.Code)
	}
	var body struct {
		Suggestions []struct {
			Value string `json:"value"`
			Count int    `json:"count"`
		} `json:"suggestions"`
	}
	json.Unmarshal(rr.Body.Bytes(), &body)
	if len(body.Suggestions) != 1 || body.Suggestions[0].Value != "Test Artist" {
		t.Fatalf("suggest = %+v", body)
	}

	anon := testServer(t, config.AuthModeOIDC)
	ar := httptest.NewRecorder()
	anon.ServeHTTP(ar, httptest.NewRequest("GET", "/api/suggest?field=artist&q=test", nil))
	if ar.Code != http.StatusForbidden {
		t.Fatalf("anonymous suggest = %d, want 403", ar.Code)
	}
}
