package library

import (
	"context"
	"testing"
)

func TestAlignment_lifecycle(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	song, err := r.Create(ctx, NewID(), sampleParams())
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Absent -> (nil, nil).
	if a, err := r.GetAlignment(ctx, song.ID); err != nil || a != nil {
		t.Fatalf("GetAlignment absent = %v, %v; want nil,nil", a, err)
	}

	// Start (claim) generating.
	if started, err := r.StartAlignment(ctx, song.ID); err != nil || !started {
		t.Fatalf("StartAlignment (fresh) = %v, %v; want true, nil", started, err)
	}
	a, err := r.GetAlignment(ctx, song.ID)
	if err != nil || a == nil || a.Status != "generating" {
		t.Fatalf("after upsert = %+v, %v; want status generating", a, err)
	}

	// Ready stores engine + data.
	if err := r.MarkAlignmentReady(ctx, song.ID, "whisperx+demucs", `[{"text":"hi"}]`); err != nil {
		t.Fatalf("MarkAlignmentReady: %v", err)
	}
	a, _ = r.GetAlignment(ctx, song.ID)
	if a.Status != "ready" || a.Engine != "whisperx+demucs" || a.Data != `[{"text":"hi"}]` {
		t.Fatalf("after ready = %+v", a)
	}

	// Re-start after ready resets to generating and clears data.
	if started, err := r.StartAlignment(ctx, song.ID); err != nil || !started {
		t.Fatalf("re-start after ready = %v, %v; want true, nil", started, err)
	}
	a, _ = r.GetAlignment(ctx, song.ID)
	if a.Status != "generating" || a.Data != "" {
		t.Fatalf("re-start did not reset: %+v", a)
	}

	// Starting again while already generating is refused atomically (no reset).
	if started, err := r.StartAlignment(ctx, song.ID); err != nil || started {
		t.Fatalf("StartAlignment while generating = %v, %v; want false, nil", started, err)
	}

	// Failed.
	if err := r.MarkAlignmentFailed(ctx, song.ID, "boom"); err != nil {
		t.Fatalf("MarkAlignmentFailed: %v", err)
	}
	a, _ = r.GetAlignment(ctx, song.ID)
	if a.Status != "failed" {
		t.Fatalf("after failed = %+v", a)
	}
}

func TestFailOrphanedAlignments(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	song, _ := r.Create(ctx, NewID(), sampleParams())
	if _, err := r.StartAlignment(ctx, song.ID); err != nil {
		t.Fatalf("start: %v", err)
	}
	n, err := r.FailOrphanedAlignments(ctx)
	if err != nil || n != 1 {
		t.Fatalf("FailOrphanedAlignments = %d, %v; want 1, nil", n, err)
	}
	a, _ := r.GetAlignment(ctx, song.ID)
	if a.Status != "failed" {
		t.Fatalf("orphan not failed: %+v", a)
	}
}
