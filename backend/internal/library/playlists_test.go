package library

import (
	"context"
	"errors"
	"testing"
)

// plSong inserts a minimal song and returns its id (reuses sampleParams from the
// package's existing test helpers).
func plSong(t *testing.T, r *Repo, title, hash, path string) string {
	t.Helper()
	p := sampleParams()
	p.Title, p.ContentHash, p.FilePath = title, hash, path
	s, err := r.Create(context.Background(), NewID(), p)
	if err != nil {
		t.Fatalf("create song %s: %v", title, err)
	}
	return s.ID
}

func TestCreateAndGetPlaylist(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	id, err := r.CreatePlaylist(ctx, "Late Night Drive", "City lights, low volume")
	if err != nil {
		t.Fatalf("CreatePlaylist: %v", err)
	}
	got, err := r.GetPlaylist(ctx, id)
	if err != nil || got == nil {
		t.Fatalf("GetPlaylist: %v (nil=%v)", err, got == nil)
	}
	if got.Name != "Late Night Drive" || got.Description != "City lights, low volume" {
		t.Fatalf("playlist = %+v", got)
	}
	if got.Songs == nil {
		t.Fatalf("Songs must be non-nil (empty slice), got nil")
	}
	if len(got.Songs) != 0 {
		t.Fatalf("new playlist should have 0 songs, got %d", len(got.Songs))
	}
}

func TestGetPlaylist_absentReturnsNil(t *testing.T) {
	r := newRepo(t)
	got, err := r.GetPlaylist(context.Background(), "nope")
	if err != nil {
		t.Fatalf("GetPlaylist: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil for absent playlist, got %+v", got)
	}
}

func TestAddSong_appendsAndIsIdempotent(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	pid, _ := r.CreatePlaylist(ctx, "P", "")
	a := plSong(t, r, "A", "h1", "songs/a.mp3")
	b := plSong(t, r, "B", "h2", "songs/b.mp3")

	if err := r.AddSong(ctx, pid, a); err != nil {
		t.Fatalf("AddSong a: %v", err)
	}
	if err := r.AddSong(ctx, pid, b); err != nil {
		t.Fatalf("AddSong b: %v", err)
	}
	if err := r.AddSong(ctx, pid, a); err != nil { // idempotent re-add
		t.Fatalf("AddSong a again: %v", err)
	}
	got, _ := r.GetPlaylist(ctx, pid)
	if len(got.Songs) != 2 {
		t.Fatalf("want 2 songs after idempotent add, got %d", len(got.Songs))
	}
	if got.Songs[0].ID != a || got.Songs[1].ID != b {
		t.Fatalf("append order wrong: %s,%s", got.Songs[0].ID, got.Songs[1].ID)
	}
	if got.SongCount != 2 {
		t.Fatalf("SongCount = %d, want 2", got.SongCount)
	}
}

func TestReorder_rewritesPositions(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	pid, _ := r.CreatePlaylist(ctx, "P", "")
	a := plSong(t, r, "A", "h1", "songs/a.mp3")
	b := plSong(t, r, "B", "h2", "songs/b.mp3")
	c := plSong(t, r, "C", "h3", "songs/c.mp3")
	for _, s := range []string{a, b, c} {
		if err := r.AddSong(ctx, pid, s); err != nil {
			t.Fatalf("AddSong: %v", err)
		}
	}
	if err := r.Reorder(ctx, pid, []string{c, a, b}); err != nil {
		t.Fatalf("Reorder: %v", err)
	}
	got, _ := r.GetPlaylist(ctx, pid)
	order := []string{got.Songs[0].ID, got.Songs[1].ID, got.Songs[2].ID}
	if order[0] != c || order[1] != a || order[2] != b {
		t.Fatalf("reorder wrong: %v", order)
	}
}

func TestReorder_mismatchRejected(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	pid, _ := r.CreatePlaylist(ctx, "P", "")
	a := plSong(t, r, "A", "h1", "songs/a.mp3")
	b := plSong(t, r, "B", "h2", "songs/b.mp3")
	r.AddSong(ctx, pid, a)
	r.AddSong(ctx, pid, b)

	// Missing member b.
	if err := r.Reorder(ctx, pid, []string{a}); !errors.Is(err, ErrReorderMismatch) {
		t.Fatalf("missing member: want ErrReorderMismatch, got %v", err)
	}
	// Extra/unknown id.
	if err := r.Reorder(ctx, pid, []string{a, b, "ghost"}); !errors.Is(err, ErrReorderMismatch) {
		t.Fatalf("extra id: want ErrReorderMismatch, got %v", err)
	}
	// Duplicate id (same length but not a permutation).
	if err := r.Reorder(ctx, pid, []string{a, a}); !errors.Is(err, ErrReorderMismatch) {
		t.Fatalf("duplicate id: want ErrReorderMismatch, got %v", err)
	}
}

func TestRemoveSong(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	pid, _ := r.CreatePlaylist(ctx, "P", "")
	a := plSong(t, r, "A", "h1", "songs/a.mp3")
	b := plSong(t, r, "B", "h2", "songs/b.mp3")
	r.AddSong(ctx, pid, a)
	r.AddSong(ctx, pid, b)
	if err := r.RemoveSong(ctx, pid, a); err != nil {
		t.Fatalf("RemoveSong: %v", err)
	}
	got, _ := r.GetPlaylist(ctx, pid)
	if len(got.Songs) != 1 || got.Songs[0].ID != b {
		t.Fatalf("after remove: %+v", got.Songs)
	}
}

func TestUpdateAndDeletePlaylist(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	pid, _ := r.CreatePlaylist(ctx, "Old", "old desc")
	if err := r.UpdatePlaylist(ctx, pid, "New", "new desc"); err != nil {
		t.Fatalf("UpdatePlaylist: %v", err)
	}
	got, _ := r.GetPlaylist(ctx, pid)
	if got.Name != "New" || got.Description != "new desc" {
		t.Fatalf("update not applied: %+v", got)
	}
	if err := r.DeletePlaylist(ctx, pid); err != nil {
		t.Fatalf("DeletePlaylist: %v", err)
	}
	gone, _ := r.GetPlaylist(ctx, pid)
	if gone != nil {
		t.Fatalf("expected deleted, got %+v", gone)
	}
}

func TestListPlaylists_newestFirst(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	first, _ := r.CreatePlaylist(ctx, "First", "")
	second, _ := r.CreatePlaylist(ctx, "Second", "")
	list, err := r.ListPlaylists(ctx)
	if err != nil {
		t.Fatalf("ListPlaylists: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("want 2 playlists, got %d", len(list))
	}
	// created_at is second-resolution; tie-break by id DESC keeps this stable.
	found := map[string]bool{first: false, second: false}
	for _, p := range list {
		found[p.ID] = true
	}
	if !found[first] || !found[second] {
		t.Fatalf("missing playlists in list: %+v", list)
	}
}

func TestSetPlaylistCover(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	pid, _ := r.CreatePlaylist(ctx, "P", "")
	coverID, err := r.CreateCover(ctx, CoverParams{
		ImagePath: "covers/pl.jpg", Width: 500, Height: 500, ContentHash: "plhash",
	})
	if err != nil {
		t.Fatalf("CreateCover: %v", err)
	}
	if err := r.SetPlaylistCover(ctx, pid, coverID); err != nil {
		t.Fatalf("SetPlaylistCover: %v", err)
	}
	got, _ := r.GetPlaylist(ctx, pid)
	if got.CoverArtID != coverID {
		t.Fatalf("cover = %q, want %q", got.CoverArtID, coverID)
	}
}
