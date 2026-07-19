package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/trick77/music/internal/config"
	"github.com/trick77/music/internal/metadata"
)

// sameAlbumMP3 builds a distinct MP3 (unique content hash) that shares one
// artist+album, by stamping the committed sample fixture with a given title.
func sameAlbumMP3(t *testing.T, title string) []byte {
	t.Helper()
	src, err := os.ReadFile("../metadata/testdata/sample.mp3")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	path := filepath.Join(t.TempDir(), title+".mp3")
	if err := os.WriteFile(path, src, 0o644); err != nil {
		t.Fatalf("write temp: %v", err)
	}
	if err := metadata.WriteTags(path, metadata.WriteableTags{
		Title: title, Artist: "Group Artist", Album: "Group Album",
	}); err != nil {
		t.Fatalf("WriteTags: %v", err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read stamped: %v", err)
	}
	return b
}

// TestUpload_serializesTrackTotalAndNumbersGroup exercises the assembled HTTP path:
// two distinct files sharing an artist+album, uploaded through the real mux, must
// come back numbered "N of Y" with trackTotal serialized in the JSON — the second
// upload bumping the group's total to 2 and the list reflecting it.
func TestUpload_serializesTrackTotalAndNumbersGroup(t *testing.T) {
	h := testServer(t, config.AuthModeDev)

	first := uploadBytes(t, h, "first.mp3", sameAlbumMP3(t, "First"))
	if first.Code != http.StatusCreated {
		t.Fatalf("first upload = %d, body=%s", first.Code, first.Body.String())
	}
	var one struct {
		TrackNo    int `json:"trackNo"`
		TrackTotal int `json:"trackTotal"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &one); err != nil {
		t.Fatalf("decode first: %v", err)
	}
	if one.TrackNo != 1 || one.TrackTotal != 1 {
		t.Fatalf("first song = %d of %d, want 1 of 1", one.TrackNo, one.TrackTotal)
	}

	second := uploadBytes(t, h, "second.mp3", sameAlbumMP3(t, "Second"))
	if second.Code != http.StatusCreated {
		t.Fatalf("second upload = %d, body=%s", second.Code, second.Body.String())
	}
	var two struct {
		TrackNo    int `json:"trackNo"`
		TrackTotal int `json:"trackTotal"`
	}
	if err := json.Unmarshal(second.Body.Bytes(), &two); err != nil {
		t.Fatalf("decode second: %v", err)
	}
	if two.TrackNo != 2 || two.TrackTotal != 2 {
		t.Fatalf("second song = %d of %d, want 2 of 2", two.TrackNo, two.TrackTotal)
	}

	// The list endpoint reflects the bumped total on every group member.
	lr := httptest.NewRecorder()
	h.ServeHTTP(lr, httptest.NewRequest("GET", "/api/songs", nil))
	var list struct {
		Songs []struct {
			Album      string `json:"album"`
			TrackTotal int    `json:"trackTotal"`
		} `json:"songs"`
	}
	if err := json.Unmarshal(lr.Body.Bytes(), &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(list.Songs) != 2 {
		t.Fatalf("list has %d songs, want 2", len(list.Songs))
	}
	for _, s := range list.Songs {
		if s.Album == "Group Album" && s.TrackTotal != 2 {
			t.Fatalf("group member trackTotal = %d, want 2", s.TrackTotal)
		}
	}
}
