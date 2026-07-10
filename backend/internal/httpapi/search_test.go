package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trick77/music/internal/config"
)

func TestSearch_groupedResults(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	uploadFixture(t, h) // fixture is "Test Song" by "Test Artist"

	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/search?q=test", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var body struct {
		Top *struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		} `json:"top"`
		Songs     []any `json:"songs"`
		Artists   []any `json:"artists"`
		Genres    []any `json:"genres"`
		Playlists []any `json:"playlists"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (%s)", err, rr.Body.String())
	}
	if body.Songs == nil || body.Artists == nil || body.Genres == nil || body.Playlists == nil {
		t.Fatalf("groups must be non-nil arrays: %s", rr.Body.String())
	}
	if len(body.Songs) == 0 {
		t.Fatalf("expected the uploaded song to match 'test': %s", rr.Body.String())
	}
	if body.Top == nil {
		t.Fatalf("expected a Top result: %s", rr.Body.String())
	}
}

func TestSearch_blankQueryEmptyGroups(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/search?q=", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d", rr.Code)
	}
	var body struct {
		Top   *any  `json:"top"`
		Songs []any `json:"songs"`
	}
	json.Unmarshal(rr.Body.Bytes(), &body)
	if body.Top != nil {
		t.Errorf("blank query Top = %v, want null", body.Top)
	}
	if body.Songs == nil || len(body.Songs) != 0 {
		t.Errorf("blank query songs = %v, want []", body.Songs)
	}
}
