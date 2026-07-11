package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/trick77/music/internal/library"
)

func mkAlbumSong(t *testing.T, repo *library.Repo, title, album, hash, path string) *library.Song {
	t.Helper()
	s, err := repo.Create(context.Background(), library.NewID(), library.CreateSongParams{
		Title: title, ArtistName: "The Artist", Album: album,
		FilePath: path, ContentHash: hash, Genres: []string{"Synthwave"},
	})
	if err != nil {
		t.Fatalf("create song %s: %v", title, err)
	}
	return s
}

// TestAlbumCover_generateThenApply exercises the full new path over HTTP: generate
// a cover (studio off, image gen on — proving the gating fix), then apply it to a
// library album and confirm every song of that album adopts it and /api/albums
// reflects the cover.
func TestAlbumCover_generateThenApply(t *testing.T) {
	ts := newStudioCoverServer(t, okProvider(t), false) // image gen on, studio(Tavily) off
	ctx := context.Background()
	a := mkAlbumSong(t, ts.repo, "One", "Neon Nights", "h1", "songs/a.mp3")
	b := mkAlbumSong(t, ts.repo, "Two", "Neon Nights", "h2", "songs/b.mp3")
	other := mkAlbumSong(t, ts.repo, "Three", "Other", "h3", "songs/c.mp3")

	// Generate a cover.
	rec := ts.postCover(t, ts.dev, map[string]any{"prompt": "a neon skyline", "model": "flux-2-pro"})
	if rec.Code != http.StatusOK {
		t.Fatalf("generate code = %d, body %s", rec.Code, rec.Body)
	}
	var gen struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &gen); err != nil || gen.ID == "" {
		t.Fatalf("bad generate response %s (%v)", rec.Body, err)
	}

	// Apply it to the album.
	apply := postJSON(t, ts.dev, "/api/albums/cover", map[string]any{
		"artistId": a.ArtistID, "album": "neon nights", "studioCoverArtId": gen.ID,
	})
	if apply.Code != http.StatusOK {
		t.Fatalf("apply code = %d, body %s", apply.Code, apply.Body)
	}
	var applied struct {
		CoverArtID string `json:"coverArtId"`
	}
	if err := json.Unmarshal(apply.Body.Bytes(), &applied); err != nil || applied.CoverArtID == "" {
		t.Fatalf("bad apply response %s (%v)", apply.Body, err)
	}

	// Both album songs adopt the cover; the other album does not.
	for _, id := range []string{a.ID, b.ID} {
		got, _ := ts.repo.Get(ctx, id)
		if got.CoverArtID != applied.CoverArtID {
			t.Fatalf("song %s cover = %q, want %q", id, got.CoverArtID, applied.CoverArtID)
		}
	}
	if got, _ := ts.repo.Get(ctx, other.ID); got.CoverArtID != "" {
		t.Fatalf("other album wrongly covered: %q", got.CoverArtID)
	}

	// /api/albums lists the album with the cover flag set.
	list := httptest.NewRecorder()
	ts.dev.ServeHTTP(list, httptest.NewRequest("GET", "/api/albums", nil))
	if list.Code != http.StatusOK {
		t.Fatalf("list albums code = %d", list.Code)
	}
	var lresp struct {
		Albums []library.AlbumSummary `json:"albums"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &lresp); err != nil {
		t.Fatalf("decode albums: %v", err)
	}
	var found bool
	for _, al := range lresp.Albums {
		if al.Album == "Neon Nights" {
			found = true
			if !al.HasCover || al.SongCount != 2 {
				t.Fatalf("Neon Nights summary wrong: %+v", al)
			}
		}
	}
	if !found {
		t.Fatalf("Neon Nights not listed: %+v", lresp.Albums)
	}
}

func TestAlbumCover_rejectsUnknownAlbum(t *testing.T) {
	ts := newStudioCoverServer(t, okProvider(t), false)
	rec := ts.postCover(t, ts.dev, map[string]any{"prompt": "x", "model": "flux-2-pro"})
	var gen struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &gen)
	apply := postJSON(t, ts.dev, "/api/albums/cover", map[string]any{
		"artistId": "no-such-artist", "album": "Ghost", "studioCoverArtId": gen.ID,
	})
	if apply.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404", apply.Code)
	}
}

func TestAlbumCover_anonymousForbidden(t *testing.T) {
	ts := newStudioCoverServer(t, okProvider(t), false)
	apply := postJSON(t, ts.anon, "/api/albums/cover", map[string]any{
		"artistId": "a", "album": "b", "studioCoverArtId": "c",
	})
	if apply.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403", apply.Code)
	}
}

func postJSON(t *testing.T, h http.Handler, path string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}
