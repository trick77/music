package httpapi

import (
	"bytes"
	"encoding/json"
	"image"
	"image/jpeg"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trick77/music/internal/config"
)

func uploadCover(t *testing.T, h http.Handler, songID string) *httptest.ResponseRecorder {
	t.Helper()
	var img bytes.Buffer
	jpeg.Encode(&img, image.NewRGBA(image.Rect(0, 0, 300, 300)), nil)
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "cover.jpg")
	fw.Write(img.Bytes())
	mw.Close()
	req := httptest.NewRequest("PUT", "/api/songs/"+songID+"/cover", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestPutCover_setsAndServes(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	up := uploadFixture(t, h)
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)

	rr := uploadCover(t, h, song.ID)
	if rr.Code != http.StatusOK {
		t.Fatalf("PUT cover = %d, body=%s", rr.Code, rr.Body.String())
	}
	var updated struct {
		CoverArtID string `json:"coverArtId"`
	}
	json.Unmarshal(rr.Body.Bytes(), &updated)
	if updated.CoverArtID == "" {
		t.Fatal("song has no coverArtId after upload")
	}

	// Served publicly with an image content-type.
	cr := httptest.NewRecorder()
	h.ServeHTTP(cr, httptest.NewRequest("GET", "/api/cover/"+updated.CoverArtID, nil))
	if cr.Code != http.StatusOK {
		t.Fatalf("GET cover = %d", cr.Code)
	}
	if ct := cr.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("cover content-type = %q", ct)
	}
}

func TestGetCover_sizedVariant(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	up := uploadFixture(t, h)
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)
	uploadCover(t, h, song.ID)
	var updated struct {
		CoverArtID string `json:"coverArtId"`
	}
	// Re-fetch the song to learn its cover id.
	sr := httptest.NewRecorder()
	h.ServeHTTP(sr, httptest.NewRequest("GET", "/api/songs/"+song.ID, nil))
	json.Unmarshal(sr.Body.Bytes(), &updated)

	// A sized request returns a scaled JPEG variant, bounded to the card size.
	cr := httptest.NewRecorder()
	h.ServeHTTP(cr, httptest.NewRequest("GET", "/api/cover/"+updated.CoverArtID+"?size=card", nil))
	if cr.Code != http.StatusOK {
		t.Fatalf("GET sized cover = %d", cr.Code)
	}
	if ct := cr.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("sized cover content-type = %q", ct)
	}
	img, _, err := image.Decode(bytes.NewReader(cr.Body.Bytes()))
	if err != nil {
		t.Fatalf("decode sized cover: %v", err)
	}
	// Original is 300x300; card bound is 480, so it stays within bounds.
	if b := img.Bounds(); b.Dx() > 480 || b.Dy() > 480 {
		t.Fatalf("sized cover = %dx%d, want <= 480 on the long side", b.Dx(), b.Dy())
	}
}

func TestPutCover_anonymousForbidden(t *testing.T) {
	h := testServer(t, config.AuthModeOIDC)
	rr := uploadCover(t, h, "any")
	if rr.Code != http.StatusForbidden {
		t.Fatalf("anonymous cover PUT = %d, want 403", rr.Code)
	}
}
