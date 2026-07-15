package httpapi

import (
	"bytes"
	"encoding/json"
	"image"
	"image/jpeg"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/metadata"
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

// mp3WithTags copies the sample fixture, sets title/artist/album, and embeds the
// given cover bytes/MIME as its front cover, returning the resulting file bytes.
func mp3WithTags(t *testing.T, title, artist, album string, cover []byte, mime string) []byte {
	t.Helper()
	dst := t.TempDir() + "/tagged.mp3"
	if err := metadata.StampTags("../metadata/testdata/sample.mp3", dst, metadata.WriteableTags{
		Title: title, Artist: artist, Album: album,
		CoverBytes: cover, CoverMIME: mime,
	}); err != nil {
		t.Fatalf("StampTags: %v", err)
	}
	data, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("read stamped: %v", err)
	}
	return data
}

// jpegBytes encodes a solid NxN JPEG so each call with a distinct size yields
// distinct bytes (and thus a distinct content hash / cover).
func jpegBytes(t *testing.T, size int) []byte {
	t.Helper()
	var img bytes.Buffer
	if err := jpeg.Encode(&img, image.NewRGBA(image.Rect(0, 0, size, size)), nil); err != nil {
		t.Fatalf("encode cover: %v", err)
	}
	return img.Bytes()
}

// mp3WithCover copies the sample fixture and embeds a real JPEG as its front
// cover, returning the resulting bytes — a file that carries embedded art.
func mp3WithCover(t *testing.T) []byte {
	t.Helper()
	return mp3WithTags(t, "Cover Song", "Artist", "Album", jpegBytes(t, 240), "image/jpeg")
}

func coverArtIDOf(t *testing.T, rr *httptest.ResponseRecorder) string {
	t.Helper()
	var song struct {
		CoverArtID string `json:"coverArtId"`
	}
	json.Unmarshal(rr.Body.Bytes(), &song)
	return song.CoverArtID
}

func TestUpload_importsEmbeddedCover(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	up := uploadBytes(t, h, "withcover.mp3", mp3WithCover(t))
	if up.Code != http.StatusCreated {
		t.Fatalf("upload = %d, body=%s", up.Code, up.Body.String())
	}
	var song struct {
		CoverArtID string `json:"coverArtId"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)
	if song.CoverArtID == "" {
		t.Fatal("embedded cover was not imported on upload")
	}
	// The imported cover serves as an image.
	cr := httptest.NewRecorder()
	h.ServeHTTP(cr, httptest.NewRequest("GET", "/api/cover/"+song.CoverArtID, nil))
	if cr.Code != http.StatusOK {
		t.Fatalf("GET imported cover = %d", cr.Code)
	}
}

// A second track of an album must NOT flip the album's existing cover to its own
// embedded art: Create inherits the album cover, so import is skipped.
func TestUpload_embeddedCoverDoesNotClobberAlbumCover(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	first := coverArtIDOf(t, uploadBytes(t, h, "a.mp3",
		mp3WithTags(t, "A", "Band", "Shared", jpegBytes(t, 200), "image/jpeg")))
	if first == "" {
		t.Fatal("first track did not import its embedded cover")
	}

	// Second track, same artist+album, DIFFERENT embedded art (larger => distinct bytes).
	up := uploadBytes(t, h, "b.mp3",
		mp3WithTags(t, "B", "Band", "Shared", jpegBytes(t, 260), "image/jpeg"))
	if up.Code != http.StatusCreated {
		t.Fatalf("second upload = %d, body=%s", up.Code, up.Body.String())
	}
	if got := coverArtIDOf(t, up); got != first {
		t.Fatalf("second track cover = %q, want unchanged album cover %q", got, first)
	}
}

// An embedded picture the image probe cannot read (e.g. a GIF APIC) must not fail
// the upload — it lands coverless with a 201.
func TestUpload_unprobeableEmbeddedCoverIsNonFatal(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	// GIF magic + junk: valid enough for ID3 APIC storage, rejected by imageutil.Probe
	// (JPEG/PNG only).
	gif := append([]byte("GIF89a"), bytes.Repeat([]byte{0x00, 0x01}, 32)...)
	up := uploadBytes(t, h, "gifcover.mp3",
		mp3WithTags(t, "G", "Band", "GifAlbum", gif, "image/gif"))
	if up.Code != http.StatusCreated {
		t.Fatalf("upload = %d, body=%s", up.Code, up.Body.String())
	}
	if got := coverArtIDOf(t, up); got != "" {
		t.Fatalf("coverArtId = %q, want empty (unprobeable art skipped)", got)
	}
}

func TestDownloadCover_servesAttachmentNamedAfterSong(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	// The fixture's embedded art is a JPEG, so the download must come back .jpg —
	// the extension follows the stored file, not a guess.
	up := uploadBytes(t, h, "withcover.mp3", mp3WithTags(t, "Cover Song", "The Band", "Album", jpegBytes(t, 240), "image/jpeg"))
	if up.Code != http.StatusCreated {
		t.Fatalf("upload = %d, body=%s", up.Code, up.Body.String())
	}
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/songs/"+song.ID+"/cover/download", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("GET cover download = %d, body=%s", rr.Code, rr.Body.String())
	}
	if got, want := rr.Header().Get("Content-Disposition"), `attachment; filename="The Band - Cover Song.jpg"`; got != want {
		t.Fatalf("Content-Disposition = %q, want %q", got, want)
	}
	if ct := rr.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("cover download content-type = %q", ct)
	}
	if _, _, err := image.Decode(bytes.NewReader(rr.Body.Bytes())); err != nil {
		t.Fatalf("downloaded cover did not decode: %v", err)
	}
}

// A song with no cover has nothing to attach — 404 rather than an empty file.
func TestDownloadCover_noCover404(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	up := uploadFixture(t, h)
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)
	if got := coverArtIDOf(t, up); got != "" {
		t.Fatalf("fixture unexpectedly has a cover (%q); this test needs a coverless song", got)
	}

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/songs/"+song.ID+"/cover/download", nil))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("cover download without cover = %d, want 404", rr.Code)
	}
}

// Cover-art download is signed-in only — anonymous callers are refused even once
// the song is published, unlike the inline GET /api/cover/{id} view.
func TestDownloadCover_anonymousForbidden(t *testing.T) {
	dev, anon := devAndAnon(t)
	up := uploadBytes(t, dev, "withcover.mp3", mp3WithCover(t))
	if up.Code != http.StatusCreated {
		t.Fatalf("upload = %d, body=%s", up.Code, up.Body.String())
	}
	var song struct {
		ID         string `json:"id"`
		CoverArtID string `json:"coverArtId"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)

	if code := getStatus(t, anon, "/api/songs/"+song.ID+"/cover/download"); code != http.StatusForbidden {
		t.Fatalf("anonymous cover download = %d, want 403", code)
	}
	// The signed-in user can fetch it.
	if code := getStatus(t, dev, "/api/songs/"+song.ID+"/cover/download"); code != http.StatusOK {
		t.Fatalf("dev cover download = %d, want 200", code)
	}
	// Publishing does not open the download up.
	if rr := doJSON(t, dev, "POST", "/api/songs/"+song.ID+"/publish", ""); rr.Code != http.StatusOK {
		t.Fatalf("publish = %d", rr.Code)
	}
	if code := getStatus(t, anon, "/api/songs/"+song.ID+"/cover/download"); code != http.StatusForbidden {
		t.Fatalf("anonymous cover download of published song = %d, want 403", code)
	}
	// The art is still viewable inline for anonymous listeners.
	if code := getStatus(t, anon, "/api/cover/"+song.CoverArtID); code != http.StatusOK {
		t.Fatalf("anonymous inline cover view = %d, want 200", code)
	}
}

func TestDeleteCover_clears(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	up := uploadFixture(t, h)
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)
	uploadCover(t, h, song.ID)

	dr := httptest.NewRecorder()
	h.ServeHTTP(dr, httptest.NewRequest("DELETE", "/api/songs/"+song.ID+"/cover", nil))
	if dr.Code != http.StatusOK {
		t.Fatalf("DELETE cover = %d, body=%s", dr.Code, dr.Body.String())
	}
	var updated struct {
		CoverArtID string `json:"coverArtId"`
	}
	json.Unmarshal(dr.Body.Bytes(), &updated)
	if updated.CoverArtID != "" {
		t.Fatalf("coverArtId = %q after delete, want cleared", updated.CoverArtID)
	}
}

func TestDeleteCover_anonymousForbidden(t *testing.T) {
	h := testServer(t, config.AuthModeOIDC)
	dr := httptest.NewRecorder()
	h.ServeHTTP(dr, httptest.NewRequest("DELETE", "/api/songs/any/cover", nil))
	if dr.Code != http.StatusForbidden {
		t.Fatalf("anonymous cover DELETE = %d, want 403", dr.Code)
	}
}
