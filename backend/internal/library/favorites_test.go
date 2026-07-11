package library

import (
	"context"
	"testing"
)

func TestFavorites_addListRemove(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	a := plSong(t, r, "A", "h1", "songs/a.mp3")
	b := plSong(t, r, "B", "h2", "songs/b.mp3")

	if err := r.AddFavorite(ctx, "alice", a); err != nil {
		t.Fatalf("AddFavorite a: %v", err)
	}
	if err := r.AddFavorite(ctx, "alice", b); err != nil {
		t.Fatalf("AddFavorite b: %v", err)
	}

	got, err := r.ListFavorites(ctx, "alice")
	if err != nil {
		t.Fatalf("ListFavorites: %v", err)
	}
	if len(got) != 2 || got[0] != a || got[1] != b {
		t.Fatalf("favorites = %v, want [%s %s] in insert order", got, a, b)
	}

	if err := r.RemoveFavorite(ctx, "alice", a); err != nil {
		t.Fatalf("RemoveFavorite: %v", err)
	}
	got, _ = r.ListFavorites(ctx, "alice")
	if len(got) != 1 || got[0] != b {
		t.Fatalf("after remove = %v, want [%s]", got, b)
	}
}

func TestListFavorites_emptyIsNonNil(t *testing.T) {
	r := newRepo(t)
	got, err := r.ListFavorites(context.Background(), "nobody")
	if err != nil {
		t.Fatalf("ListFavorites: %v", err)
	}
	if got == nil {
		t.Fatalf("expected non-nil empty slice, got nil")
	}
	if len(got) != 0 {
		t.Fatalf("expected empty, got %v", got)
	}
}

func TestAddFavorite_idempotent(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	a := plSong(t, r, "A", "h1", "songs/a.mp3")
	for i := 0; i < 3; i++ {
		if err := r.AddFavorite(ctx, "alice", a); err != nil {
			t.Fatalf("AddFavorite #%d: %v", i, err)
		}
	}
	got, _ := r.ListFavorites(ctx, "alice")
	if len(got) != 1 {
		t.Fatalf("re-favoriting should be a no-op, got %v", got)
	}
}

func TestRemoveFavorite_missingIsNoop(t *testing.T) {
	r := newRepo(t)
	if err := r.RemoveFavorite(context.Background(), "alice", "ghost"); err != nil {
		t.Fatalf("RemoveFavorite of a non-favorite should succeed: %v", err)
	}
}

// Favorites are per-user: one user's list never leaks into another's.
func TestFavorites_scopedByUser(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	a := plSong(t, r, "A", "h1", "songs/a.mp3")
	if err := r.AddFavorite(ctx, "alice", a); err != nil {
		t.Fatalf("AddFavorite: %v", err)
	}
	bob, _ := r.ListFavorites(ctx, "bob")
	if len(bob) != 0 {
		t.Fatalf("bob should have no favorites, got %v", bob)
	}
}

// Deleting a song cascades to its favorite rows (FK ON DELETE CASCADE).
func TestFavorites_cascadeOnSongDelete(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	a := plSong(t, r, "A", "h1", "songs/a.mp3")
	if err := r.AddFavorite(ctx, "alice", a); err != nil {
		t.Fatalf("AddFavorite: %v", err)
	}
	if _, _, err := r.DeleteSong(ctx, a); err != nil {
		t.Fatalf("DeleteSong: %v", err)
	}
	got, _ := r.ListFavorites(ctx, "alice")
	if len(got) != 0 {
		t.Fatalf("favorite should cascade-delete with its song, got %v", got)
	}
}
