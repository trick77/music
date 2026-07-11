package library

import (
	"context"
	"testing"
)

// mkPubSong creates a song with a given artist + single genre and publish state.
func mkPubSong(t *testing.T, r *Repo, ctx context.Context, artist, genre, hash string, published bool) string {
	t.Helper()
	p := sampleParams()
	p.ArtistName = artist
	p.Genres = []string{genre}
	p.ContentHash = hash
	p.FilePath = "songs/" + hash + ".mp3"
	s, err := r.Create(ctx, NewID(), p)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if published {
		if _, err := r.SetPublished(ctx, s.ID, true); err != nil {
			t.Fatalf("publish: %v", err)
		}
	}
	return s.ID
}

func findByName[T any](items []T, name func(T) string, want string) (T, bool) {
	for _, it := range items {
		if name(it) == want {
			return it, true
		}
	}
	var zero T
	return zero, false
}

func TestListArtists_anonymousHidesUnpublishedOnly(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	mkPubSong(t, r, ctx, "Published Artist", "Rock", "h1", true)
	mkPubSong(t, r, ctx, "Draft Artist", "Rock", "h2", false)

	anon, err := r.ListArtists(ctx, false)
	if err != nil {
		t.Fatalf("ListArtists: %v", err)
	}
	if len(anon) != 1 || anon[0].Name != "Published Artist" || anon[0].SongCount != 1 {
		t.Fatalf("anonymous artists = %#v, want only Published Artist(1)", anon)
	}
	all, _ := r.ListArtists(ctx, true)
	if len(all) != 2 {
		t.Fatalf("authenticated artists = %d, want 2", len(all))
	}
}

func TestGetArtist_anonymousCountsPublishedAndHidesEmpty(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	mkPubSong(t, r, ctx, "Mixed", "Rock", "h1", true)  // published
	mkPubSong(t, r, ctx, "Mixed", "Rock", "h2", false) // unpublished, same artist
	mkPubSong(t, r, ctx, "Draft", "Rock", "h3", false) // all-unpublished artist

	all, _ := r.ListArtists(ctx, true)
	mixed, _ := findByName(all, func(a ArtistSummary) string { return a.Name }, "Mixed")
	draft, _ := findByName(all, func(a ArtistSummary) string { return a.Name }, "Draft")

	// Anonymous: Mixed shows a published-only count and only published songs.
	art, songs, err := r.GetArtist(ctx, mixed.ID, false)
	if err != nil {
		t.Fatalf("GetArtist: %v", err)
	}
	if art == nil || art.SongCount != 1 || len(songs) != 1 {
		t.Fatalf("anon Mixed = %+v songs=%d, want count 1 / songs 1", art, len(songs))
	}
	// Anonymous: an all-unpublished artist is hidden (nil → 404 in the handler).
	da, _, err := r.GetArtist(ctx, draft.ID, false)
	if err != nil {
		t.Fatalf("GetArtist draft: %v", err)
	}
	if da != nil {
		t.Fatalf("anon all-unpublished artist should be hidden, got %+v", da)
	}
	// Authenticated still sees it.
	if da2, _, _ := r.GetArtist(ctx, draft.ID, true); da2 == nil {
		t.Fatalf("authenticated should see the draft artist")
	}
}

func TestListGenres_anonymousHidesUnpublishedOnly(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	mkPubSong(t, r, ctx, "Artist", "PubGenre", "h1", true)
	mkPubSong(t, r, ctx, "Artist", "DraftGenre", "h2", false)

	anon, _ := r.ListGenres(ctx, false)
	if len(anon) != 1 || anon[0].Name != "PubGenre" || anon[0].SongCount != 1 {
		t.Fatalf("anonymous genres = %#v, want only PubGenre(1)", anon)
	}
	all, _ := r.ListGenres(ctx, true)
	if len(all) != 2 {
		t.Fatalf("authenticated genres = %d, want 2", len(all))
	}
}

func TestGetGenre_anonymousCountsPublishedAndHidesEmpty(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	mkPubSong(t, r, ctx, "Artist", "Mixed", "h1", true)
	mkPubSong(t, r, ctx, "Artist", "Mixed", "h2", false)
	mkPubSong(t, r, ctx, "Artist", "Draft", "h3", false)

	all, _ := r.ListGenres(ctx, true)
	mixed, _ := findByName(all, func(g GenreSummary) string { return g.Name }, "Mixed")
	draft, _ := findByName(all, func(g GenreSummary) string { return g.Name }, "Draft")

	g, songs, err := r.GetGenre(ctx, mixed.ID, false)
	if err != nil {
		t.Fatalf("GetGenre: %v", err)
	}
	if g == nil || g.SongCount != 1 || len(songs) != 1 {
		t.Fatalf("anon Mixed genre = %+v songs=%d, want count 1 / songs 1", g, len(songs))
	}
	if dg, _, _ := r.GetGenre(ctx, draft.ID, false); dg != nil {
		t.Fatalf("anon all-unpublished genre should be hidden, got %+v", dg)
	}
	if dg2, _, _ := r.GetGenre(ctx, draft.ID, true); dg2 == nil {
		t.Fatalf("authenticated should see the draft genre")
	}
}

func TestSearch_anonymousHidesUnpublishedArtistsAndGenres(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	mkPubSong(t, r, ctx, "Neon Artist", "Neon Genre", "h1", false) // all unpublished

	anon, err := r.Search(ctx, "Neon", 20, false)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(anon.Songs) != 0 || len(anon.Artists) != 0 || len(anon.Genres) != 0 {
		t.Fatalf("anon search leaked songs=%d artists=%d genres=%d, want all 0",
			len(anon.Songs), len(anon.Artists), len(anon.Genres))
	}
	all, _ := r.Search(ctx, "Neon", 20, true)
	if len(all.Artists) != 1 || len(all.Genres) != 1 {
		t.Fatalf("authenticated search artists=%d genres=%d, want 1/1", len(all.Artists), len(all.Genres))
	}
}
