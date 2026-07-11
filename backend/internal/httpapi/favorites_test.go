package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/trick77/music/internal/config"
)

func favoriteIDs(t *testing.T, h http.Handler) []string {
	t.Helper()
	rr := doJSON(t, h, "GET", "/api/favorites", "")
	if rr.Code != http.StatusOK {
		t.Fatalf("GET favorites = %d, body=%s", rr.Code, rr.Body.String())
	}
	var out struct {
		IDs []string `json:"ids"`
	}
	json.Unmarshal(rr.Body.Bytes(), &out)
	return out.IDs
}

func TestFavorites_addListRemoveFlow(t *testing.T) {
	h := testServer(t, config.AuthModeDev)
	id := uploadSongID(t, h)

	if got := favoriteIDs(t, h); len(got) != 0 {
		t.Fatalf("initial favorites = %v, want empty", got)
	}

	if rr := doJSON(t, h, "PUT", "/api/favorites/"+id, ""); rr.Code != http.StatusNoContent {
		t.Fatalf("PUT favorite = %d, body=%s", rr.Code, rr.Body.String())
	}
	got := favoriteIDs(t, h)
	if len(got) != 1 || got[0] != id {
		t.Fatalf("after add = %v, want [%s]", got, id)
	}

	// Re-favoriting is idempotent.
	if rr := doJSON(t, h, "PUT", "/api/favorites/"+id, ""); rr.Code != http.StatusNoContent {
		t.Fatalf("PUT favorite (again) = %d", rr.Code)
	}
	if got := favoriteIDs(t, h); len(got) != 1 {
		t.Fatalf("re-add should be a no-op, got %v", got)
	}

	if rr := doJSON(t, h, "DELETE", "/api/favorites/"+id, ""); rr.Code != http.StatusNoContent {
		t.Fatalf("DELETE favorite = %d, body=%s", rr.Code, rr.Body.String())
	}
	if got := favoriteIDs(t, h); len(got) != 0 {
		t.Fatalf("after remove = %v, want empty", got)
	}
}

func TestFavorites_anonymousForbidden(t *testing.T) {
	anon := testServer(t, config.AuthModeOIDC) // no session cookie → unauthenticated
	for _, tc := range []struct{ method, path string }{
		{"GET", "/api/favorites"},
		{"PUT", "/api/favorites/some-id"},
		{"DELETE", "/api/favorites/some-id"},
	} {
		rr := doJSON(t, anon, tc.method, tc.path, "")
		if rr.Code != http.StatusForbidden {
			t.Fatalf("%s %s = %d, want 403", tc.method, tc.path, rr.Code)
		}
	}
}
