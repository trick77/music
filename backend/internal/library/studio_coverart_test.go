package library

import (
	"context"
	"testing"
)

func TestStudioCoverArt_createGetAndScrub(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	seed := int64(1234)
	if err := r.CreateStudioCoverArt(ctx, "c1", "coverart/c1.png", "a neon album cover", "flux-2-pro", &seed, 1024, 1024); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := r.GetStudioCoverArt(ctx, "c1")
	if err != nil || got == nil {
		t.Fatalf("get: %v (row %v)", err, got)
	}
	if got.Status != "ready" || got.Width != 1024 || got.Height != 1024 {
		t.Fatalf("unexpected row: %#v", got)
	}
	if got.ImagePath != "coverart/c1.png" || got.Prompt != "a neon album cover" || got.Model != "flux-2-pro" {
		t.Fatalf("server-only fields not stored: %#v", got)
	}
	if got.Seed == nil || *got.Seed != 1234 {
		t.Fatalf("seed not recorded: %#v", got.Seed)
	}
}

func TestStudioCoverArt_getMissingReturnsNil(t *testing.T) {
	r := newRepo(t)
	got, err := r.GetStudioCoverArt(context.Background(), "nope")
	if err != nil || got != nil {
		t.Fatalf("expected (nil,nil), got (%v,%v)", got, err)
	}
}

func TestMigration_studioCoverartStatusCheck(t *testing.T) {
	r := newRepo(t)
	if _, err := r.db.ExecContext(context.Background(),
		`INSERT INTO studio_coverart(id,image_path,status) VALUES('x','coverart/x.png','bogus')`); err == nil {
		t.Fatal("expected status CHECK to reject 'bogus'")
	}
}
