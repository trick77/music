package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/trick77/music/internal/config"
)

func TestHome_shapeAndNonNilSlices(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/home", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rr.Code, rr.Body.String())
	}
	var body struct {
		Hero          *struct{} `json:"hero"`
		TopTen        []any     `json:"topTen"`
		RecentlyAdded []any     `json:"recentlyAdded"`
		Genres        []any     `json:"genres"`
		Playlists     []any     `json:"playlists"`
	}
	raw := rr.Body.String()
	if err := json.Unmarshal([]byte(raw), &body); err != nil {
		t.Fatalf("decode: %v (%s)", err, raw)
	}
	if body.TopTen == nil || body.RecentlyAdded == nil || body.Genres == nil || body.Playlists == nil {
		t.Fatalf("slices must serialize as [] not null: %s", raw)
	}
}

func TestHome_noAIFieldsLeak(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	// Upload a song so the feed is non-trivial.
	uploadFixture(t, h)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest("GET", "/api/home", nil))
	body := rr.Body.String()
	for _, forbidden := range []string{"prompt", "model", "seed", "imagePath", "image_path", "\"error\""} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("home body leaks %q: %s", forbidden, body)
		}
	}
}
