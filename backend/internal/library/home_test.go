package library

import (
	"context"
	"testing"
)

func TestHomeFeed_emptyLibraryDegradesGracefully(t *testing.T) {
	r := newRepo(t)
	feed, err := r.HomeFeed(context.Background(), 12, 8, true)
	if err != nil {
		t.Fatalf("HomeFeed: %v", err)
	}
	if feed == nil {
		t.Fatal("feed is nil")
	}
	if feed.Hero != nil {
		t.Errorf("Hero = %+v, want nil on empty library", feed.Hero)
	}
	// All slices must be non-nil (JSON-encodes as [] not null).
	if feed.TopTen == nil || feed.RecentlyAdded == nil || feed.Genres == nil || feed.Playlists == nil {
		t.Fatalf("slices must be non-nil: %+v", feed)
	}
}

func TestHomeFeed_recentNewestFirstWithLimit(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	for _, name := range []string{"One", "Two", "Three"} {
		seedSong(t, r, name)
	}
	feed, err := r.HomeFeed(ctx, 2, 8, true)
	if err != nil {
		t.Fatalf("HomeFeed: %v", err)
	}
	if len(feed.RecentlyAdded) != 2 {
		t.Fatalf("recent len = %d, want 2 (limit)", len(feed.RecentlyAdded))
	}
	// Newest first: "Three" was inserted last.
	if feed.RecentlyAdded[0].Title != "Three" {
		t.Errorf("recent[0] = %q, want Three", feed.RecentlyAdded[0].Title)
	}
}

func TestHomeFeed_genreChaptersHaveBackgroundAndSongs(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	// A song tagged with a genre creates the genre.
	s, err := r.Create(ctx, NewID(), CreateSongParams{
		Title: "Chrome", ArtistName: "V", FilePath: "songs/c.mp3", ContentHash: "hc",
		Genres: []string{"Synthwave"},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	genres, err := r.ListGenres(ctx, true)
	if err != nil || len(genres) != 1 {
		t.Fatalf("genres = %v (%v)", genres, err)
	}
	gid := genres[0].ID
	// Give the genre an active-background fanart.
	faID, err := r.CreateFanart(ctx, FanartParams{Kind: "genre", GenreID: gid, ImagePath: "fanart/x.jpg", Status: "ready", Width: 10, Height: 10})
	if err != nil {
		t.Fatalf("fanart: %v", err)
	}
	if err := r.SetActiveBackground(ctx, gid, faID); err != nil {
		t.Fatalf("set active: %v", err)
	}

	feed, err := r.HomeFeed(ctx, 12, 8, true)
	if err != nil {
		t.Fatalf("HomeFeed: %v", err)
	}
	if len(feed.Genres) != 1 {
		t.Fatalf("chapters = %d, want 1", len(feed.Genres))
	}
	ch := feed.Genres[0]
	if ch.BackgroundFanartID != faID {
		t.Errorf("chapter background = %q, want %q", ch.BackgroundFanartID, faID)
	}
	if len(ch.Songs) != 1 || ch.Songs[0].ID != s.ID {
		t.Errorf("chapter songs = %+v, want the one seeded song", ch.Songs)
	}
}

func TestHomeFeed_heroPopulatedFromStarredFanart(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	// Seed a genre + a genre-kind fanart, star it as the hero.
	if _, err := r.Create(ctx, NewID(), CreateSongParams{
		Title: "H", ArtistName: "A", FilePath: "songs/h.mp3", ContentHash: "hh", Genres: []string{"Ambient"},
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	genres, _ := r.ListGenres(ctx, true)
	gid := genres[0].ID
	if err := r.SetGenreAccent(ctx, gid, "#123456"); err != nil {
		t.Fatalf("accent: %v", err)
	}
	faID, err := r.CreateFanart(ctx, FanartParams{Kind: "genre", GenreID: gid, ImagePath: "fanart/h.jpg", Status: "ready", Caption: "Deep Space"})
	if err != nil {
		t.Fatalf("fanart: %v", err)
	}
	if err := r.SetHero(ctx, faID); err != nil {
		t.Fatalf("set hero: %v", err)
	}
	feed, err := r.HomeFeed(ctx, 12, 8, true)
	if err != nil {
		t.Fatalf("HomeFeed: %v", err)
	}
	if feed.Hero == nil {
		t.Fatal("Hero is nil, want populated")
	}
	if feed.Hero.FanartID != faID {
		t.Errorf("hero fanart = %q, want %q", feed.Hero.FanartID, faID)
	}
	if feed.Hero.AccentColor != "#123456" {
		t.Errorf("hero accent = %q, want #123456", feed.Hero.AccentColor)
	}
	if feed.Hero.Title != "Deep Space" { // caption preferred
		t.Errorf("hero title = %q, want caption 'Deep Space'", feed.Hero.Title)
	}
}

func TestHomeFeed_zeroSongGenreOmitted(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	// Insert a genre directly with no songs; it must not appear as a chapter.
	if _, err := r.db.ExecContext(ctx, `INSERT INTO genres(id, name) VALUES(?,?)`, NewID(), "Empty"); err != nil {
		t.Fatalf("insert genre: %v", err)
	}
	feed, err := r.HomeFeed(ctx, 12, 8, true)
	if err != nil {
		t.Fatalf("HomeFeed: %v", err)
	}
	if len(feed.Genres) != 0 {
		t.Fatalf("chapters = %d, want 0 (zero-song genre omitted)", len(feed.Genres))
	}
}
