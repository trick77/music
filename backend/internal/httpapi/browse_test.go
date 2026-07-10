package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trick77/music/internal/config"
)

func TestBrowseEndpoints_public(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	uploadFixture(t, h)

	ar := httptest.NewRecorder()
	h.ServeHTTP(ar, httptest.NewRequest("GET", "/api/artists", nil))
	if ar.Code != http.StatusOK {
		t.Fatalf("GET /api/artists = %d", ar.Code)
	}
	var artists struct {
		Artists []struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			SongCount int    `json:"songCount"`
		} `json:"artists"`
	}
	json.Unmarshal(ar.Body.Bytes(), &artists)
	if len(artists.Artists) != 1 || artists.Artists[0].SongCount != 1 {
		t.Fatalf("artists = %+v", artists)
	}

	gr := httptest.NewRecorder()
	h.ServeHTTP(gr, httptest.NewRequest("GET", "/api/genres", nil))
	if gr.Code != http.StatusOK {
		t.Fatalf("GET /api/genres = %d", gr.Code)
	}
}
