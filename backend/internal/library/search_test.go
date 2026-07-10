package library

import (
	"context"
	"testing"
)

func TestSearch_blankQueryIsEmpty(t *testing.T) {
	r := newRepo(t)
	res, err := r.Search(context.Background(), "   ", 20)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if res.Top != nil {
		t.Errorf("Top = %+v, want nil for blank query", res.Top)
	}
	if res.Songs == nil || res.Artists == nil || res.Genres == nil || res.Playlists == nil {
		t.Fatalf("groups must be non-nil: %+v", res)
	}
	if len(res.Songs) != 0 {
		t.Errorf("blank query should match nothing, got %d songs", len(res.Songs))
	}
}

func TestSearch_matchesSongTitleCaseInsensitively(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	s, err := r.Create(ctx, NewID(), CreateSongParams{
		Title: "Neon Undertow", ArtistName: "Vesper Lake", FilePath: "songs/n.mp3", ContentHash: "hn",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	res, err := r.Search(ctx, "neon", 20)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(res.Songs) != 1 || res.Songs[0].ID != s.ID {
		t.Fatalf("songs = %+v, want the seeded song", res.Songs)
	}
	if res.Top == nil || res.Top.Type != "song" || res.Top.ID != s.ID {
		t.Fatalf("Top = %+v, want song %s", res.Top, s.ID)
	}
}

func TestSearch_matchesArtist(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	if _, err := r.Create(ctx, NewID(), CreateSongParams{
		Title: "Song", ArtistName: "Halcyon Field", FilePath: "songs/s.mp3", ContentHash: "hs",
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	res, err := r.Search(ctx, "halcyon", 20)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(res.Artists) != 1 || res.Artists[0].Name != "Halcyon Field" {
		t.Fatalf("artists = %+v, want Halcyon Field", res.Artists)
	}
}

func TestSearch_wildcardCharsAreLiteral(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	// A song whose title has no '%' — a query of "%" must NOT match everything.
	if _, err := r.Create(ctx, NewID(), CreateSongParams{
		Title: "Plain Title", ArtistName: "A", FilePath: "songs/p.mp3", ContentHash: "hp",
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	res, err := r.Search(ctx, "%", 20)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(res.Songs) != 0 {
		t.Fatalf("'%%' must be literal, matched %d songs", len(res.Songs))
	}
}
