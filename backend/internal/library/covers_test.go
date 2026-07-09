package library

import (
	"context"
	"testing"
)

func makeSong(t *testing.T, r *Repo, title, album, hash, path string) *Song {
	t.Helper()
	p := sampleParams()
	p.Title, p.Album, p.ContentHash, p.FilePath = title, album, hash, path
	s, err := r.Create(context.Background(), NewID(), p)
	if err != nil {
		t.Fatalf("Create %s: %v", title, err)
	}
	return s
}

func makeCover(t *testing.T, r *Repo, hash string) string {
	t.Helper()
	id, err := r.CreateCover(context.Background(), CoverParams{
		ImagePath: "covers/" + hash + ".jpg", Width: 500, Height: 500, ContentHash: hash,
	})
	if err != nil {
		t.Fatalf("CreateCover: %v", err)
	}
	return id
}

func TestSetSongCover_propagatesAcrossArtistAlbum(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	a := makeSong(t, r, "A", "Album One", "h1", "songs/a.mp3")
	b := makeSong(t, r, "B", "Album One", "h2", "songs/b.mp3")
	other := makeSong(t, r, "C", "Other Album", "h3", "songs/c.mp3")
	cover := makeCover(t, r, "covhash")

	if err := r.SetSongCover(ctx, a.ID, cover); err != nil {
		t.Fatalf("SetSongCover: %v", err)
	}

	// Both songs of Album One adopt it; the other album does not.
	for _, id := range []string{a.ID, b.ID} {
		got, _ := r.Get(ctx, id)
		if got.CoverArtID != cover {
			t.Fatalf("song %s cover = %q, want %q", id, got.CoverArtID, cover)
		}
	}
	if got, _ := r.Get(ctx, other.ID); got.CoverArtID != "" {
		t.Fatalf("other album wrongly covered: %q", got.CoverArtID)
	}
}

func TestCreate_futureSongInheritsAlbumCover(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	a := makeSong(t, r, "A", "Shared", "h1", "songs/a.mp3")
	cover := makeCover(t, r, "covhash")
	if err := r.SetSongCover(ctx, a.ID, cover); err != nil {
		t.Fatalf("SetSongCover: %v", err)
	}
	// A song uploaded AFTER the cover was set must inherit it.
	future := makeSong(t, r, "Future", "Shared", "h9", "songs/future.mp3")
	if future.CoverArtID != cover {
		t.Fatalf("future song cover = %q, want %q", future.CoverArtID, cover)
	}
}

func TestSetSongCover_singleIsPerSong(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	p := sampleParams()
	p.Album, p.ContentHash, p.FilePath = "", "h1", "songs/a.mp3" // no album
	single, err := r.Create(ctx, NewID(), p)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	cover := makeCover(t, r, "covhash")
	if err := r.SetSongCover(ctx, single.ID, cover); err != nil {
		t.Fatalf("SetSongCover: %v", err)
	}
	got, _ := r.Get(ctx, single.ID)
	if got.CoverArtID != cover {
		t.Fatalf("single cover = %q, want %q", got.CoverArtID, cover)
	}
}

func TestCreateCover_dedupesByHash(t *testing.T) {
	r := newRepo(t)
	id1 := makeCover(t, r, "same")
	id2 := makeCover(t, r, "same")
	if id1 != id2 {
		t.Fatalf("expected dedupe, got %q and %q", id1, id2)
	}
}
