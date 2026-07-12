package library

import (
	"context"
	"strings"
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
	// Genre chapters are limited to genres in the Top Ten or Recently Added.
	if err := r.RecordPlay(ctx, s.ID); err != nil {
		t.Fatalf("record play: %v", err)
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

func TestHomeFeed_genreChaptersFallBackToAllWhenNoFeaturedGenres(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	// Genre-tagged songs exist, but neither section surfaces them: no play
	// history (Top Ten empty) and recentLimit 0 (Recently Added empty). Chapters
	// must fall back to showing every genre rather than disappearing entirely.
	if _, err := r.Create(ctx, NewID(), CreateSongParams{
		Title: "Chrome", ArtistName: "V", FilePath: "songs/c.mp3", ContentHash: "hc",
		Genres: []string{"Synthwave"},
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	feed, err := r.HomeFeed(ctx, 0, 8, true)
	if err != nil {
		t.Fatalf("HomeFeed: %v", err)
	}
	if len(feed.TopTen) != 0 || len(feed.RecentlyAdded) != 0 {
		t.Fatalf("TopTen=%v RecentlyAdded=%v, want both empty", feed.TopTen, feed.RecentlyAdded)
	}
	if len(feed.Genres) != 1 {
		t.Fatalf("chapters = %d, want 1 (fallback to all genres)", len(feed.Genres))
	}
}

func TestHomeFeed_genreChaptersIncludeRecentlyAddedNotJustTopTen(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	// Song A: played, so its genre "Played" is in the Top Ten.
	a, err := r.Create(ctx, NewID(), CreateSongParams{
		Title: "A", ArtistName: "V", FilePath: "songs/a.mp3", ContentHash: "ha", Genres: []string{"Played"},
	})
	if err != nil {
		t.Fatalf("create A: %v", err)
	}
	// Song B: recently added, never played — genre "FreshOnly" is in Recently
	// Added but NOT the Top Ten.
	if _, err := r.Create(ctx, NewID(), CreateSongParams{
		Title: "B", ArtistName: "V", FilePath: "songs/b.mp3", ContentHash: "hb", Genres: []string{"FreshOnly"},
	}); err != nil {
		t.Fatalf("create B: %v", err)
	}
	if err := r.RecordPlay(ctx, a.ID); err != nil {
		t.Fatalf("record play: %v", err)
	}

	feed, err := r.HomeFeed(ctx, 12, 8, true)
	if err != nil {
		t.Fatalf("HomeFeed: %v", err)
	}
	names := map[string]bool{}
	for _, ch := range feed.Genres {
		names[strings.ToLower(ch.Name)] = true
	}
	if !names["played"] || !names["freshonly"] {
		t.Errorf("chapters = %v, want both Played and FreshOnly", names)
	}
}

func TestHomeFeed_genreChaptersUseOnlyPrimaryGenre(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	// One recently-added song with two genres. Create flags the first as
	// is_primary, so only "Primary" should chapter the song — "Secondary" must
	// not get its own chapter off this song alone.
	if _, err := r.Create(ctx, NewID(), CreateSongParams{
		Title: "Multi", ArtistName: "V", FilePath: "songs/multi.mp3", ContentHash: "hm",
		Genres: []string{"Primary", "Secondary"},
	}); err != nil {
		t.Fatalf("create Multi: %v", err)
	}

	feed, err := r.HomeFeed(ctx, 12, 8, true)
	if err != nil {
		t.Fatalf("HomeFeed: %v", err)
	}
	names := map[string]bool{}
	for _, ch := range feed.Genres {
		names[strings.ToLower(ch.Name)] = true
	}
	if !names["primary"] {
		t.Errorf("chapters = %v, want Primary (the song's primary genre)", names)
	}
	if names["secondary"] {
		t.Errorf("chapters = %v, Secondary must not chapter (only primary genre counts)", names)
	}
}

func TestHomeFeed_genreChaptersExcludeGenresInNeitherSection(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	// "Buried": oldest song, never played and pushed out of the Recently Added
	// window (recentLimit 1) — its genre must not get a chapter.
	if _, err := r.Create(ctx, NewID(), CreateSongParams{
		Title: "Buried", ArtistName: "V", FilePath: "songs/buried.mp3", ContentHash: "hbu", Genres: []string{"Buried"},
	}); err != nil {
		t.Fatalf("create Buried: %v", err)
	}
	// "Fresh": newest song, occupies the single Recently Added slot.
	if _, err := r.Create(ctx, NewID(), CreateSongParams{
		Title: "Fresh", ArtistName: "V", FilePath: "songs/fresh.mp3", ContentHash: "hfr", Genres: []string{"Fresh"},
	}); err != nil {
		t.Fatalf("create Fresh: %v", err)
	}

	feed, err := r.HomeFeed(ctx, 1, 8, true)
	if err != nil {
		t.Fatalf("HomeFeed: %v", err)
	}
	names := map[string]bool{}
	for _, ch := range feed.Genres {
		names[strings.ToLower(ch.Name)] = true
	}
	if names["buried"] {
		t.Errorf("chapters = %v, Buried should be excluded (in neither section)", names)
	}
	if !names["fresh"] {
		t.Errorf("chapters = %v, want Fresh (in Recently Added)", names)
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

func TestHomeFeed_anonymousHeroHidesUnpublishedGenre(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	// A single unpublished song in genre "Secret".
	if _, err := r.Create(ctx, NewID(), CreateSongParams{
		Title: "H", ArtistName: "A", FilePath: "songs/h.mp3", ContentHash: "hh", Genres: []string{"Secret"},
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	genres, _ := r.ListGenres(ctx, true)
	gid := genres[0].ID
	if err := r.SetGenreAccent(ctx, gid, "#123456"); err != nil {
		t.Fatalf("accent: %v", err)
	}
	// Hero fanart with NO caption, so the title would otherwise fall back to the
	// genre name.
	faID, err := r.CreateFanart(ctx, FanartParams{Kind: "genre", GenreID: gid, ImagePath: "fanart/h.jpg", Status: "ready", Caption: ""})
	if err != nil {
		t.Fatalf("fanart: %v", err)
	}
	if err := r.SetHero(ctx, faID); err != nil {
		t.Fatalf("set hero: %v", err)
	}

	// Authenticated: the hero surfaces the genre's name, accent, and link.
	authed, err := r.HomeFeed(ctx, 12, 8, true)
	if err != nil {
		t.Fatalf("HomeFeed authed: %v", err)
	}
	if authed.Hero == nil || authed.Hero.GenreID != gid || authed.Hero.AccentColor != "#123456" || authed.Hero.Title != "secret" {
		t.Fatalf("authed hero = %+v, want the genre surfaced", authed.Hero)
	}
	// Anonymous: the genre has no published songs, so its name/accent/link are
	// withheld while the admin-curated art still shows.
	anon, err := r.HomeFeed(ctx, 12, 8, false)
	if err != nil {
		t.Fatalf("HomeFeed anon: %v", err)
	}
	if anon.Hero == nil {
		t.Fatal("anon hero nil, want the hero art to still show")
	}
	if anon.Hero.GenreID != "" || anon.Hero.AccentColor != "" || anon.Hero.Title != "Featured" {
		t.Fatalf("anon hero leaked a hidden genre: %+v", anon.Hero)
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
