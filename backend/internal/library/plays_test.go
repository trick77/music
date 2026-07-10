package library

import (
	"context"
	"testing"
)

// seedSong inserts a song with a distinct hash/path derived from title so the
// content_hash unique index is never tripped, and returns its id.
func seedSong(t *testing.T, r *Repo, title string) string {
	t.Helper()
	p := CreateSongParams{
		Title:       title,
		ArtistName:  "Artist " + title,
		DurationMS:  200000,
		FilePath:    "songs/" + title + ".mp3",
		FileSize:    1,
		ContentHash: "hash-" + title,
	}
	s, err := r.Create(context.Background(), NewID(), p)
	if err != nil {
		t.Fatalf("seed %q: %v", title, err)
	}
	return s.ID
}

func TestPlays_RecordAndCount(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	a := seedSong(t, r, "Alpha")
	b := seedSong(t, r, "Bravo")

	for i := 0; i < 3; i++ {
		if err := r.RecordPlay(ctx, a); err != nil {
			t.Fatalf("RecordPlay a: %v", err)
		}
	}
	if err := r.RecordPlay(ctx, b); err != nil {
		t.Fatalf("RecordPlay b: %v", err)
	}

	top, err := r.TopTen(ctx)
	if err != nil {
		t.Fatalf("TopTen: %v", err)
	}
	if len(top) != 2 {
		t.Fatalf("len(top) = %d, want 2", len(top))
	}
	if top[0].ID != a || top[0].Plays != 3 {
		t.Errorf("rank 1 = %s plays=%d, want %s plays=3", top[0].ID, top[0].Plays, a)
	}
	if top[1].ID != b || top[1].Plays != 1 {
		t.Errorf("rank 2 = %s plays=%d, want %s plays=1", top[1].ID, top[1].Plays, b)
	}
	// Embedded Song fields are hydrated.
	if top[0].Title != "Alpha" || top[0].ArtistName != "Artist Alpha" {
		t.Errorf("song not hydrated: %+v", top[0].Song)
	}
}

func TestPlays_DeterministicTieBreak(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	// Same play count (1 each); deterministic order is by lower(title) then id.
	// Insert plays in a scrambled order to prove ordering is data-driven, not
	// insertion-driven.
	zebra := seedSong(t, r, "Zebra")
	apple := seedSong(t, r, "apple") // lower-cased title sorts before "Mango"
	mango := seedSong(t, r, "Mango")
	for _, id := range []string{zebra, mango, apple} {
		if err := r.RecordPlay(ctx, id); err != nil {
			t.Fatalf("RecordPlay: %v", err)
		}
	}
	top, err := r.TopTen(ctx)
	if err != nil {
		t.Fatalf("TopTen: %v", err)
	}
	gotOrder := []string{top[0].Title, top[1].Title, top[2].Title}
	want := []string{"apple", "Mango", "Zebra"}
	for i := range want {
		if gotOrder[i] != want[i] {
			t.Fatalf("tie-break order = %v, want %v", gotOrder, want)
		}
	}
}

func TestPlays_LimitTen(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	for i := 0; i < 12; i++ {
		id := seedSong(t, r, string(rune('a'+i)))
		if err := r.RecordPlay(ctx, id); err != nil {
			t.Fatalf("RecordPlay: %v", err)
		}
	}
	top, err := r.TopTen(ctx)
	if err != nil {
		t.Fatalf("TopTen: %v", err)
	}
	if len(top) != 10 {
		t.Fatalf("len(top) = %d, want 10 (capped)", len(top))
	}
}

func TestPlays_UnknownSongErrors(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	if err := r.RecordPlay(ctx, "does-not-exist"); err == nil {
		t.Fatal("RecordPlay for unknown song should error")
	}
	top, err := r.TopTen(ctx)
	if err != nil {
		t.Fatalf("TopTen: %v", err)
	}
	if len(top) != 0 {
		t.Fatalf("no plays recorded expected, got %d", len(top))
	}
}
