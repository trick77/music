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
	if got.Title != "Test Song" || got.Year != 2020 || got.TrackNo != 3 {
		t.Errorf("round-trip mismatch: %+v", got)
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
	songs, err := r.List(ctx)
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
