package library

import (
	"context"
	"testing"
)

func TestSetAlbumCover_propagatesAcrossAlbum(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	a := makeSong(t, r, "A", "Album One", "h1", "songs/a.mp3")
	b := makeSong(t, r, "B", "Album One", "h2", "songs/b.mp3")
	other := makeSong(t, r, "C", "Other Album", "h3", "songs/c.mp3")
	cover := makeCover(t, r, "covhash")

	// Apply directly by artist+album (no representative song).
	if err := r.SetAlbumCover(ctx, a.ArtistID, "album one", cover); err != nil {
		t.Fatalf("SetAlbumCover: %v", err)
	}

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

func TestSetAlbumCover_futureSongInherits(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	a := makeSong(t, r, "A", "Shared", "h1", "songs/a.mp3")
	cover := makeCover(t, r, "covhash")
	if err := r.SetAlbumCover(ctx, a.ArtistID, "Shared", cover); err != nil {
		t.Fatalf("SetAlbumCover: %v", err)
	}
	// A song uploaded AFTER the mapping was set must inherit it (album_covers).
	future := makeSong(t, r, "Future", "Shared", "h9", "songs/future.mp3")
	if future.CoverArtID != cover {
		t.Fatalf("future song cover = %q, want %q", future.CoverArtID, cover)
	}
}

func TestSetAlbumCover_rejectsBlankAlbum(t *testing.T) {
	r := newRepo(t)
	a := makeSong(t, r, "A", "Album One", "h1", "songs/a.mp3")
	cover := makeCover(t, r, "covhash")
	if err := r.SetAlbumCover(context.Background(), a.ArtistID, "   ", cover); err == nil {
		t.Fatal("expected error for blank album, got nil")
	}
}

func TestListAlbums_distinctWithCoverFlag(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	a := makeSong(t, r, "A", "Album One", "h1", "songs/a.mp3")
	makeSong(t, r, "B", "Album One", "h2", "songs/b.mp3") // same album → one row
	makeSong(t, r, "C", "Other Album", "h3", "songs/c.mp3")
	// A single (no album) must not appear as an album.
	p := sampleParams()
	p.Album, p.ContentHash, p.FilePath = "", "h4", "songs/d.mp3"
	if _, err := r.Create(ctx, NewID(), p); err != nil {
		t.Fatalf("create single: %v", err)
	}

	albums, err := r.ListAlbums(ctx)
	if err != nil {
		t.Fatalf("ListAlbums: %v", err)
	}
	if len(albums) != 2 {
		t.Fatalf("albums = %d, want 2: %+v", len(albums), albums)
	}
	byName := map[string]AlbumSummary{}
	for _, al := range albums {
		byName[al.Album] = al
	}
	one, ok := byName["Album One"]
	if !ok {
		t.Fatalf("Album One missing: %+v", albums)
	}
	if one.SongCount != 2 {
		t.Fatalf("Album One songCount = %d, want 2", one.SongCount)
	}
	if one.HasCover {
		t.Fatalf("Album One should not have a cover yet")
	}

	// After mapping a cover, HasCover flips.
	cover := makeCover(t, r, "covhash")
	if err := r.SetAlbumCover(ctx, a.ArtistID, "Album One", cover); err != nil {
		t.Fatalf("SetAlbumCover: %v", err)
	}
	albums, _ = r.ListAlbums(ctx)
	for _, al := range albums {
		if al.Album == "Album One" && !al.HasCover {
			t.Fatalf("Album One HasCover = false after mapping")
		}
	}
}

func TestAlbumContext_returnsArtistAndGenres(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	a := makeSong(t, r, "A", "Album One", "h1", "songs/a.mp3") // genres from sampleParams

	got, err := r.AlbumContext(ctx, a.ArtistID, "album one") // case-insensitive
	if err != nil {
		t.Fatalf("AlbumContext: %v", err)
	}
	if !got.Exists {
		t.Fatalf("Exists = false, want true")
	}
	if got.ArtistName != "Test Artist" {
		t.Fatalf("ArtistName = %q, want Test Artist", got.ArtistName)
	}
	if len(got.Genres) != 2 {
		t.Fatalf("Genres = %#v, want 2", got.Genres)
	}

	// Unknown album → Exists false, no error.
	missing, err := r.AlbumContext(ctx, a.ArtistID, "Nope")
	if err != nil {
		t.Fatalf("AlbumContext missing: %v", err)
	}
	if missing.Exists {
		t.Fatalf("Exists = true for unknown album")
	}
}
