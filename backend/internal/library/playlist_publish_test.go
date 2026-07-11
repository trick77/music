package library

import (
	"context"
	"testing"
)

func TestCreatePlaylist_defaultsUnpublished(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	id, err := r.CreatePlaylist(ctx, "Drive", "")
	if err != nil {
		t.Fatalf("CreatePlaylist: %v", err)
	}
	pl, err := r.GetPlaylist(ctx, id, true)
	if err != nil || pl == nil {
		t.Fatalf("GetPlaylist: %v (%v)", err, pl)
	}
	if pl.Published {
		t.Fatalf("a freshly created playlist should be unpublished")
	}
}

func TestPlaylist_anonymousSeesOnlyPublished(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	id, err := r.CreatePlaylist(ctx, "Drive", "")
	if err != nil {
		t.Fatalf("CreatePlaylist: %v", err)
	}

	// Anonymous: unpublished playlist is absent from the list and 404s directly.
	if anon, _ := r.ListPlaylists(ctx, false); len(anon) != 0 {
		t.Fatalf("anonymous ListPlaylists = %d, want 0", len(anon))
	}
	if pl, _ := r.GetPlaylist(ctx, id, false); pl != nil {
		t.Fatalf("anonymous GetPlaylist should be nil for an unpublished playlist")
	}
	// Authenticated always sees it.
	if all, _ := r.ListPlaylists(ctx, true); len(all) != 1 {
		t.Fatalf("authenticated ListPlaylists = %d, want 1", len(all))
	}

	// Publish → visible to anonymous.
	found, err := r.SetPlaylistPublished(ctx, id, true)
	if err != nil || !found {
		t.Fatalf("SetPlaylistPublished(true) = %v, %v", found, err)
	}
	if anon, _ := r.ListPlaylists(ctx, false); len(anon) != 1 || !anon[0].Published {
		t.Fatalf("after publish, anonymous ListPlaylists = %#v", anon)
	}
	if pl, _ := r.GetPlaylist(ctx, id, false); pl == nil {
		t.Fatalf("after publish, anonymous GetPlaylist should be non-nil")
	}

	// Unpublish → hidden again.
	if _, err := r.SetPlaylistPublished(ctx, id, false); err != nil {
		t.Fatalf("SetPlaylistPublished(false): %v", err)
	}
	if anon, _ := r.ListPlaylists(ctx, false); len(anon) != 0 {
		t.Fatalf("after unpublish, anonymous ListPlaylists = %d, want 0", len(anon))
	}
}

func TestSetPlaylistPublished_unknownID(t *testing.T) {
	r := newRepo(t)
	found, err := r.SetPlaylistPublished(context.Background(), "nope", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if found {
		t.Fatalf("SetPlaylistPublished on unknown id should report not found")
	}
}

func TestPlaylist_anonymousCountExcludesUnpublishedTracks(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	pid, err := r.CreatePlaylist(ctx, "Mix", "")
	if err != nil {
		t.Fatalf("CreatePlaylist: %v", err)
	}
	if _, err := r.SetPlaylistPublished(ctx, pid, true); err != nil {
		t.Fatalf("publish playlist: %v", err)
	}
	// One published + one unpublished track.
	pub := mkPubSong(t, r, ctx, "A", "Rock", "hp", true)
	unpub := mkPubSong(t, r, ctx, "A", "Rock", "hu", false)
	for _, sid := range []string{pub, unpub} {
		if err := r.AddSong(ctx, pid, sid); err != nil {
			t.Fatalf("AddSong: %v", err)
		}
	}

	// Anonymous: count + track list reflect published tracks only.
	anon, _ := r.ListPlaylists(ctx, false)
	if len(anon) != 1 || anon[0].SongCount != 1 {
		t.Fatalf("anon list count = %#v, want SongCount 1", anon)
	}
	detail, _ := r.GetPlaylist(ctx, pid, false)
	if detail == nil || detail.SongCount != 1 || len(detail.Songs) != 1 {
		t.Fatalf("anon detail = %+v (songs %d), want count 1 / 1 track", detail, len(detail.Songs))
	}
	// Authenticated: count + list include the unpublished track.
	all, _ := r.ListPlaylists(ctx, true)
	if all[0].SongCount != 2 {
		t.Fatalf("auth list count = %d, want 2", all[0].SongCount)
	}
}
