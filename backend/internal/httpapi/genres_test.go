package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func (ts *fanartTS) patchGenreJSON(t *testing.T, id string, body map[string]any, authed bool) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest("PATCH", "/api/genres/"+id, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	ts.handler(authed).ServeHTTP(rr, req)
	return rr
}

func TestPatchGenre_setBackgroundSamplesAccent(t *testing.T) {
	ts := newFanartTestServer(t)
	genreID := ts.seedGenre(t, "Jazz")
	// Upload a solid-red image so the sampled accent is predictable.
	up := ts.uploadFanart(t, "genre", genreID, solidPngBytes(t, 16, 16, 220, 30, 30))
	fanartID := ts.idFromResponse(t, up)
	rec := ts.patchGenreJSON(t, genreID, map[string]any{"backgroundFanartId": fanartID}, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("code = %d body %s", rec.Code, rec.Body)
	}
	var out struct {
		Genre struct {
			AccentColor string `json:"accentColor"`
		} `json:"genre"`
		BackgroundID string `json:"backgroundId"`
	}
	json.Unmarshal(rec.Body.Bytes(), &out)
	if out.BackgroundID != fanartID {
		t.Fatalf("backgroundId = %q", out.BackgroundID)
	}
	if out.Genre.AccentColor == "" || out.Genre.AccentColor[0] != '#' {
		t.Fatalf("accent not sampled: %q", out.Genre.AccentColor)
	}
}

func TestPatchGenre_renameAndForeignBackgroundRejected(t *testing.T) {
	ts := newFanartTestServer(t)
	g1 := ts.seedGenre(t, "Jazz")
	g2 := ts.seedGenre(t, "Rock")
	up := ts.uploadFanart(t, "genre", g1, pngBytes(t, 8, 8))
	fanartID := ts.idFromResponse(t, up)
	// Rename.
	if rec := ts.patchGenreJSON(t, g1, map[string]any{"name": "Smooth Jazz"}, true); rec.Code != http.StatusOK {
		t.Fatalf("rename code = %d", rec.Code)
	}
	// Assign g1's image as g2's background -> 400.
	if rec := ts.patchGenreJSON(t, g2, map[string]any{"backgroundFanartId": fanartID}, true); rec.Code != http.StatusBadRequest {
		t.Fatalf("foreign background code = %d, want 400", rec.Code)
	}
}

func TestPatchGenre_anonymousForbidden(t *testing.T) {
	ts := newFanartTestServerAnon(t)
	rec := ts.patchGenreJSON(t, ts.seedGenre(t, "Jazz"), map[string]any{"name": "X"}, false)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", rec.Code)
	}
}
