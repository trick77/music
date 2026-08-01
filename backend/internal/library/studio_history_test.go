package library

import (
	"context"
	"testing"
)

func sampleRun(id, ref string) StudioRun {
	return StudioRun{
		ID: id, Reference: ref, ReferenceArtist: "Metallica", ReferenceTitle: "Enter Sandman",
		StylePrompt: "1991,thrash metal", Lyrics: "[Verse]\nx", CoverArtPrompt: "a door",
		Genres: []string{"thrash metal"}, Bands: []string{"Hollow Sabbath"},
		Titles: []string{"Sleep Is a Door"}, Albums: []string{"Nightfall Sessions"},
	}
}

func TestStudioRun_createAndGet(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	if err := r.CreateStudioRun(ctx, sampleRun("a", "Metallica, Enter Sandman")); err != nil {
		t.Fatalf("CreateStudioRun: %v", err)
	}
	got, err := r.GetStudioRun(ctx, "a")
	if err != nil {
		t.Fatalf("GetStudioRun: %v", err)
	}
	if got == nil {
		t.Fatalf("GetStudioRun returned nil for an existing run")
	}
	// The JSON list columns must survive the round trip as real slices — this is
	// the whole reason they are stored as JSON rather than a joined string.
	if len(got.Genres) != 1 || got.Genres[0] != "thrash metal" {
		t.Fatalf("Genres = %#v, want [thrash metal]", got.Genres)
	}
	if got.ReferenceTitle != "Enter Sandman" {
		t.Fatalf("ReferenceTitle = %q", got.ReferenceTitle)
	}
	if got.CoverArtID != "" {
		t.Fatalf("CoverArtID = %q, want empty for a run with no cover", got.CoverArtID)
	}
	if got.CreatedAt == "" {
		t.Fatalf("CreatedAt is empty")
	}
}

// A nil list must round-trip as an empty slice, never as JSON null: the client
// types these as arrays and would break on null.
func TestStudioRun_nilListsBecomeEmptyArrays(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	if err := r.CreateStudioRun(ctx, StudioRun{
		ID: "a", Reference: "x", StylePrompt: "s", Lyrics: "l", CoverArtPrompt: "c",
	}); err != nil {
		t.Fatalf("CreateStudioRun: %v", err)
	}
	got, err := r.GetStudioRun(ctx, "a")
	if err != nil {
		t.Fatalf("GetStudioRun: %v", err)
	}
	for name, list := range map[string][]string{
		"Genres": got.Genres, "Bands": got.Bands, "Titles": got.Titles, "Albums": got.Albums,
	} {
		if list == nil {
			t.Fatalf("%s = nil, want an empty slice", name)
		}
		if len(list) != 0 {
			t.Fatalf("%s = %#v, want empty", name, list)
		}
	}
}

// Absent means (nil, nil), never a sentinel error — the house convention.
func TestStudioRun_getMissingIsNilNil(t *testing.T) {
	got, err := newRepo(t).GetStudioRun(context.Background(), "nope")
	if err != nil {
		t.Fatalf("GetStudioRun: %v", err)
	}
	if got != nil {
		t.Fatalf("GetStudioRun = %#v, want nil", got)
	}
}

// The drawer pages with a keyset on rowid, newest first. Page 2 must continue
// exactly where page 1 stopped, with no repeats and no gaps.
func TestStudioRun_listPagesNewestFirst(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		if err := r.CreateStudioRun(ctx, sampleRun(id, "ref "+id)); err != nil {
			t.Fatalf("CreateStudioRun %s: %v", id, err)
		}
	}
	first, err := r.ListStudioRuns(ctx, 2, 0)
	if err != nil {
		t.Fatalf("ListStudioRuns: %v", err)
	}
	if len(first) != 2 || first[0].ID != "e" || first[1].ID != "d" {
		t.Fatalf("page 1 = %v, want [e d]", runIDs(first))
	}
	second, err := r.ListStudioRuns(ctx, 2, first[1].RowID)
	if err != nil {
		t.Fatalf("ListStudioRuns page 2: %v", err)
	}
	if len(second) != 2 || second[0].ID != "c" || second[1].ID != "b" {
		t.Fatalf("page 2 = %v, want [c b]", runIDs(second))
	}
	n, err := r.CountStudioRuns(ctx)
	if err != nil {
		t.Fatalf("CountStudioRuns: %v", err)
	}
	if n != 5 {
		t.Fatalf("CountStudioRuns = %d, want 5", n)
	}
}

// An empty table lists as an empty slice, not nil — the handler serializes it
// straight to JSON and must emit [] rather than null.
func TestStudioRun_listEmptyIsEmptySlice(t *testing.T) {
	got, err := newRepo(t).ListStudioRuns(context.Background(), 25, 0)
	if err != nil {
		t.Fatalf("ListStudioRuns: %v", err)
	}
	if got == nil {
		t.Fatalf("ListStudioRuns = nil, want an empty slice")
	}
	if len(got) != 0 {
		t.Fatalf("ListStudioRuns = %v, want empty", runIDs(got))
	}
}

// A non-positive limit is a caller slip, not a request for the whole table.
func TestStudioRun_listDefaultsANonPositiveLimit(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	for _, id := range []string{"a", "b", "c"} {
		if err := r.CreateStudioRun(ctx, sampleRun(id, "ref "+id)); err != nil {
			t.Fatalf("CreateStudioRun %s: %v", id, err)
		}
	}
	got, err := r.ListStudioRuns(ctx, 0, 0)
	if err != nil {
		t.Fatalf("ListStudioRuns: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("ListStudioRuns(0) returned %d runs, want all 3", len(got))
	}
}

func runIDs(rs []StudioRun) []string {
	out := []string{}
	for _, r := range rs {
		out = append(out, r.ID)
	}
	return out
}

// A refine overwrites the run's lyrics in place and counts. A hand edit
// overwrites them without counting — it is not a refine.
func TestStudioRun_updateLyrics(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	if err := r.CreateStudioRun(ctx, sampleRun("a", "ref")); err != nil {
		t.Fatalf("CreateStudioRun: %v", err)
	}
	if err := r.UpdateStudioRunLyrics(ctx, "a", "[Verse]\nrewritten", true); err != nil {
		t.Fatalf("UpdateStudioRunLyrics: %v", err)
	}
	got, _ := r.GetStudioRun(ctx, "a")
	if got.Lyrics != "[Verse]\nrewritten" || got.RefineCount != 1 {
		t.Fatalf("after refine: lyrics=%q refines=%d", got.Lyrics, got.RefineCount)
	}
	if err := r.UpdateStudioRunLyrics(ctx, "a", "[Verse]\nhand", false); err != nil {
		t.Fatalf("UpdateStudioRunLyrics hand edit: %v", err)
	}
	got, _ = r.GetStudioRun(ctx, "a")
	if got.Lyrics != "[Verse]\nhand" || got.RefineCount != 1 {
		t.Fatalf("after hand edit: lyrics=%q refines=%d, want refines unchanged", got.Lyrics, got.RefineCount)
	}
}

// Updating a run that is gone is a no-op, not an error: the refine that follows a
// deleted run must not fail the rewrite the user is watching.
func TestStudioRun_updatesOnAMissingRunAreNoOps(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	if err := r.UpdateStudioRunLyrics(ctx, "nope", "x", true); err != nil {
		t.Fatalf("UpdateStudioRunLyrics on a missing run: %v", err)
	}
	if err := r.UpdateStudioRunCoverArt(ctx, "nope", "img1"); err != nil {
		t.Fatalf("UpdateStudioRunCoverArt on a missing run: %v", err)
	}
}

func TestStudioRun_attachCoverArtAndDelete(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	if err := r.CreateStudioRun(ctx, sampleRun("a", "ref")); err != nil {
		t.Fatalf("CreateStudioRun: %v", err)
	}
	if err := r.UpdateStudioRunCoverArt(ctx, "a", "img1"); err != nil {
		t.Fatalf("UpdateStudioRunCoverArt: %v", err)
	}
	got, _ := r.GetStudioRun(ctx, "a")
	if got.CoverArtID != "img1" {
		t.Fatalf("CoverArtID = %q, want img1", got.CoverArtID)
	}
	if err := r.DeleteStudioRun(ctx, "a"); err != nil {
		t.Fatalf("DeleteStudioRun: %v", err)
	}
	got, _ = r.GetStudioRun(ctx, "a")
	if got != nil {
		t.Fatalf("run still present after delete")
	}
	// Deleting a run that is already gone is a no-op, not an error — the drawer
	// may fire the same delete twice.
	if err := r.DeleteStudioRun(ctx, "a"); err != nil {
		t.Fatalf("second DeleteStudioRun: %v", err)
	}
}

// A column holding something that is not a JSON array must degrade to an empty
// list, not fail the read: one bad row cannot be allowed to make the drawer
// unopenable.
func TestStudioRun_malformedListColumnReadsAsEmpty(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()
	if err := r.CreateStudioRun(ctx, sampleRun("a", "ref")); err != nil {
		t.Fatalf("CreateStudioRun: %v", err)
	}
	if _, err := r.db.ExecContext(ctx,
		`UPDATE studio_history SET genres='not json' WHERE id='a'`); err != nil {
		t.Fatalf("corrupt genres: %v", err)
	}
	got, err := r.GetStudioRun(ctx, "a")
	if err != nil {
		t.Fatalf("GetStudioRun: %v", err)
	}
	if len(got.Genres) != 0 {
		t.Fatalf("Genres = %#v, want empty", got.Genres)
	}
	// The rest of the row still reads normally.
	if len(got.Bands) != 1 {
		t.Fatalf("Bands = %#v, want the stored list", got.Bands)
	}
}
