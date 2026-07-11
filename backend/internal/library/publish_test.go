package library

import (
	"context"
	"testing"
)

func TestCreate_defaultsUnpublished(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	song, err := r.Create(ctx, NewID(), sampleParams())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if song.Published {
		t.Fatalf("freshly created song should be unpublished")
	}
	got, err := r.Get(ctx, song.ID)
	if err != nil || got == nil {
		t.Fatalf("Get: %v (song %v)", err, got)
	}
	if got.Published {
		t.Fatalf("Get should report the song unpublished")
	}
}

func TestSetPublished_roundTripAndListFiltering(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	song, err := r.Create(ctx, NewID(), sampleParams())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Anonymous viewers never see the unpublished song; authenticated do.
	if anon, _ := r.List(ctx, false); len(anon) != 0 {
		t.Fatalf("anonymous List = %d songs, want 0", len(anon))
	}
	if all, _ := r.List(ctx, true); len(all) != 1 {
		t.Fatalf("authenticated List = %d songs, want 1", len(all))
	}

	// Publish it.
	pub, err := r.SetPublished(ctx, song.ID, true)
	if err != nil || pub == nil {
		t.Fatalf("SetPublished(true): %v (%v)", err, pub)
	}
	if !pub.Published {
		t.Fatalf("SetPublished(true) should return a published song")
	}
	if anon, _ := r.List(ctx, false); len(anon) != 1 {
		t.Fatalf("after publish, anonymous List = %d songs, want 1", len(anon))
	}

	// Unpublish it again.
	unpub, err := r.SetPublished(ctx, song.ID, false)
	if err != nil || unpub == nil || unpub.Published {
		t.Fatalf("SetPublished(false) = %v, %v", unpub, err)
	}
	if anon, _ := r.List(ctx, false); len(anon) != 0 {
		t.Fatalf("after unpublish, anonymous List = %d songs, want 0", len(anon))
	}
}

func TestSetPublished_unknownID(t *testing.T) {
	r := newRepo(t)
	got, err := r.SetPublished(context.Background(), "nope", true)
	if err != nil {
		t.Fatalf("SetPublished unknown id: unexpected error %v", err)
	}
	if got != nil {
		t.Fatalf("SetPublished unknown id = %v, want nil", got)
	}
}
