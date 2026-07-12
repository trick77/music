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

func TestSetSongCover_propagatesDespiteAlbumWhitespace(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	// Siblings of the same album whose stored album strings carry invisible
	// padding (leading/trailing whitespace) — common in real ID3 tags. They are
	// the same album to the user and must share one cover.
	a := makeSong(t, r, "A", "Album One", "h1", "songs/a.mp3")
	b := makeSong(t, r, "B", "Album One ", "h2", "songs/b.mp3") // trailing space
	c := makeSong(t, r, "C", " Album One", "h3", "songs/c.mp3") // leading space
	cover := makeCover(t, r, "covhash")

	if err := r.SetSongCover(ctx, a.ID, cover); err != nil {
		t.Fatalf("SetSongCover: %v", err)
	}

	for _, id := range []string{a.ID, b.ID, c.ID} {
		got, _ := r.Get(ctx, id)
		if got.CoverArtID != cover {
			t.Fatalf("song %s cover = %q, want %q", id, got.CoverArtID, cover)
		}
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

func TestUpdate_renameIntoNewAlbumRegistersMapping(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	// A song in "Alpha" gets a cover -> album_covers(Alpha) is mapped.
	a := makeSong(t, r, "A", "Alpha", "h1", "songs/a.mp3")
	cover := makeCover(t, r, "covhash")
	if err := r.SetSongCover(ctx, a.ID, cover); err != nil {
		t.Fatalf("SetSongCover: %v", err)
	}

	// Rename it into a brand-new album "Beta". The (artist, Beta) combination
	// must now map to the same cover so siblings/future songs share it.
	got, _ := r.Get(ctx, a.ID)
	if _, err := r.Update(ctx, a.ID, UpdateSongParams{
		Title: "A", ArtistName: got.ArtistName, Album: "Beta", FileSize: 1,
	}); err != nil {
		t.Fatalf("Update: %v", err)
	}

	// A future song in Beta must inherit the cover via the album mapping.
	future := makeSong(t, r, "Future", "Beta", "h9", "songs/future.mp3")
	if future.CoverArtID != cover {
		t.Fatalf("future Beta song cover = %q, want %q", future.CoverArtID, cover)
	}
}

func TestUpdate_renameIntoAlbumImposesCoverOnSiblings(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	// Destination album "Dest" already has a song with no cover.
	d := makeSong(t, r, "D", "Dest", "h1", "songs/d.mp3")
	// Source song carries a cover.
	s := makeSong(t, r, "S", "Src", "h2", "songs/s.mp3")
	cover := makeCover(t, r, "covhash")
	if err := r.SetSongCover(ctx, s.ID, cover); err != nil {
		t.Fatalf("SetSongCover: %v", err)
	}

	// Rename S into Dest. The album+artist invariant means Dest adopts S's cover.
	got, _ := r.Get(ctx, s.ID)
	if _, err := r.Update(ctx, s.ID, UpdateSongParams{
		Title: "S", ArtistName: got.ArtistName, Album: "Dest", FileSize: 1,
	}); err != nil {
		t.Fatalf("Update: %v", err)
	}

	for _, id := range []string{s.ID, d.ID} {
		g, _ := r.Get(ctx, id)
		if g.CoverArtID != cover {
			t.Fatalf("Dest song %s cover = %q, want %q", id, g.CoverArtID, cover)
		}
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
