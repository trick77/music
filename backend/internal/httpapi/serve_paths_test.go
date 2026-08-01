package httpapi

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/library"
	"github.com/trick77/music/internal/store"
)

type serveTS struct {
	dev      http.Handler
	anon     http.Handler
	repo     *library.Repo
	mediaDir string
}

// newServeServer builds an authed (dev) and anonymous (oidc) handler over one
// store and one media root, and hands back both so tests can reach past HTTP to
// stage on-disk conditions (a deleted audio file, say). maxUploadMB is passed
// through so the oversize-upload path can be exercised.
func newServeServer(t *testing.T, maxUploadMB int) *serveTS {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	mediaDir := t.TempDir()
	spa := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("SPA")) })
	mk := func(mode config.AuthMode) http.Handler {
		cfg := config.Config{
			AuthMode: mode, DevUser: config.DevUserConfig{Username: "dev"},
			MediaDir: mediaDir, MaxUploadMB: maxUploadMB,
		}
		h := New(cfg, st, spa)
		if s, ok := h.(*server); ok {
			t.Cleanup(s.Wait)
		}
		return h
	}
	return &serveTS{dev: mk(config.AuthModeDev), anon: mk(config.AuthModeOIDC), repo: library.NewRepo(st.DB()), mediaDir: mediaDir}
}

func getRec(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", path, nil))
	return rr
}

// --- serveFile: publish gating ---

// An unpublished song is invisible to anonymous callers on every read route,
// even by direct id; publishing flips all of them on at once.
func TestSongReads_unpublishedHiddenFromAnonymous(t *testing.T) {
	ts := newServeServer(t, 50)
	sid := uploadSongID(t, ts.dev)

	routes := []string{"/api/songs/" + sid, "/api/songs/" + sid + "/stream", "/api/songs/" + sid + "/download"}
	for _, p := range routes {
		if rr := getRec(t, ts.anon, p); rr.Code != http.StatusNotFound {
			t.Fatalf("anonymous %s (unpublished) = %d, want 404", p, rr.Code)
		}
	}

	pub := postJSON(t, ts.dev, "/api/songs/"+sid+"/publish", nil)
	if pub.Code != http.StatusOK {
		t.Fatalf("publish = %d, body %s", pub.Code, pub.Body)
	}
	for _, p := range routes {
		if rr := getRec(t, ts.anon, p); rr.Code != http.StatusOK {
			t.Fatalf("anonymous %s (published) = %d, want 200", p, rr.Code)
		}
	}

	unpub := postJSON(t, ts.dev, "/api/songs/"+sid+"/unpublish", nil)
	if unpub.Code != http.StatusOK {
		t.Fatalf("unpublish = %d", unpub.Code)
	}
	if rr := getRec(t, ts.anon, routes[0]); rr.Code != http.StatusNotFound {
		t.Fatalf("anonymous get after unpublish = %d, want 404", rr.Code)
	}
}

func TestSongReads_unknownIDIs404(t *testing.T) {
	ts := newServeServer(t, 50)
	for _, p := range []string{
		"/api/songs/ghost", "/api/songs/ghost/stream", "/api/songs/ghost/download",
		"/api/songs/ghost/cover/download", "/api/songs/ghost/stats", "/api/cover/ghost",
	} {
		if rr := getRec(t, ts.dev, p); rr.Code != http.StatusNotFound {
			t.Fatalf("GET %s = %d, want 404", p, rr.Code)
		}
	}
}

// When the DB row survives but its audio file is gone, both flavours must 404
// rather than 500 — download falls through the stamping path to the same check.
func TestServeFile_missingAudioFileIs404(t *testing.T) {
	ts := newServeServer(t, 50)
	sid := uploadSongID(t, ts.dev)
	song, err := ts.repo.Get(t.Context(), sid)
	if err != nil || song == nil {
		t.Fatalf("get song: %v", err)
	}
	if err := os.Remove(filepath.Join(ts.mediaDir, filepath.FromSlash(song.FilePath))); err != nil {
		t.Fatalf("remove audio: %v", err)
	}
	for _, p := range []string{"/api/songs/" + sid + "/stream", "/api/songs/" + sid + "/download"} {
		if rr := getRec(t, ts.dev, p); rr.Code != http.StatusNotFound {
			t.Fatalf("GET %s with missing file = %d, want 404", p, rr.Code)
		}
	}
}

// The download bakes the DB's tags — including the mapped cover art — into a
// throwaway copy, so a covered song downloads larger than the stored file and
// the stored file itself is never mutated.
func TestDownload_stampsCoverWithoutMutatingStoredFile(t *testing.T) {
	ts := newServeServer(t, 50)
	sid := uploadSongID(t, ts.dev)
	if rr := uploadCover(t, ts.dev, sid); rr.Code != http.StatusOK {
		t.Fatalf("upload cover = %d, body %s", rr.Code, rr.Body)
	}
	song, err := ts.repo.Get(t.Context(), sid)
	if err != nil || song == nil {
		t.Fatalf("get song: %v", err)
	}
	stored, err := os.ReadFile(filepath.Join(ts.mediaDir, filepath.FromSlash(song.FilePath)))
	if err != nil {
		t.Fatalf("read stored: %v", err)
	}

	rr := getRec(t, ts.dev, "/api/songs/"+sid+"/download")
	if rr.Code != http.StatusOK {
		t.Fatalf("download = %d", rr.Code)
	}
	if rr.Body.Len() <= len(stored) {
		t.Fatalf("download %d bytes <= stored %d; cover art was not stamped in", rr.Body.Len(), len(stored))
	}
	after, err := os.ReadFile(filepath.Join(ts.mediaDir, filepath.FromSlash(song.FilePath)))
	if err != nil {
		t.Fatalf("re-read stored: %v", err)
	}
	if !bytes.Equal(stored, after) {
		t.Fatal("download mutated the stored file; it must only stamp a temp copy")
	}
}

// --- upload error paths ---

func TestUpload_missingFileFieldIs400(t *testing.T) {
	ts := newServeServer(t, 50)
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	mw.WriteField("notafile", "x")
	mw.Close()
	req := httptest.NewRequest("POST", "/api/songs", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rr := httptest.NewRecorder()
	ts.dev.ServeHTTP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400 (body %s)", rr.Code, rr.Body)
	}
}

func TestUpload_nonMP3Is415(t *testing.T) {
	ts := newServeServer(t, 50)
	rr := uploadBytes(t, ts.dev, "notes.txt", []byte("hello"))
	if rr.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("code = %d, want 415 (body %s)", rr.Code, rr.Body)
	}
}

// A body beyond the configured cap is refused with 413, not a truncated import.
func TestUpload_oversizeIs413(t *testing.T) {
	ts := newServeServer(t, 0) // 0 MiB cap => every upload is over the limit
	rr := uploadBytes(t, ts.dev, "song.mp3", bytes.Repeat([]byte("a"), 4096))
	if rr.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("code = %d, want 413 (body %s)", rr.Code, rr.Body)
	}
}

func TestSetPublished_gating(t *testing.T) {
	ts := newServeServer(t, 50)
	if rr := postJSON(t, ts.anon, "/api/songs/any/publish", nil); rr.Code != http.StatusForbidden {
		t.Fatalf("anonymous publish = %d, want 403", rr.Code)
	}
	if rr := postJSON(t, ts.dev, "/api/songs/ghost/publish", nil); rr.Code != http.StatusNotFound {
		t.Fatalf("publish unknown = %d, want 404", rr.Code)
	}
	if rr := postJSON(t, ts.dev, "/api/songs/ghost/unpublish", nil); rr.Code != http.StatusNotFound {
		t.Fatalf("unpublish unknown = %d, want 404", rr.Code)
	}
}

// --- cover routes ---

func TestCoverRoutes_authGatingAndNotFound(t *testing.T) {
	ts := newServeServer(t, 50)
	sid := uploadSongID(t, ts.dev)

	// Writes and the original-file download are signed-in only.
	for _, tc := range []struct{ method, path string }{
		{"DELETE", "/api/songs/" + sid + "/cover"},
		{"GET", "/api/songs/" + sid + "/cover/download"},
	} {
		rr := httptest.NewRecorder()
		ts.anon.ServeHTTP(rr, httptest.NewRequest(tc.method, tc.path, nil))
		if rr.Code != http.StatusForbidden {
			t.Fatalf("anonymous %s %s = %d, want 403", tc.method, tc.path, rr.Code)
		}
	}
	body, ct := pngMultipart(t)
	req := httptest.NewRequest("PUT", "/api/songs/"+sid+"/cover", body)
	req.Header.Set("Content-Type", ct)
	rr := httptest.NewRecorder()
	ts.anon.ServeHTTP(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("anonymous PUT cover = %d, want 403", rr.Code)
	}

	// A song with no cover has nothing to download.
	if got := getRec(t, ts.dev, "/api/songs/"+sid+"/cover/download"); got.Code != http.StatusNotFound {
		t.Fatalf("cover download without cover = %d, want 404", got.Code)
	}
}

func TestCoverDownload_thenDeleteClearsIt(t *testing.T) {
	ts := newServeServer(t, 50)
	sid := uploadSongID(t, ts.dev)
	if up := uploadCover(t, ts.dev, sid); up.Code != http.StatusOK {
		t.Fatalf("upload cover = %d", up.Code)
	}

	dl := getRec(t, ts.dev, "/api/songs/"+sid+"/cover/download")
	if dl.Code != http.StatusOK || dl.Body.Len() == 0 {
		t.Fatalf("cover download = %d, %d bytes", dl.Code, dl.Body.Len())
	}
	if cd := dl.Header().Get("Content-Disposition"); !bytes.Contains([]byte(cd), []byte("attachment")) {
		t.Fatalf("Content-Disposition = %q, want attachment", cd)
	}

	del := httptest.NewRecorder()
	ts.dev.ServeHTTP(del, httptest.NewRequest("DELETE", "/api/songs/"+sid+"/cover", nil))
	if del.Code != http.StatusOK {
		t.Fatalf("delete cover = %d, body %s", del.Code, del.Body)
	}
	var updated struct {
		CoverArtID string `json:"coverArtId"`
	}
	json.Unmarshal(del.Body.Bytes(), &updated)
	if updated.CoverArtID != "" {
		t.Fatalf("cover still set after delete: %q", updated.CoverArtID)
	}
	if again := getRec(t, ts.dev, "/api/songs/"+sid+"/cover/download"); again.Code != http.StatusNotFound {
		t.Fatalf("cover download after delete = %d, want 404", again.Code)
	}
}

// GET /api/cover/{id}?size=… serves a downscaled JPEG variant and caches it on
// the volume, so a second request is served from the cache.
func TestGetCover_sizedVariantsAreServedAndCached(t *testing.T) {
	ts := newServeServer(t, 50)
	sid := uploadSongID(t, ts.dev)
	up := uploadCover(t, ts.dev, sid)
	var song struct {
		CoverArtID string `json:"coverArtId"`
	}
	json.Unmarshal(up.Body.Bytes(), &song)
	if song.CoverArtID == "" {
		t.Fatalf("no cover id: %s", up.Body)
	}

	for _, size := range []string{"thumb", "card", "hero"} {
		first := getRec(t, ts.dev, "/api/cover/"+song.CoverArtID+"?size="+size)
		if first.Code != http.StatusOK || first.Body.Len() == 0 {
			t.Fatalf("size=%s first = %d, %d bytes", size, first.Code, first.Body.Len())
		}
		if ct := first.Header().Get("Content-Type"); ct != "image/jpeg" {
			t.Fatalf("size=%s Content-Type = %q, want image/jpeg", size, ct)
		}
		second := getRec(t, ts.dev, "/api/cover/"+song.CoverArtID+"?size="+size)
		if second.Code != http.StatusOK {
			t.Fatalf("size=%s cached = %d", size, second.Code)
		}
		if !bytes.Equal(first.Body.Bytes(), second.Body.Bytes()) {
			t.Fatalf("size=%s cached variant differs from the freshly built one", size)
		}
	}

	// An unrecognized size falls back to the original bytes, not an error.
	orig := getRec(t, ts.dev, "/api/cover/"+song.CoverArtID+"?size=gigantic")
	if orig.Code != http.StatusOK || orig.Body.Len() == 0 {
		t.Fatalf("unknown size = %d, %d bytes", orig.Code, orig.Body.Len())
	}
}

// --- /api/studio/history: reachable through the assembled server ---

// The history routes hang off songHandlers, so they answer on a plain library
// install even when Studio itself is unconfigured (no chat key, hence no
// generate). Anonymous callers are still shut out on every one of them.
func TestStudioHistoryRoutes_servedWithoutStudioConfigured(t *testing.T) {
	ts := newServeServer(t, 50)

	rr := getRec(t, ts.dev, "/api/studio/history")
	if rr.Code != http.StatusOK {
		t.Fatalf("GET history = %d, want 200 (body %s)", rr.Code, rr.Body)
	}
	var page struct {
		Runs       []library.StudioRun `json:"runs"`
		Total      int                 `json:"total"`
		NextBefore int64               `json:"nextBefore"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &page); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if page.Total != 0 || len(page.Runs) != 0 || page.NextBefore != 0 {
		t.Fatalf("empty history = %+v, want a zeroed page", page)
	}

	// Seeding through the repo makes the row visible on the very next read —
	// there is no cache in front of these routes.
	if err := ts.repo.CreateStudioRun(httptest.NewRequest("GET", "/", nil).Context(),
		library.StudioRun{ID: "r1", Reference: "Metallica, Enter Sandman",
			StylePrompt: "s", Lyrics: "l", CoverArtPrompt: "c"}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if got := getRec(t, ts.dev, "/api/studio/history/r1"); got.Code != http.StatusOK {
		t.Fatalf("GET run = %d, want 200 (body %s)", got.Code, got.Body)
	}

	for _, tc := range []struct{ method, path string }{
		{"GET", "/api/studio/history"},
		{"GET", "/api/studio/history/r1"},
		{"PATCH", "/api/studio/history/r1"},
		{"DELETE", "/api/studio/history/r1"},
	} {
		rr := httptest.NewRecorder()
		ts.anon.ServeHTTP(rr, httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`)))
		if rr.Code != http.StatusForbidden {
			t.Fatalf("anonymous %s %s = %d, want 403", tc.method, tc.path, rr.Code)
		}
	}
	// The anonymous DELETE must not have taken effect.
	if got := getRec(t, ts.dev, "/api/studio/history/r1"); got.Code != http.StatusOK {
		t.Fatalf("run gone after a rejected anonymous delete: %d", got.Code)
	}
}
