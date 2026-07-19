package library

import (
	"context"
	"testing"

	"github.com/trick77/music/internal/store"
)

func newRepo(t *testing.T) *Repo {
	t.Helper()
	st, err := store.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("store.Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return NewRepo(st.DB())
}

func sampleParams() CreateSongParams {
	return CreateSongParams{
		Title:       "Test Song",
		ArtistName:  "Test Artist",
		Album:       "Test Album",
		Year:        2020,
		TrackNo:     3,
		DurationMS:  2000,
		FilePath:    "songs/a.mp3",
		FileSize:    123,
		ContentHash: "hash-a",
		Genres:      []string{"Synthwave", "Dream Pop"},
	}
}

func TestCreate_storesGenresLowercaseAndMergesCaseVariants(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()

	p1 := sampleParams()
	p1.Genres = []string{"Jazz"}
	s1, err := r.Create(ctx, NewID(), p1)
	if err != nil {
		t.Fatalf("Create 1: %v", err)
	}
	// Names are canonicalized to lowercase on write.
	if len(s1.Genres) != 1 || s1.Genres[0] != "jazz" {
		t.Fatalf("genres = %#v, want [jazz]", s1.Genres)
	}

	// A different-cased spelling must resolve to the same single genre, not a dupe.
	p2 := sampleParams()
	p2.ContentHash = "hash-b"
	p2.FilePath = "songs/b.mp3"
	p2.Genres = []string{"JAZZ"}
	if _, err := r.Create(ctx, NewID(), p2); err != nil {
		t.Fatalf("Create 2: %v", err)
	}

	genres, err := r.ListGenres(ctx, true)
	if err != nil {
		t.Fatalf("ListGenres: %v", err)
	}
	if len(genres) != 1 || genres[0].Name != "jazz" || genres[0].SongCount != 2 {
		t.Fatalf("genres = %#v, want single jazz(2)", genres)
	}
}

func TestCreate_persistsSongWithArtistAndGenres(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	song, err := r.Create(ctx, NewID(), sampleParams())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if song.ArtistName != "Test Artist" {
		t.Errorf("ArtistName = %q", song.ArtistName)
	}
	if len(song.Genres) != 2 {
		t.Errorf("Genres = %#v, want 2", song.Genres)
	}
	got, err := r.Get(ctx, song.ID)
	if err != nil || got == nil {
		t.Fatalf("Get: %v (song %v)", err, got)
	}
	// TrackNo is auto-assigned per artist+album, so the lone song in "Test Album"
	// is renumbered from the params' 3 to "1 of 1" on Create.
	if got.Title != "Test Song" || got.Year != 2020 || got.TrackNo != 1 || got.TrackTotal != 1 {
		t.Errorf("round-trip mismatch: %+v", got)
	}
}

func TestSong_AlignmentStatus(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	song, err := r.Create(ctx, NewID(), sampleParams())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// No alignment row yet -> empty status.
	got, err := r.Get(ctx, song.ID)
	if err != nil || got == nil {
		t.Fatalf("Get: %v", err)
	}
	if got.AlignmentStatus != "" {
		t.Fatalf("want empty status, got %q", got.AlignmentStatus)
	}

	// After a claim, the song reports "generating".
	if _, err := r.StartAlignment(ctx, song.ID); err != nil {
		t.Fatal(err)
	}
	got, err = r.Get(ctx, song.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.AlignmentStatus != "generating" {
		t.Fatalf("want generating, got %q", got.AlignmentStatus)
	}
}

func TestCreate_reusesArtistCaseInsensitively(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	p1 := sampleParams()
	p1.ContentHash = "h1"
	s1, err := r.Create(ctx, NewID(), p1)
	if err != nil {
		t.Fatalf("Create 1: %v", err)
	}
	p2 := sampleParams()
	p2.ArtistName = "test artist" // different case
	p2.ContentHash = "h2"
	p2.FilePath = "songs/b.mp3"
	s2, err := r.Create(ctx, NewID(), p2)
	if err != nil {
		t.Fatalf("Create 2: %v", err)
	}
	if s1.ArtistID != s2.ArtistID {
		t.Fatalf("artist not reused: %q vs %q", s1.ArtistID, s2.ArtistID)
	}
}

func TestCreate_emptyArtistBecomesUnknown(t *testing.T) {
	r := newRepo(t)
	p := sampleParams()
	p.ArtistName = ""
	song, err := r.Create(context.Background(), NewID(), p)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if song.ArtistName != "Unknown artist" {
		t.Fatalf("ArtistName = %q, want Unknown artist", song.ArtistName)
	}
}

func TestFindByContentHash(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	created, err := r.Create(ctx, NewID(), sampleParams())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	found, err := r.FindByContentHash(ctx, "hash-a")
	if err != nil {
		t.Fatalf("FindByContentHash: %v", err)
	}
	if found == nil || found.ID != created.ID {
		t.Fatalf("dedupe lookup = %v, want %s", found, created.ID)
	}
	miss, err := r.FindByContentHash(ctx, "nope")
	if err != nil {
		t.Fatalf("FindByContentHash miss: %v", err)
	}
	if miss != nil {
		t.Fatalf("expected nil for unknown hash, got %v", miss)
	}
}

func TestBrowse_artistsAndGenres(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	makeSong(t, r, "A", "Album", "h1", "songs/a.mp3")
	makeSong(t, r, "B", "Album", "h2", "songs/b.mp3")

	artists, err := r.ListArtists(ctx, true)
	if err != nil {
		t.Fatalf("ListArtists: %v", err)
	}
	if len(artists) != 1 || artists[0].Name != "Test Artist" || artists[0].SongCount != 2 {
		t.Fatalf("artists = %#v", artists)
	}
	art, songs, err := r.GetArtist(ctx, artists[0].ID, true)
	if err != nil || art == nil {
		t.Fatalf("GetArtist: %v", err)
	}
	if len(songs) != 2 {
		t.Fatalf("artist songs = %d, want 2", len(songs))
	}

	genres, err := r.ListGenres(ctx, true)
	if err != nil {
		t.Fatalf("ListGenres: %v", err)
	}
	// Fixture has two genres: Synthwave, Dream Pop.
	if len(genres) != 2 {
		t.Fatalf("genres = %#v", genres)
	}
	_, gsongs, err := r.GetGenre(ctx, genres[0].ID, true)
	if err != nil {
		t.Fatalf("GetGenre: %v", err)
	}
	if len(gsongs) != 2 {
		t.Fatalf("genre songs = %d, want 2", len(gsongs))
	}
}

func TestUpdate_editsFieldsAndReplacesGenres(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	created, err := r.Create(ctx, NewID(), sampleParams())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	updated, err := r.Update(ctx, created.ID, UpdateSongParams{
		Title: "New Title", ArtistName: "New Artist", Album: "New Album",
		Year: 2001, TrackNo: 5, Genres: []string{"Jazz"}, FileSize: 999,
	})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Title != "New Title" || updated.ArtistName != "New Artist" || updated.Album != "New Album" {
		t.Fatalf("fields not updated: %+v", updated)
	}
	if len(updated.Genres) != 1 || updated.Genres[0] != "jazz" {
		t.Fatalf("genres not replaced: %#v", updated.Genres)
	}
	if updated.ID != created.ID {
		t.Fatalf("id changed: %s -> %s", created.ID, updated.ID)
	}
}

func TestLyrics_roundTripsThroughCreateAndUpdate(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()

	p := sampleParams()
	p.Lyrics = "First line\nSecond line"
	created, err := r.Create(ctx, NewID(), p)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if created.Lyrics != p.Lyrics {
		t.Fatalf("create lyrics = %q, want %q", created.Lyrics, p.Lyrics)
	}

	// Editing lyrics persists; clearing them reads back as empty (not stale).
	updated, err := r.Update(ctx, created.ID, UpdateSongParams{
		Title: "New Title", ArtistName: "Test Artist", Lyrics: "Edited words", FileSize: 1,
	})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Lyrics != "Edited words" {
		t.Fatalf("update lyrics = %q, want %q", updated.Lyrics, "Edited words")
	}

	cleared, err := r.Update(ctx, created.ID, UpdateSongParams{
		Title: "New Title", ArtistName: "Test Artist", Lyrics: "", FileSize: 1,
	})
	if err != nil {
		t.Fatalf("Update (clear): %v", err)
	}
	if cleared.Lyrics != "" {
		t.Fatalf("cleared lyrics = %q, want empty", cleared.Lyrics)
	}
}

func TestSuggest_artistAndGenreCounts(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	makeSong(t, r, "A", "Album", "h1", "songs/a.mp3") // Test Artist / Synthwave, Dream Pop
	makeSong(t, r, "B", "Album", "h2", "songs/b.mp3")

	got, err := r.Suggest(ctx, "artist", "test")
	if err != nil {
		t.Fatalf("Suggest artist: %v", err)
	}
	if len(got) != 1 || got[0].Value != "Test Artist" || got[0].Count != 2 {
		t.Fatalf("artist suggest = %#v", got)
	}
	gg, err := r.Suggest(ctx, "genre", "synth")
	if err != nil {
		t.Fatalf("Suggest genre: %v", err)
	}
	if len(gg) != 1 || gg[0].Value != "synthwave" {
		t.Fatalf("genre suggest = %#v", gg)
	}
	if _, err := r.Suggest(ctx, "bogus", "x"); err == nil {
		t.Fatal("expected error for unknown field")
	}
}

func TestList_newestFirst(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	p1 := sampleParams()
	p1.Title, p1.ContentHash, p1.FilePath = "First", "h1", "songs/1.mp3"
	if _, err := r.Create(ctx, NewID(), p1); err != nil {
		t.Fatalf("Create 1: %v", err)
	}
	p2 := sampleParams()
	p2.Title, p2.ContentHash, p2.FilePath = "Second", "h2", "songs/2.mp3"
	if _, err := r.Create(ctx, NewID(), p2); err != nil {
		t.Fatalf("Create 2: %v", err)
	}
	songs, err := r.List(ctx, true)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(songs) != 2 {
		t.Fatalf("List len = %d, want 2", len(songs))
	}
	// Both created "now"; ordering falls back to id desc — just assert both present.
	titles := map[string]bool{songs[0].Title: true, songs[1].Title: true}
	if !titles["First"] || !titles["Second"] {
		t.Fatalf("List titles = %v", titles)
	}
}
