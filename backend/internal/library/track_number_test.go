package library

import (
	"context"
	"fmt"
	"testing"
)

// add inserts a song into the given artist+album and returns its id. Each call
// gets a unique content hash / path so the content-hash unique index never trips.
func add(t *testing.T, r *Repo, artist, album string) string {
	t.Helper()
	n := fmt.Sprintf("%p-%d", t, len(album)+testSeq())
	p := CreateSongParams{
		Title:       "T" + n,
		ArtistName:  artist,
		Album:       album,
		Year:        2020,
		FilePath:    "songs/" + n + ".mp3",
		FileSize:    1,
		ContentHash: "hash-" + n,
	}
	id := NewID()
	if _, err := r.Create(context.Background(), id, p); err != nil {
		t.Fatalf("Create: %v", err)
	}
	return id
}

var seq int

func testSeq() int { seq++; return seq }

// numbering asserts a song's "N of Y" fields.
func numbering(t *testing.T, r *Repo, id string, no, total int) {
	t.Helper()
	s, err := r.Get(context.Background(), id)
	if err != nil || s == nil {
		t.Fatalf("Get %s: %v", id, err)
	}
	if s.TrackNo != no || s.TrackTotal != total {
		t.Fatalf("song %s = %d of %d, want %d of %d", id, s.TrackNo, s.TrackTotal, no, total)
	}
}

func TestCreate_numbersAlbumGroupByAddOrder(t *testing.T) {
	r := newRepo(t)

	a := add(t, r, "Artist", "Album")
	numbering(t, r, a, 1, 1)

	b := add(t, r, "Artist", "Album")
	numbering(t, r, a, 1, 2)
	numbering(t, r, b, 2, 2)

	c := add(t, r, "Artist", "Album")
	numbering(t, r, a, 1, 3)
	numbering(t, r, b, 2, 3)
	numbering(t, r, c, 3, 3) // newest is always last
}

func TestCreate_groupsAreArtistPlusAlbum(t *testing.T) {
	r := newRepo(t)

	a := add(t, r, "Artist One", "Shared Title")
	b := add(t, r, "Artist Two", "Shared Title") // same album title, other artist
	// Two independent groups of one, not a merged group of two.
	numbering(t, r, a, 1, 1)
	numbering(t, r, b, 1, 1)
}

func TestCreate_singleIsNeverNumbered(t *testing.T) {
	r := newRepo(t)

	a := add(t, r, "Artist", "") // empty album → single
	numbering(t, r, a, 0, 0)
	// A second single stays unnumbered too — singles are not a group.
	b := add(t, r, "Artist", "")
	numbering(t, r, a, 0, 0)
	numbering(t, r, b, 0, 0)
}

func TestDeleteSong_renumbersSurvivors(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()

	a := add(t, r, "Artist", "Album")
	b := add(t, r, "Artist", "Album")
	c := add(t, r, "Artist", "Album")

	if _, _, err := r.DeleteSong(ctx, b); err != nil {
		t.Fatalf("DeleteSong: %v", err)
	}
	// Group shrinks 3→2; survivors re-sequence and totals drop.
	numbering(t, r, a, 1, 2)
	numbering(t, r, c, 2, 2)
}

func TestUpdate_movingSongRenumbersBothGroups(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()

	a := add(t, r, "Artist", "Album A")
	b := add(t, r, "Artist", "Album A")
	c := add(t, r, "Artist", "Album B")

	// Move b from Album A into Album B.
	s, err := r.Get(ctx, b)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if _, err := r.Update(ctx, b, UpdateSongParams{
		Title: s.Title, ArtistName: s.ArtistName, Album: "Album B", Year: s.Year,
	}); err != nil {
		t.Fatalf("Update: %v", err)
	}

	// Old group A shrinks to just a.
	numbering(t, r, a, 1, 1)
	// New group B holds b and c, ordered by rowid (creation order): b was created
	// before c, so a moved song slots in by its original upload time, not move time.
	numbering(t, r, b, 1, 2)
	numbering(t, r, c, 2, 2)
}

func TestUpdate_movingSongToSingleClearsNumbering(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()

	a := add(t, r, "Artist", "Album")
	b := add(t, r, "Artist", "Album")
	numbering(t, r, b, 2, 2)

	// Clear b's album: it becomes a single and must lose its stale "2 of 2".
	s, err := r.Get(ctx, b)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if _, err := r.Update(ctx, b, UpdateSongParams{
		Title: s.Title, ArtistName: s.ArtistName, Album: "", Year: s.Year, TrackNo: s.TrackNo,
	}); err != nil {
		t.Fatalf("Update: %v", err)
	}

	numbering(t, r, b, 0, 0) // now an unnumbered single
	numbering(t, r, a, 1, 1) // the album it left collapses to 1 of 1
}

// TestTopTen_scansTrackTotal guards the songColumns/scanSongInto ordinal contract:
// the play-count read path appends a trailing column, so a mis-positioned
// track_total would surface here as a wrong "N of Y" on a charted song.
func TestTopTen_scansTrackTotal(t *testing.T) {
	r := newRepo(t)
	ctx := context.Background()

	a := add(t, r, "Artist", "Album")
	_ = add(t, r, "Artist", "Album")
	if _, err := r.SetPublished(ctx, a, true); err != nil {
		t.Fatalf("SetPublished: %v", err)
	}
	if err := r.RecordPlay(ctx, a); err != nil {
		t.Fatalf("RecordPlay: %v", err)
	}

	top, err := r.TopTen(ctx, true)
	if err != nil {
		t.Fatalf("TopTen: %v", err)
	}
	if len(top) != 1 {
		t.Fatalf("TopTen len = %d, want 1", len(top))
	}
	if top[0].TrackNo != 1 || top[0].TrackTotal != 2 {
		t.Fatalf("charted song = %d of %d, want 1 of 2", top[0].TrackNo, top[0].TrackTotal)
	}
}
