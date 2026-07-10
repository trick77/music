package httpapi

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trick77/music/internal/config"
)

func pngMultipart(t *testing.T) (*bytes.Buffer, string) {
	t.Helper()
	var img bytes.Buffer
	if err := png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 8, 8))); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "cover.png")
	fw.Write(img.Bytes())
	mw.Close()
	return &body, mw.FormDataContentType()
}

func doJSON(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	var rdr *bytes.Buffer
	if body != "" {
		rdr = bytes.NewBufferString(body)
	} else {
		rdr = bytes.NewBuffer(nil)
	}
	req := httptest.NewRequest(method, path, rdr)
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

// uploadSongID uploads the fixture and returns the created song id.
func uploadSongID(t *testing.T, h http.Handler) string {
	t.Helper()
	rr := uploadFixture(t, h)
	if rr.Code != http.StatusCreated && rr.Code != http.StatusOK {
		t.Fatalf("upload status = %d, body=%s", rr.Code, rr.Body.String())
	}
	var s struct {
		ID string `json:"id"`
	}
	json.Unmarshal(rr.Body.Bytes(), &s)
	return s.ID
}

func createPlaylist(t *testing.T, h http.Handler, name, desc string) string {
	t.Helper()
	rr := doJSON(t, h, "POST", "/api/playlists", `{"name":"`+name+`","description":"`+desc+`"}`)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create playlist = %d, body=%s", rr.Code, rr.Body.String())
	}
	var p struct {
		ID string `json:"id"`
	}
	json.Unmarshal(rr.Body.Bytes(), &p)
	return p.ID
}

func TestPlaylistCRUDFlow(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	pid := createPlaylist(t, h, "Late Night Drive", "low volume")

	// GET detail (public shape).
	rr := doJSON(t, h, "GET", "/api/playlists/"+pid, "")
	if rr.Code != http.StatusOK {
		t.Fatalf("get playlist = %d", rr.Code)
	}
	var detail struct {
		Name  string `json:"name"`
		Songs []struct {
			ID string `json:"id"`
		} `json:"songs"`
	}
	json.Unmarshal(rr.Body.Bytes(), &detail)
	if detail.Name != "Late Night Drive" || detail.Songs == nil {
		t.Fatalf("detail = %+v", detail)
	}

	// Add a song.
	sid := uploadSongID(t, h)
	ar := doJSON(t, h, "POST", "/api/playlists/"+pid+"/songs", `{"songId":"`+sid+`"}`)
	if ar.Code != http.StatusOK {
		t.Fatalf("add song = %d, body=%s", ar.Code, ar.Body.String())
	}
	var withSong struct {
		Songs []struct {
			ID string `json:"id"`
		} `json:"songs"`
	}
	json.Unmarshal(ar.Body.Bytes(), &withSong)
	if len(withSong.Songs) != 1 || withSong.Songs[0].ID != sid {
		t.Fatalf("membership after add = %+v", withSong.Songs)
	}

	// Rename via PATCH.
	pr := doJSON(t, h, "PATCH", "/api/playlists/"+pid, `{"name":"Renamed","description":"x"}`)
	if pr.Code != http.StatusOK {
		t.Fatalf("patch = %d", pr.Code)
	}

	// Remove the song.
	dr := doJSON(t, h, "DELETE", "/api/playlists/"+pid+"/songs/"+sid, "")
	if dr.Code != http.StatusOK {
		t.Fatalf("remove song = %d", dr.Code)
	}

	// Delete the playlist.
	del := doJSON(t, h, "DELETE", "/api/playlists/"+pid, "")
	if del.Code != http.StatusNoContent {
		t.Fatalf("delete = %d", del.Code)
	}
	gone := doJSON(t, h, "GET", "/api/playlists/"+pid, "")
	if gone.Code != http.StatusNotFound {
		t.Fatalf("get deleted = %d, want 404", gone.Code)
	}
}

func TestReorderEndpoint_mismatchIs400(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	pid := createPlaylist(t, h, "P", "")
	sid := uploadSongID(t, h)
	doJSON(t, h, "POST", "/api/playlists/"+pid+"/songs", `{"songId":"`+sid+`"}`)

	// Reorder with an unknown id -> 400.
	bad := doJSON(t, h, "PUT", "/api/playlists/"+pid+"/reorder", `{"songIds":["ghost"]}`)
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("mismatch reorder = %d, want 400", bad.Code)
	}
	// Reorder with the real membership -> 200.
	ok := doJSON(t, h, "PUT", "/api/playlists/"+pid+"/reorder", `{"songIds":["`+sid+`"]}`)
	if ok.Code != http.StatusOK {
		t.Fatalf("valid reorder = %d, want 200", ok.Code)
	}
}

func TestPlaylistWrites_anonymousForbidden(t *testing.T) {
	anon := testServer(t, config.AuthModeOIDC)
	for _, tc := range []struct{ method, path, body string }{
		{"POST", "/api/playlists", `{"name":"x"}`},
		{"PATCH", "/api/playlists/any", `{"name":"x"}`},
		{"DELETE", "/api/playlists/any", ""},
		{"POST", "/api/playlists/any/songs", `{"songId":"s"}`},
		{"DELETE", "/api/playlists/any/songs/s", ""},
		{"PUT", "/api/playlists/any/reorder", `{"songIds":[]}`},
	} {
		rr := doJSON(t, anon, tc.method, tc.path, tc.body)
		if rr.Code != http.StatusForbidden {
			t.Fatalf("%s %s = %d, want 403", tc.method, tc.path, rr.Code)
		}
	}
}

func TestPlaylistCoverUpload(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	pid := createPlaylist(t, h, "P", "")

	body, contentType := pngMultipart(t)
	req := httptest.NewRequest("PUT", "/api/playlists/"+pid+"/cover", body)
	req.Header.Set("Content-Type", contentType)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("cover upload = %d, body=%s", rr.Code, rr.Body.String())
	}
	var detail struct {
		CoverArtID string `json:"coverArtId"`
	}
	json.Unmarshal(rr.Body.Bytes(), &detail)
	if detail.CoverArtID == "" {
		t.Fatalf("playlist cover not set: %s", rr.Body.String())
	}

	cr := doJSON(t, h, "GET", "/api/cover/"+detail.CoverArtID, "")
	if cr.Code != http.StatusOK {
		t.Fatalf("get cover = %d", cr.Code)
	}
}

func TestPlaylistCoverUpload_anonymousForbidden(t *testing.T) {
	anon := testServer(t, config.AuthModeOIDC)
	body, contentType := pngMultipart(t)
	req := httptest.NewRequest("PUT", "/api/playlists/any/cover", body)
	req.Header.Set("Content-Type", contentType)
	rr := httptest.NewRecorder()
	anon.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("anonymous cover upload = %d, want 403", rr.Code)
	}
}

func TestPlaylistReads_anonymousOK(t *testing.T) {
	anon := testServer(t, config.AuthModeOIDC)
	rr := doJSON(t, anon, "GET", "/api/playlists", "")
	if rr.Code != http.StatusOK {
		t.Fatalf("anonymous list playlists = %d, want 200", rr.Code)
	}
	var body struct {
		Playlists []any `json:"playlists"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Playlists == nil {
		t.Fatalf("playlists must be [] not null")
	}
}
