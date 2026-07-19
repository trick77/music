package httpapi

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/store"
)

func testServer(t *testing.T, mode config.AuthMode) http.Handler {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	cfg := config.Config{
		AuthMode:    mode,
		DevUser:     config.DevUserConfig{Username: "dev"},
		MediaDir:    t.TempDir(),
		MaxUploadMB: 50,
	}
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	h := New(cfg, st, spa)
	// Drain the startup backfill goroutine before the temp dirs are removed;
	// registered last so it runs first (LIFO), ahead of st.Close and RemoveAll.
	if s, ok := h.(*server); ok {
		t.Cleanup(s.Wait)
	}
	return h
}

func uploadFixture(t *testing.T, h http.Handler) *httptest.ResponseRecorder {
	t.Helper()
	data, err := os.ReadFile("../metadata/testdata/sample.mp3")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", "sample.mp3")
	fw.Write(data)
	mw.Close()
	req := httptest.NewRequest("POST", "/api/songs", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func uploadBytes(t *testing.T, h http.Handler, filename string, data []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	fw, _ := mw.CreateFormFile("file", filename)
	fw.Write(data)
	mw.Close()
	req := httptest.NewRequest("POST", "/api/songs", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

// A file that isn't a clean, tag-parseable MP3 (upload validation is loose) must
// still download — the tag-stamping step must never turn a download into a 500.
func TestDownload_nonParseableFileStillServes(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	junk := bytes.Repeat([]byte("not really an mp3\x00\xff"), 64)
	up := uploadBytes(t, h, "junk.mp3", junk)
	if up.Code != http.StatusCreated {
		t.Fatalf("upload = %d, body=%s", up.Code, up.Body.String())
	}
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/songs/"+song.ID+"/download", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("download of non-parseable file = %d, want 200", rr.Code)
	}
	if len(rr.Body.Bytes()) == 0 {
		t.Fatal("download returned empty body")
	}
}

func TestUpload_devParsesTagsAndLists(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	rr := uploadFixture(t, h)
	if rr.Code != http.StatusCreated {
		t.Fatalf("upload status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var song struct {
		ID         string   `json:"id"`
		Title      string   `json:"title"`
		ArtistName string   `json:"artistName"`
		Genres     []string `json:"genres"`
		DurationMS int64    `json:"durationMs"`
	}
	json.Unmarshal(rr.Body.Bytes(), &song)
	if song.Title != "Test Song" || song.ArtistName != "Test Artist" {
		t.Fatalf("parsed song = %+v", song)
	}
	if len(song.Genres) != 2 {
		t.Fatalf("genres = %v, want 2", song.Genres)
	}
	if song.DurationMS < 1850 || song.DurationMS > 2150 {
		t.Fatalf("duration = %d, want ~2000", song.DurationMS)
	}

	// List reflects it.
	lr := httptest.NewRecorder()
	h.ServeHTTP(lr, httptest.NewRequest("GET", "/api/songs", nil))
	var list struct {
		Songs []struct {
			ID string `json:"id"`
		} `json:"songs"`
	}
	json.Unmarshal(lr.Body.Bytes(), &list)
	if len(list.Songs) != 1 || list.Songs[0].ID != song.ID {
		t.Fatalf("list = %+v", list)
	}
}

func TestUpload_dedupeReturnsExisting(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	first := uploadFixture(t, h)
	if first.Code != http.StatusCreated {
		t.Fatalf("first upload = %d", first.Code)
	}
	second := uploadFixture(t, h)
	if second.Code != http.StatusOK {
		t.Fatalf("dedupe upload status = %d, want 200", second.Code)
	}
	// Only one song stored.
	lr := httptest.NewRecorder()
	h.ServeHTTP(lr, httptest.NewRequest("GET", "/api/songs", nil))
	var list struct {
		Songs []json.RawMessage `json:"songs"`
	}
	json.Unmarshal(lr.Body.Bytes(), &list)
	if len(list.Songs) != 1 {
		t.Fatalf("stored %d songs, want 1 (dedupe)", len(list.Songs))
	}
}

func TestUpload_anonymousForbidden(t *testing.T) {
	h := testServer(t, config.AuthModeOIDC) // oidc + no session ⇒ anonymous
	rr := uploadFixture(t, h)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("anonymous upload status = %d, want 403", rr.Code)
	}
}

func TestStream_supportsRange(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	up := uploadFixture(t, h)
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)

	req := httptest.NewRequest("GET", "/api/songs/"+song.ID+"/stream", nil)
	req.Header.Set("Range", "bytes=0-99")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusPartialContent {
		t.Fatalf("range stream status = %d, want 206", rr.Code)
	}
	if ct := rr.Header().Get("Content-Type"); ct != "audio/mpeg" {
		t.Fatalf("Content-Type = %q, want audio/mpeg", ct)
	}
	if rr.Header().Get("Content-Range") == "" {
		t.Fatal("missing Content-Range header on 206")
	}
	if n := len(rr.Body.Bytes()); n != 100 {
		t.Fatalf("range body = %d bytes, want 100", n)
	}
}

func TestDownload_setsAttachment(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	up := uploadFixture(t, h)
	var song struct {
		ID string `json:"id"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/songs/"+song.ID+"/download", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("download status = %d", rr.Code)
	}
	if cd := rr.Header().Get("Content-Disposition"); !bytes.Contains([]byte(cd), []byte("attachment")) {
		t.Fatalf("Content-Disposition = %q, want attachment", cd)
	}
	if _, err := io.ReadAll(rr.Body); err != nil {
		t.Fatalf("read body: %v", err)
	}
}
